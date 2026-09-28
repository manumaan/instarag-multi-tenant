import { openSearchClient, INDEX_NAME } from './client';
import { embed } from './embed';
import { savedMediaIds } from '../shared/saves';

export interface Hit {
  mediaId: string;
  tsMs: number;
  kind: 'frame' | 'speech';
  description: string;
  ocrText: string;
  speech: string;
  caption: string;
  places: string;
}

/**
 * Reciprocal rank fusion.
 *
 * Hybrid rather than pure vector search because the questions this app must
 * answer are often about exact strings — a cafe name on an awning, a street
 * sign — where BM25 on ocr_text beats nearest-neighbour, while paraphrased
 * questions need the vector side. RRF merges the two rankings without having
 * to calibrate two incomparable score scales.
 */
export function fuseRankings<T>(rankings: T[][], keyOf: (item: T) => string, k = 60): T[] {
  const scores = new Map<string, { score: number; item: T }>();
  for (const ranking of rankings) {
    ranking.forEach((item, position) => {
      const key = keyOf(item);
      const existing = scores.get(key);
      const contribution = 1 / (k + position + 1);
      if (existing) existing.score += contribution;
      else scores.set(key, { score: contribution, item });
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).map((entry) => entry.item);
}

const toHit = (source: Record<string, unknown>): Hit => ({
  mediaId: String(source.media_id),
  tsMs: Number(source.ts_ms),
  kind: source.kind === 'speech' ? 'speech' : 'frame',
  description: String(source.description ?? ''),
  ocrText: String(source.ocr_text ?? ''),
  speech: String(source.speech ?? ''),
  caption: String(source.caption ?? ''),
  places: String(source.places ?? ''),
});

/** Kind is part of the key: a frame and a spoken line can share a timestamp. */
export const hitKey = (hit: Hit) => `${hit.mediaId}:${hit.kind}:${hit.tsMs}`;

const hitsOf = (response: { body: { hits: { hits: Array<{ _source?: unknown }> } } }) =>
  response.body.hits.hits.map((hit) => toHit((hit._source ?? {}) as Record<string, unknown>));

/**
 * What this caller is allowed to match against.
 *
 * The index holds one document per moment of *global* content — a reel saved by
 * three people has one set of documents, not three — so nothing in a document
 * says who may read it. This is the boundary: a query is narrowed to the media
 * the caller has saved, and a caller with no saves matches nothing.
 *
 * `mediaId` scopes further, to one reel, and is checked against the same list:
 * naming a reel you have not saved gets you an empty result, not someone else's
 * library.
 *
 * The user id comes from the JWT by way of the handler. Nothing here accepts a
 * media list from a caller — that would be the whole boundary, handed over.
 */
export type ScopeFilter = Array<Record<string, unknown>>;

export async function scopeFilter(userId: string, mediaId?: string): Promise<ScopeFilter | undefined> {
  const saved = await savedMediaIds(userId);
  if (saved.length === 0) return undefined;

  if (mediaId) {
    return saved.includes(mediaId) ? [{ term: { media_id: mediaId } }] : undefined;
  }
  return [{ terms: { media_id: saved } }];
}

/** The two rankings one query produces: nearest-neighbour and lexical. */
async function rankingsFor(query: string, filter: ScopeFilter, size: number): Promise<Hit[][]> {
  const client = openSearchClient();
  const vector = await embed({ text: query });

  // Before anything has been indexed the index does not exist yet; that is an
  // empty result, not an error.
  const search = async (body: Record<string, unknown>) => {
    try {
      return await client.search({ index: INDEX_NAME, body: body as never });
    } catch (err) {
      const type = (err as { meta?: { body?: { error?: { type?: string } } } }).meta?.body?.error?.type;
      if (type === 'index_not_found_exception') return { body: { hits: { hits: [] } } };
      throw err;
    }
  };

  const [knn, lexical] = await Promise.all([
    search({
      size,
      query: {
        bool: {
          must: [{ knn: { embedding: { vector, k: size } } }],
          filter,
        },
      },
      _source: { excludes: ['embedding'] },
    }),
    search({
      size,
      query: {
        bool: {
          must: [
            {
              multi_match: {
                query,
                // ocr_text carries signage and street names, so it leads.
                // ocr_text and speech both carry exact wording worth matching.
                fields: ['ocr_text^3', 'speech^3', 'places^2', 'description', 'caption'],
              },
            },
          ],
          filter,
        },
      },
      _source: { excludes: ['embedding'] },
    }),
  ]);

  return [hitsOf(knn as never), hitsOf(lexical as never)];
}

/**
 * Wakes the collection without asking it anything.
 *
 * A NEXTGEN collection scales to zero after ten idle minutes, and the first
 * search afterwards waits for OCUs to come up: measured at 41s against 6s warm,
 * which is past the 30-second ceiling API Gateway puts on an integration. Fired
 * when someone focuses the question box, that wait is spent while they type
 * rather than after they press the button.
 */
export async function warmIndex(): Promise<{ warmed: boolean; ms: number }> {
  const started = Date.now();
  try {
    // size 0 and match_all: the cheapest thing that still makes the service
    // bring search capacity up. Nothing is read, so nothing needs embedding.
    await openSearchClient().search({
      index: INDEX_NAME,
      body: { size: 0, query: { match_all: {} } } as never,
    });
    return { warmed: true, ms: Date.now() - started };
  } catch (err) {
    // Best effort by definition — the question that follows will report a real
    // failure. An index that does not exist yet is not one.
    console.warn('index warm-up failed', err);
    return { warmed: false, ms: Date.now() - started };
  }
}

/** kNN and BM25 in parallel, then fused, over what the caller has saved. */
export async function retrieve(
  question: string,
  options: { userId: string; mediaId?: string; limit?: number },
): Promise<Hit[]> {
  const limit = options.limit ?? 12;
  const filter = await scopeFilter(options.userId, options.mediaId);
  // Nothing saved, or a reel this caller does not hold: nothing to match.
  if (!filter) return [];
  const rankings = await rankingsFor(question, filter, limit);
  return fuseRankings(rankings, hitKey).slice(0, limit);
}

/**
 * Retrieval for a request that has to be answered from the whole library rather
 * than from one moment.
 *
 * "Create a travel plan for Istanbul with all the tips" is not one question, and
 * a single query cannot find its evidence: the transit card, the markets, the
 * viewpoint and the prices sit in different clips and answer to different words.
 * So several queries run, and all their rankings are fused together — a moment
 * that several facets surface rises, which is what "all the tips" needs.
 */
export async function retrieveMany(
  queries: string[],
  options: { userId: string; mediaId?: string; perQuery?: number; limit?: number },
): Promise<Hit[]> {
  if (queries.length === 0) return [];
  const perQuery = options.perQuery ?? 25;
  const limit = options.limit ?? 60;
  const filter = await scopeFilter(options.userId, options.mediaId);
  if (!filter) return [];

  const perQueryRankings = await Promise.all(queries.map((query) => rankingsFor(query, filter, perQuery)));
  return fuseRankings(perQueryRankings.flat(), hitKey).slice(0, limit);
}
