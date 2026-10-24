import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { clientFor } from '../shared/claude';
import { ddb, TABLES } from '../shared/ddb';
import type { MediaRecord } from '../shared/media';
import { recordUsage } from '../shared/usage';
import { searchWeb, type WebResult } from './brave';

const MODEL_ID = process.env.ANSWER_MODEL_ID!;
const EFFORT = (process.env.ANSWER_EFFORT ?? 'low') as 'low' | 'medium' | 'high';
const TRANSCRIPT_SEGMENTS_TABLE = process.env.TRANSCRIPT_SEGMENTS_TABLE!;

/** Claims searched per check. Each is one Brave call, made one at a time. */
export const MAX_CHECKED = 6;
/** Brave's free tier allows one request a second. */
const SEARCH_GAP_MS = 1100;
const RESULTS_PER_CLAIM = 6;
/**
 * At high effort the reasoning comes out of the same budget, and 6000 ran out
 * on a busy reel: the JSON stopped mid-string and parsing failed.
 */
const MAX_TOKENS = 16000;

export type ClaimKind = 'factual' | 'opinion' | 'promotional';
/**
 * web: about the world, so a source can settle it. reel: about the creator's own
 * results or experience ("I made $6k tonight"), which only the reel can speak to.
 */
export type CheckBasis = 'web' | 'reel';
export type Verdict = 'supported' | 'partly_supported' | 'disputed' | 'unverifiable' | 'not_checked';
export type ReelAssessment = 'backed' | 'inconsistent' | 'not_shown';
export type Label = 'mostly_true' | 'mixed' | 'mostly_hype' | 'cant_verify';

export interface CheckedClaim {
  text: string;
  /** The moment it was made at, when it can be pinned to one. */
  ts_ms?: number;
  kind: ClaimKind;
  basis: CheckBasis;
  /** The web verdict; `not_checked` for a reel-basis claim. */
  verdict: Verdict;
  explanation: string;
  /** What the reel's own frames and speech show for or against it. */
  reel_assessment?: ReelAssessment;
  reel_note?: string;
  query?: string;
  sources: Array<{ title: string; url: string }>;
}

export interface HypeSignal {
  signal: string;
  quote: string;
  ts_ms?: number;
}

/** Something the reel itself shows that undercuts it: the sandbox URL, the numbers that disagree. */
export interface RedFlag {
  kind: string;
  finding: string;
  ts_ms: number[];
}

export interface Plausible {
  point: string;
  sources: Array<{ title: string; url: string }>;
}

export interface ClaimReport {
  /** 0-100, or null when there is too little to judge. */
  score: number | null;
  label: Label;
  /** What the score is made of, so it never has to be taken on trust. */
  evidence_score: number | null;
  /** Where the score starts: the evidence score, or a neutral 50 when nothing was web-checkable. */
  base_score: number;
  red_flag_penalty: number;
  hype_penalty: number;
  judged: number;
  summary: string;
  topic: string;
  claims: CheckedClaim[];
  red_flags: RedFlag[];
  hype_signals: HypeSignal[];
  plausible: Plausible[];
  model: string;
}

/** Stored on the media record: content is global, so one check serves every saver. */
export interface ClaimCheck {
  status: 'working' | 'ready' | 'failed';
  started_at: string;
  finished_at?: string;
  error?: string;
  /** The last finished report, kept while a re-check runs. */
  report?: ClaimReport;
}

/** A check still marked working after this long is taken to have died. */
export const STALE_MS = 6 * 60 * 1000;

const ScrutinySchema = z.object({
  topic: z.string().describe('what the reel is about, in a few words'),
  claims: z
    .array(
      z.object({
        text: z.string().describe('the claim, restated plainly and self-contained, with its figures'),
        ts_ms: z.number().nullable().describe('ts_ms of the moment it was made, from the moments given, or null'),
        kind: z.enum(['factual', 'opinion', 'promotional']),
        basis: z.enum(['web', 'reel']),
        search_query: z
          .string()
          .describe('for basis web only: a query a fact-checker would run. Never the creator\'s name or handle; empty otherwise'),
        reel_assessment: z.enum(['backed', 'inconsistent', 'not_shown']).nullable(),
        reel_note: z.string().describe('what the frames and speech show for or against it, with figures; empty if nothing'),
      }),
    )
    .describe('the claims a viewer would act on, most consequential first, at most 8'),
  red_flags: z
    .array(
      z.object({
        kind: z.enum([
          'inconsistent_numbers',
          'revenue_not_profit',
          'missing_proof',
          'suspicious_detail',
          'withheld_method',
          'misleading_framing',
        ]),
        finding: z.string().describe('specific: quote the figures, text or detail and say why it matters'),
        ts_ms: z.array(z.number()).describe('the moments it rests on'),
      }),
    )
    .describe('what the reel itself shows that undercuts its claims; empty when nothing does'),
  hype_signals: z
    .array(
      z.object({
        signal: z.enum([
          'absolute_language',
          'urgency_or_scarcity',
          'miracle_promise',
          'unsupported_statistic',
          'undisclosed_promotion',
          'emotional_pressure',
          'other',
        ]),
        quote: z.string().describe('the words, verbatim from the moments'),
        ts_ms: z.number().nullable(),
      }),
    )
    .describe('rhetorical signs of hype, each quoted from the reel; empty when there are none'),
  reel_summary: z.string().describe('two or three sentences on whether the reel backs up what it says'),
});

const JudgeSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().describe('the claim number given'),
      verdict: z.enum(['supported', 'partly_supported', 'disputed', 'unverifiable']),
      explanation: z.string().describe('one or two sentences on what the results say'),
      cited_urls: z.array(z.string()).describe('only urls from that claim\'s results'),
    }),
  ),
  plausible: z
    .array(z.object({ point: z.string(), cited_urls: z.array(z.string()) }))
    .describe('what in the reel is real or believable according to the results, each with its sources'),
  summary: z
    .string()
    .describe('three or four sentences a viewer can act on: what holds up, what does not, and what the reel never shows'),
});

interface Moment {
  ts_ms: number;
  line: string;
}

/** Everything the reel says, as citable moments: frames and speech in time order. */
export async function loadMoments(media: MediaRecord): Promise<Moment[]> {
  const [frames, segments] = await Promise.all([
    ddb.send(
      new QueryCommand({
        TableName: TABLES.frames,
        KeyConditionExpression: 'media_id = :id',
        ExpressionAttributeValues: { ':id': media.id },
      }),
    ),
    ddb.send(
      new QueryCommand({
        TableName: TRANSCRIPT_SEGMENTS_TABLE,
        KeyConditionExpression: 'media_id = :id',
        ExpressionAttributeValues: { ':id': media.id },
      }),
    ),
  ]);
  const moments: Moment[] = [];
  for (const f of frames.Items ?? []) {
    const text = [f.description, f.ocr_text ? `on-screen text: "${f.ocr_text}"` : ''].filter(Boolean).join(' | ');
    if (text) moments.push({ ts_ms: f.ts_ms as number, line: `frame ts_ms=${f.ts_ms}: ${text}` });
  }
  for (const s of segments.Items ?? []) {
    moments.push({ ts_ms: s.start_ms as number, line: `speech ts_ms=${s.start_ms}: "${s.text}"` });
  }
  return moments.sort((a, b) => a.ts_ms - b.ts_ms);
}

/** A timestamp the model names must be one of the moments it was shown. */
export function reconcileTs(ts: number | null | undefined, valid: Set<number>): number | undefined {
  return ts !== null && ts !== undefined && valid.has(ts) ? ts : undefined;
}

/** Keeps only urls the search returned, with their titles. */
export function citedSources(citedUrls: string[], results: WebResult[]): Array<{ title: string; url: string }> {
  const byUrl = new Map(results.map((r) => [r.url, r]));
  return [...new Set(citedUrls)].filter((u) => byUrl.has(u)).map((u) => ({ title: byUrl.get(u)!.title, url: u }));
}

/**
 * A verdict that names no source the search returned is not a verdict.
 * Same discipline as places[].basis: what cannot be shown is downgraded.
 */
export function groundVerdict(
  verdict: Exclude<Verdict, 'not_checked'>,
  citedUrls: string[],
  results: WebResult[],
): { verdict: Verdict; sources: Array<{ title: string; url: string }> } {
  const sources = citedSources(citedUrls, results);
  if (verdict !== 'unverifiable' && sources.length === 0) return { verdict: 'unverifiable', sources };
  return { verdict, sources };
}

const WEIGHT: Partial<Record<Verdict, number>> = { supported: 1, partly_supported: 0.5, disputed: 0 };
/** Five points per distinct kind of hype: it colours a score, it does not make one. */
const PENALTY_PER_SIGNAL = 5;
const MAX_HYPE_PENALTY = 20;
/** A red flag is something the reel shows against itself, so it weighs more than rhetoric. */
const PENALTY_PER_RED_FLAG = 8;
const MAX_RED_FLAG_PENALTY = 40;
/** Where a reel with nothing web-checkable starts: no evidence either way. */
const NEUTRAL = 50;

/**
 * Computed here, not by the model, so the same findings always give the same
 * score and every point of it traces to a claim, a red flag or a quoted phrase.
 *
 * With web evidence, the score is that evidence less the deductions. Without
 * it, it starts at a neutral 50: a reel can still earn "mostly hype" from what
 * it shows against itself, but it cannot earn "mostly true" from nothing.
 */
export function scoreReport(claims: CheckedClaim[], signals: HypeSignal[], redFlags: RedFlag[]) {
  const judged = claims.filter((c) => c.basis === 'web' && c.kind === 'factual' && WEIGHT[c.verdict] !== undefined);
  const hype_penalty = Math.min(MAX_HYPE_PENALTY, new Set(signals.map((s) => s.signal)).size * PENALTY_PER_SIGNAL);
  const red_flag_penalty = Math.min(MAX_RED_FLAG_PENALTY, redFlags.length * PENALTY_PER_RED_FLAG);
  const penalties = { hype_penalty, red_flag_penalty, judged: judged.length };

  if (judged.length === 0) {
    const score = Math.max(0, NEUTRAL - hype_penalty - red_flag_penalty);
    return score < 45
      ? { ...penalties, score, evidence_score: null, base_score: NEUTRAL, label: 'mostly_hype' as Label }
      : { ...penalties, score: null, evidence_score: null, base_score: NEUTRAL, label: 'cant_verify' as Label };
  }
  const evidence_score = Math.round((100 * judged.reduce((sum, c) => sum + WEIGHT[c.verdict]!, 0)) / judged.length);
  const score = Math.max(0, evidence_score - hype_penalty - red_flag_penalty);
  const label: Label = score >= 75 ? 'mostly_true' : score >= 45 ? 'mixed' : 'mostly_hype';
  return { ...penalties, score, evidence_score, base_score: evidence_score, label };
}

/**
 * A reply cut off at max_tokens fails as a JSON parse error, which reads like a
 * model bug rather than a budget. Name it, so the stored error says what to change.
 */
async function parseOrExplain<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof Error && /parse structured output/i.test(err.message)) {
      throw new Error(`the model's reply was cut off before it finished (max_tokens ${MAX_TOKENS}); try Re-check`);
    }
    throw err;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Hype or true, from two directions. The reel is read against itself — do its
 * numbers agree, does it show the proof it implies, what does the screen give
 * away — and its claims about the world are searched on the web and judged only
 * from what came back, so a verdict is what sources say rather than what the
 * model recalls.
 */
export async function checkClaims(media: MediaRecord, apiKey: string, userId: string): Promise<ClaimReport> {
  const moments = await loadMoments(media);
  const valid = new Set(moments.map((m) => m.ts_ms));
  const context = [
    media.uploader ? `Creator: ${media.uploader}` : '',
    media.caption_raw ? `Caption: ${media.caption_raw}` : '',
    media.analysis_summary ? `Summary: ${media.analysis_summary}` : '',
    'Moments:',
    ...moments.map((m) => m.line),
  ]
    .filter(Boolean)
    .join('\n');

  const client = await clientFor(MODEL_ID);
  const scrutiny = await parseOrExplain(() => client.messages.parse({
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT, format: zodOutputFormat(ScrutinySchema) },
    system: [
      'You are a sceptical analyst checking whether an Instagram reel is hype or true. You get its',
      'caption and its moments: what each frame shows, with on-screen text read verbatim, and what',
      'was said aloud.',
      '',
      'Claims. List what a viewer would act on.',
      '- basis web: claims about the world that a source could settle — health, money, prices,',
      '  opening hours, product effects, history, how a tool or platform works.',
      '- basis reel: the creator\'s own results or experience ("I made $6k tonight"). No source can',
      '  settle these; judge them against the reel: backed, inconsistent, or not_shown.',
      '- A description of what the video shows is not a claim. Use it as evidence instead.',
      '',
      'Red flags. Read the frames as evidence against the reel\'s own story, and be specific:',
      'figures that disagree between shots, revenue presented as profit or a cost presented as',
      'income, no proof where proof is implied (no storefront, payout or bank screen), details that',
      'give it away (a local file or sandbox URL in an address bar, a mock-up, a different screen),',
      'a method promised and never shown. Quote the figures and text. Only what the moments show.',
      'The frames are a sample of the video, not all of it: something missing from them is not',
      'evidence it is missing from the reel. Never flag a count or a place the sample merely fails',
      'to cover, and never flag a creator describing their own video ("16 countries in one video").',
      'A red flag is something the reel shows, or a proof the claim depends on and the reel never',
      'offers — a money claim with no money screen, a method promised and not given.',
      '',
      'Hype signals: quote the words verbatim. A plain description of the video is not hype.',
      '',
      'Speech is machine transcription and mishears words, numbers and slang most of all ("6 grad"',
      'is "6 grand"). Where speech and on-screen text disagree, the text is right. Read speech for',
      'what was plausibly said, and quote it corrected.',
    ].join('\n'),
    messages: [{ role: 'user', content: context }],
  }));
  recordUsage('claims-extract', MODEL_ID, scrutiny.usage, userId);
  const read = scrutiny.parsed_output;
  if (!read) throw new Error(`model returned no parsable claims (stop_reason ${scrutiny.stop_reason})`);

  const claims: CheckedClaim[] = read.claims.slice(0, 8).map((c) => {
    const web = c.basis === 'web' && c.kind === 'factual' && c.search_query.trim() !== '';
    return {
      text: c.text,
      ts_ms: reconcileTs(c.ts_ms, valid),
      kind: c.kind,
      basis: web ? 'web' : 'reel',
      verdict: 'not_checked',
      explanation:
        c.kind !== 'factual'
          ? `${c.kind === 'opinion' ? 'An opinion' : 'A sales pitch'}, not something a source can confirm.`
          : web
            ? 'Not searched: over the per-reel limit.'
            : 'About the creator\'s own results, so only the reel can speak to it.',
      reel_assessment: c.reel_assessment ?? undefined,
      reel_note: c.reel_note.trim() || undefined,
      query: web ? c.search_query.trim() : undefined,
      sources: [],
    };
  });
  const red_flags: RedFlag[] = read.red_flags.map((f) => ({
    kind: f.kind,
    finding: f.finding,
    ts_ms: f.ts_ms.filter((t) => valid.has(t)),
  }));
  const hype_signals: HypeSignal[] = read.hype_signals.map((s) => ({
    signal: s.signal,
    quote: s.quote,
    ts_ms: reconcileTs(s.ts_ms, valid),
  }));

  // One at a time: Brave's free tier refuses a second request inside a second.
  const toCheck = claims.filter((c) => c.query).slice(0, MAX_CHECKED);
  const results = new Map<CheckedClaim, WebResult[]>();
  for (const [i, claim] of toCheck.entries()) {
    if (i > 0) await sleep(SEARCH_GAP_MS);
    results.set(claim, await searchWeb(claim.query!, apiKey, RESULTS_PER_CLAIM).catch(() => []));
  }

  let summary = read.reel_summary;
  let plausible: Plausible[] = [];
  if (toCheck.length > 0) {
    const brief = toCheck
      .map((claim, i) => {
        const found = results.get(claim)!;
        const listed = found.length
          ? found.map((r) => `   - ${r.title}\n     ${r.url}\n     ${r.description}`).join('\n')
          : '   (no results)';
        return `Claim ${i}: ${claim.text}\n  Search: ${claim.query}\n  Results:\n${listed}`;
      })
      .join('\n\n');
    const fromReel = [
      `What the reel shows against itself:`,
      ...(red_flags.length ? red_flags.map((f) => `- ${f.finding}`) : ['- nothing notable']),
      `Reading of the reel alone: ${read.reel_summary}`,
    ].join('\n');

    const judgement = await parseOrExplain(() => client.messages.parse({
      model: MODEL_ID,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORT, format: zodOutputFormat(JudgeSchema) },
      system: [
        'You judge claims from an Instagram reel against web search results.',
        'Judge each claim only from its own results. Do not use what you happen to know: a claim',
        'the results do not address is unverifiable, even if you believe it is true or false.',
        'supported: results confirm it. partly_supported: true with caveats, exaggerated, or out of',
        'date. disputed: results contradict it. Cite only urls listed under that claim.',
        'plausible: what the results show is real (a tool exists, a figure is typical), with sources.',
        'The summary weighs the verdicts together with what the reel shows against itself.',
      ].join('\n'),
      messages: [{ role: 'user', content: `Reel topic: ${read.topic}\n\n${fromReel}\n\nClaims to judge:\n\n${brief}` }],
    }));
    recordUsage('claims-judge', MODEL_ID, judgement.usage, userId);
    const judged = judgement.parsed_output;
    if (!judged) throw new Error(`model returned no parsable verdicts (stop_reason ${judgement.stop_reason})`);

    for (const v of judged.verdicts) {
      const claim = toCheck[v.index];
      if (!claim) continue;
      const grounded = groundVerdict(v.verdict, v.cited_urls, results.get(claim)!);
      claim.verdict = grounded.verdict;
      claim.sources = grounded.sources;
      claim.explanation =
        grounded.verdict === 'unverifiable' && v.verdict !== 'unverifiable'
          ? `${v.explanation} (No source from the search backs this, so it counts as unverifiable.)`
          : v.explanation;
    }
    // A claim the judge skipped was still searched; it just has no verdict.
    for (const claim of toCheck) {
      if (claim.verdict === 'not_checked') {
        claim.verdict = 'unverifiable';
        claim.explanation = 'The search results did not address this claim.';
      }
    }
    // A plausible point is a finding like any other: no returned source, no point.
    const everything = [...results.values()].flat();
    plausible = judged.plausible
      .map((p) => ({ point: p.point, sources: citedSources(p.cited_urls, everything) }))
      .filter((p) => p.sources.length > 0);
    summary = judged.summary;
  }

  return {
    ...scoreReport(claims, hype_signals, red_flags),
    summary,
    topic: read.topic,
    claims,
    red_flags,
    hype_signals,
    plausible,
    model: MODEL_ID,
  };
}
