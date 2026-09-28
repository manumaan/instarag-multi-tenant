import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { retrieveMany, type Hit } from './retrieve';
import { claude } from '../shared/claude';
import { recordUsage } from '../shared/usage';

const SYNTHESIS_MODEL_ID = process.env.ANSWER_MODEL_ID!;
/** Haiku's job here is the cheap pass: turning one request into several queries. */
const EXPANSION_MODEL_ID = process.env.EXPANSION_MODEL_ID!;

/** How many moments the synthesis call carries. See the note on timing below. */
export const PLAN_MOMENTS = Number(process.env.PLAN_MOMENTS ?? 60);
const PER_QUERY = Number(process.env.PLAN_PER_QUERY ?? 25);
const MAX_QUERIES = 6;
/**
 * A plan is long. At 4096 the model ran out mid-sentence and the structured
 * output came back as unterminated JSON — the failure looks like a parse bug
 * and is really a budget one. Generation is the slow part (roughly a minute per
 * 4k tokens here), which is the other reason this cannot run inside a request.
 */
const PLAN_MAX_TOKENS = Number(process.env.PLAN_MAX_TOKENS ?? 12000);

const CitationSchema = z.object({
  media_id: z.string(),
  ts_ms: z.number(),
});

const ExpansionSchema = z.object({
  topic: z
    .string()
    .describe('the subject to search the library for — usually a place, dish or theme, in a few words'),
  queries: z
    .array(z.string())
    .describe('three to five short search queries, each covering a different facet of the request'),
});

const PlanSchema = z.object({
  title: z.string().describe('a short title for what was produced'),
  overview: z
    .string()
    .describe('two or three sentences on what the saved clips actually cover for this request'),
  sections: z.array(
    z.object({
      heading: z.string(),
      items: z.array(
        z.object({
          text: z.string().describe('one concrete piece of advice, in a sentence or two'),
          citations: z.array(CitationSchema).describe('the moments this rests on; never empty'),
        }),
      ),
    }),
  ),
  gaps: z
    .array(z.string())
    .describe('parts of the request the clips do not cover, said plainly; empty when there are none'),
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlanSection = Plan['sections'][number];

/**
 * The queries the library is actually searched with.
 *
 * The raw request always goes in — an expansion that drifts off the subject
 * should not be able to lose the original — and the topic on its own goes in
 * next, because "istanbul" matches clips that never phrase things the way the
 * request did. Deduplicated case-insensitively and capped, since every query
 * costs an embedding call and two searches.
 */
export function planQueries(request: string, expansion?: { topic?: string; queries?: string[] }): string[] {
  const candidates = [request, expansion?.topic ?? '', ...(expansion?.queries ?? [])];
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(trimmed);
    if (queries.length === MAX_QUERIES) break;
  }
  return queries;
}

/** One request becomes several searches. A failure here costs breadth, not the answer. */
export async function expandRequest(request: string): Promise<string[]> {
  try {
    const response = await (await claude()).messages.parse({
      model: EXPANSION_MODEL_ID,
      max_tokens: 512,
      output_config: { format: zodOutputFormat(ExpansionSchema) },
      system: [
        'You turn a request into search queries against a personal library of saved Instagram clips.',
        'The queries are matched against what is visible in a frame, text read off it, and what was said aloud.',
        'Cover different facets of the request — for a trip that might be transport, food, sights, costs, practical',
        'warnings. Keep each query to a few words. Do not invent specifics the request did not mention.',
      ].join('\n'),
      messages: [{ role: 'user', content: request }],
    });
    recordUsage('expand', EXPANSION_MODEL_ID, response.usage);
    return planQueries(request, response.parsed_output ?? undefined);
  } catch (err) {
    console.warn('query expansion failed; falling back to the request itself', err);
    return planQueries(request);
  }
}

export const momentKey = (mediaId: string, tsMs: number) => `${mediaId}:${tsMs}`;

export interface GroundedPlan {
  sections: PlanSection[];
  itemsKept: number;
  itemsDropped: number;
}

/**
 * Keeps only what the retrieved moments support.
 *
 * This is the part that matters. The model knows Istanbul perfectly well without
 * any clips, and a plausible itinerary assembled from that knowledge is exactly
 * the failure this app exists to avoid — it would read like the others and be
 * grounded in nothing. So a citation that names a moment we did not retrieve is
 * dropped, an item left with no citation goes with it, and a section emptied
 * that way disappears too.
 */
export function groundPlan(plan: Plan, retrieved: Set<string>): GroundedPlan {
  let itemsKept = 0;
  let itemsDropped = 0;

  const sections = plan.sections
    .map((section) => {
      const items = section.items.flatMap((item) => {
        const citations = item.citations.filter((c) => retrieved.has(momentKey(c.media_id, c.ts_ms)));
        if (citations.length === 0) {
          itemsDropped += 1;
          return [];
        }
        itemsKept += 1;
        return [{ ...item, citations }];
      });
      return { ...section, items };
    })
    .filter((section) => section.items.length > 0);

  return { sections, itemsKept, itemsDropped };
}

function formatMoments(hits: Hit[]): string {
  return hits
    .map((hit) =>
      [
        `--- ${hit.kind} media_id=${hit.mediaId} ts_ms=${hit.tsMs}`,
        hit.speech && `said aloud: ${hit.speech}`,
        hit.description && `visible: ${hit.description}`,
        hit.ocrText && `text in frame (verbatim): ${hit.ocrText}`,
        hit.places && `places named in this clip: ${hit.places}`,
        hit.caption && `clip caption: ${hit.caption}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

export interface PlanResult {
  answered: boolean;
  title: string;
  overview: string;
  sections: PlanSection[];
  gaps: string[];
  queries: string[];
  retrieved: Array<{ media_id: string; ts_ms: number }>;
  itemsDropped: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Builds something out of the whole library rather than answering from one
 * moment: "create a travel plan for Istanbul with all the tips".
 *
 * Effort stays low and the moment count is capped because this has to return
 * inside API Gateway's 30-second integration timeout, which cannot be raised on
 * an HTTP API. The Lambda would happily run for 60.
 */
export async function buildPlan(
  request: string,
  options: { userId: string; mediaId?: string },
): Promise<PlanResult> {
  // Stage timings, because this runs against a 30-second ceiling and a total
  // tells you nothing about which stage spent it.
  const started = Date.now();
  const since = () => Date.now() - started;

  const queries = await expandRequest(request);
  const expandedAt = since();

  const hits = await retrieveMany(queries, {
    userId: options.userId,
    mediaId: options.mediaId,
    perQuery: PER_QUERY,
    limit: PLAN_MOMENTS,
  });
  const retrievedAt = since();
  console.log('plan retrieval', { queries: queries.length, moments: hits.length, expandedAt, retrievedAt });

  const retrieved = hits.map((hit) => ({ media_id: hit.mediaId, ts_ms: hit.tsMs }));

  if (hits.length === 0) {
    return {
      answered: false,
      title: request,
      overview: options.mediaId
        ? 'Nothing has been indexed for this clip yet, so there is nothing to build from.'
        : 'Your library has nothing indexed yet, so there is nothing to build from.',
      sections: [],
      gaps: [],
      queries,
      retrieved,
      itemsDropped: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  const response = await (await claude()).messages.parse({
    model: SYNTHESIS_MODEL_ID,
    max_tokens: PLAN_MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: zodOutputFormat(PlanSchema) },
    system: [
      "You assemble practical guides out of moments taken from someone's own saved Instagram clips.",
      'Each moment carries its media_id and ts_ms. A frame moment says what is visible and any text read off it',
      'verbatim; a speech moment is what was said aloud at that point.',
      '',
      'Rules:',
      '- Use only the moments provided. You may know a great deal about this subject already; none of that belongs',
      '  here. If the moments do not mention it, it does not go in.',
      '- Every item cites the moments it came from. An item you cannot cite is one you should not write.',
      '- Use the clips\' own wording for names of places, dishes, cards and neighbourhoods, and repeat prices,',
      '  times and numbers exactly as they appear. Do not convert or update them.',
      '- Group into sections that suit what was asked, and keep each item to one concrete piece of advice in a',
      '  sentence or two. Cover everything the moments support; do not pad it out.',
      '- Whatever the request asked for and the clips do not cover goes in gaps, plainly. A stated gap is more',
      '  useful than a filled-in guess.',
    ].join('\n'),
    messages: [{ role: 'user', content: `${formatMoments(hits)}\n\nRequest: ${request}` }],
  });

  console.log('plan synthesis', { synthesisMs: since() - retrievedAt, totalMs: since() });

  recordUsage('plan', SYNTHESIS_MODEL_ID, response.usage);

  const parsed = response.parsed_output;
  if (!parsed) {
    const reason =
      response.stop_reason === 'max_tokens'
        ? `the plan ran past its ${PLAN_MAX_TOKENS}-token budget`
        : `stop_reason ${response.stop_reason}`;
    throw new Error(`model returned no parsable plan: ${reason}`);
  }

  const grounded = groundPlan(parsed, new Set(retrieved.map((m) => momentKey(m.media_id, m.ts_ms))));

  return {
    answered: grounded.itemsKept > 0,
    title: parsed.title,
    overview: parsed.overview,
    sections: grounded.sections,
    gaps: parsed.gaps,
    queries,
    retrieved,
    itemsDropped: grounded.itemsDropped,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
