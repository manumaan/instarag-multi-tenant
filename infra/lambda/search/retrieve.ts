import { openSearchClient, INDEX_NAME } from './client';
import { embed } from './embed';

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

/** The two rankings one query produces: nearest-neighbour and lexical. */
async function rankingsFor(query: string, filter: unknown[], size: number): Promise<Hit[][]> {
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
          ...(filter.length ? { filter } : {}),
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
          ...(filter.length ? { filter } : {}),
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

/** kNN and BM25 in parallel, then fused. `mediaId` scopes to one reel. */
export async function retrieve(question: string, options: { mediaId?: string; limit?: number }): Promise<Hit[]> {
  const limit = options.limit ?? 12;
  const filter = options.mediaId ? [{ term: { media_id: options.mediaId } }] : [];
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
  options: { mediaId?: string; perQuery?: number; limit?: number },
): Promise<Hit[]> {
  if (queries.length === 0) return [];
  const perQuery = options.perQuery ?? 25;
  const limit = options.limit ?? 60;
  const filter = options.mediaId ? [{ term: { media_id: options.mediaId } }] : [];

  const perQueryRankings = await Promise.all(queries.map((query) => rankingsFor(query, filter, perQuery)));
  return fuseRankings(perQueryRankings.flat(), hitKey).slice(0, limit);
}
