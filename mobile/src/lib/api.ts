import { API_URL } from './config';
import { getIdToken } from './auth';

/*
 * The subset of web/lib/api.ts this app uses, with the same shapes. Copied
 * rather than shared because the web client is bound to Amplify and Next's
 * env; if these drift from the API, it is the web's copy that is authoritative.
 */

export type MediaStatus =
  | 'awaiting_upload'
  | 'queued'
  | 'downloading'
  | 'extracting'
  | 'analysing'
  | 'indexing'
  | 'ready'
  | 'failed';

export interface PlaceEvidence {
  ts_ms: number;
  text: string;
  kind: string;
}

export interface Place {
  name: string;
  kind: string;
  /** read_from_frame is grounded in legible text; inferred is the model reasoning. */
  basis: 'read_from_frame' | 'from_caption' | 'inferred';
  evidence: PlaceEvidence[];
}

export interface Media {
  id: string;
  source: 'api' | 'upload' | 'url';
  type: 'reel' | 'post' | 'carousel';
  status: MediaStatus;
  created_at: string;
  permalink?: string;
  caption_raw?: string;
  uploader?: string;
  analysis_summary?: string;
  places?: Place[];
  transcript?: string;
  spoken_language?: string;
  caption_source?: string;
  slide_count?: number;
  thumbnailUrl?: string;
  error?: string;
}

export interface Frame {
  media_id: string;
  ts_ms: number;
  url?: string;
  kind?: 'cover' | 'scene' | 'sample' | 'slide';
  description?: string;
  ocr_text?: string;
}

export interface TranscriptSegment {
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface MediaDetail {
  media: Media;
  frames: Frame[];
  transcriptSegments: TranscriptSegment[];
  playbackUrl?: string;
}

export interface Citation {
  media_id: string;
  ts_ms: number;
}

/** A clip a citation points at, so a citation can say whose it was. */
export interface Source {
  media_id: string;
  type?: Media['type'];
  uploader?: string;
  caption?: string;
  slide_count?: number;
}

export interface AskAnswer {
  threadId: string | null;
  /** false when the indexed moments did not support an answer. */
  answered: boolean;
  answer: string;
  citations: Citation[];
  sources?: Source[];
}

export interface PlanItem {
  text: string;
  citations: Citation[];
}

export interface Plan {
  title: string;
  overview: string;
  sections: Array<{ heading: string; items: PlanItem[] }>;
  /** What was asked for that the clips do not cover. */
  gaps: string[];
}

/**
 * A plan is not returned by the request that asks for it: building one takes
 * about a minute and the API cuts a request off at thirty seconds. The thread
 * comes back at once and the plan lands on its assistant message.
 */
export interface PlanStarted {
  threadId: string;
  mode: 'plan';
  status: 'working';
  messageAt: string;
}

export interface ThreadMessage {
  thread_id: string;
  created_at: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  mode?: 'answer' | 'plan';
  /** Plans only: 'working' until the worker fills the message in. */
  status?: 'working' | 'ready' | 'unsupported' | 'failed';
  plan?: Plan;
  sources?: Source[];
  error?: string;
}

export interface Thread {
  id: string;
  scope: 'media' | 'library';
  media_id?: string;
  title: string;
  created_at: string;
}

/** ts_ms encodes the slide number for a carousel, 1000ms per slide. */
const SLIDE_INTERVAL_MS = 1000;

/** Slides, not a timeline: a carousel, or a single-image post. */
export const isSlideshow = (media: Pick<Media, 'type' | 'slide_count'>) =>
  media.type === 'carousel' || (media.slide_count ?? 0) > 0;

export const momentLabel = (media: Pick<Media, 'type' | 'slide_count'>, tsMs: number) =>
  isSlideshow(media)
    ? `Slide ${Math.round(tsMs / SLIDE_INTERVAL_MS) + 1}`
    : `${(tsMs / 1000).toFixed(1)}s`;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_URL) throw new Error('EXPO_PUBLIC_API_URL is not set — run scripts/write-mobile-env.sh');
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    // The HTTP API's JWT authorizer is scoped to the app client, so it wants the id token.
    headers: { ...(init.headers ?? {}), authorization: await getIdToken() },
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new ApiError(detail.error ?? detail.message ?? `${response.status}`, response.status);
  }
  return (await response.json()) as T;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** `size=small`: the 288px tile image, a third of the web's 520px one (see infra/extract/src/ffmpeg.ts). */
export const listMedia = (cursor?: string) =>
  call<{ items: Media[]; cursor?: string }>(`/media?size=small${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);

export const getMedia = (id: string) => call<MediaDetail>(`/media/${encodeURIComponent(id)}`);

/**
 * Save a pasted or shared permalink. If anyone has already ingested it, this
 * returns the existing reel rather than fetching it again.
 */
export const addFromUrl = (url: string) =>
  call<{ mediaId: string; media: Media; alreadyIngested?: boolean }>('/media/url', json({ url }));

export const retryMedia = (id: string) =>
  call<{ mediaId: string; status: string }>(`/media/${encodeURIComponent(id)}/retry`, { method: 'POST' });

/**
 * Ask, retrying once if the API cut the request off.
 *
 * The search index scales to zero, and waking it can outlast API Gateway's
 * fixed 30s ceiling: the gateway answers 503/504 while the Lambda carries on
 * and warms the index. Measured on 2026-09-30: two 5xx in the hour a reel's
 * Ask kept "failing", with no Lambda error at all. A second attempt lands on a
 * warm index and answers in seconds, so the user gets a slow answer instead of
 * an error. Only once: a second failure is a real one.
 */
export async function ask(question: string, options: { mediaId?: string; threadId?: string | null } = {}) {
  const send = () =>
    call<AskAnswer>('/ask', json({ question, mediaId: options.mediaId, threadId: options.threadId ?? undefined }));
  try {
    return await send();
  } catch (err) {
    if (err instanceof ApiError && err.status >= 503) return send();
    throw err;
  }
}

/** Start a plan built from the whole library. Returns as soon as it is queued. */
export const startPlan = (request: string, options: { threadId?: string | null } = {}) =>
  call<PlanStarted>('/ask', json({ question: request, mode: 'plan', threadId: options.threadId ?? undefined }));

export const getThread = (id: string) =>
  call<{ threadId: string; messages: ThreadMessage[] }>(`/threads/${encodeURIComponent(id)}`);

export const listThreads = () => call<{ items: Thread[] }>('/threads');

/**
 * Where a plan's PDF lives: a download link if one was stored by an earlier
 * share (from either app), or an upload link to store this one.
 */
export const planPdfLocation = (threadId: string, messageAt: string) =>
  call<{ exists: boolean; url?: string; uploadUrl?: string }>('/plans/pdf', json({ threadId, messageAt }));

/**
 * Whether a line asks for something built rather than a fact looked up. The
 * same local guess as the web (web/lib/api.ts): instant, free, and shown to the
 * user with one tap to switch, so a wrong guess costs nothing.
 */
const BUILD_VERBS = /^(create|make|build|write|draft|plan|give me|put together|assemble|compile)\b/i;
const BUILD_NOUNS = /\b(itinerary|travel plan|trip plan|guide|checklist|packing list|shortlist|summary of everything|all the tips|all tips)\b/i;

export function looksLikePlan(text: string): boolean {
  const trimmed = text.trim();
  if (BUILD_VERBS.test(trimmed) || BUILD_NOUNS.test(trimmed)) return true;
  return /\b(all|every) (my |the )?(clips|reels|videos|saves)\b/i.test(trimmed);
}

/** A creator's name without the self-description Instagram handles carry. */
export const creatorName = (uploader?: string) => uploader?.split(/[|·•]/)[0].trim() || undefined;

/** "Elvira · 3.2s" — whose clip, and where in it. */
export function sourceLabel(source: Source | undefined, tsMs: number): string {
  const moment = momentLabel({ type: source?.type ?? 'reel', slide_count: source?.slide_count }, tsMs);
  const who = creatorName(source?.uploader);
  return who ? `${who} · ${moment}` : moment;
}

/**
 * Wakes the search index while the question is being typed: the collection
 * scales to zero and its first search can outlast the API's 30s ceiling.
 * Best effort, and throttled, since each call is a Lambda invocation.
 */
let lastWarm = 0;
export function warmSearch() {
  if (Date.now() - lastWarm < 5 * 60_000) return;
  lastWarm = Date.now();
  void call('/ask/warm', json({})).catch(() => undefined);
}

/**
 * The id a link will have once added: the shortcode, as the API keys content by
 * it (POST /media/url). Knowing it up front lets the reel screen open at once
 * and show progress, instead of a spinner waiting on the request.
 * Mirrors IG_PERMALINK in infra/lambda/shared/media.ts.
 */
export function shortcodeOf(url: string): string | undefined {
  return /^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]{5,})/i.exec(url.trim())?.[1];
}

/** Pull the first Instagram permalink out of shared text ("Check this out https://…"). */
export function findInstagramUrl(text: string | null | undefined): string | undefined {
  const match = text?.match(/https?:\/\/(?:www\.)?instagram\.com\/[^\s]+/i);
  return match?.[0];
}
