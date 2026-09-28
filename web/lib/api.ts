'use client';

import { fetchAuthSession } from 'aws-amplify/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export type MediaStatus =
  | 'awaiting_upload'
  | 'queued'
  | 'downloading'
  | 'extracting'
  | 'analysing'
  | 'indexing'
  | 'ready'
  | 'failed';

export interface Media {
  id: string;
  source: 'api' | 'upload' | 'url';
  type: 'reel' | 'post' | 'carousel';
  status: MediaStatus;
  created_at: string;
  s3_key?: string;
  content_type?: string;
  bytes?: number;
  original_filename?: string;
  permalink?: string;
  caption_raw?: string;
  caption_normalized?: string;
  taken_at?: string;
  uploader?: string;
  analysis_summary?: string;
  places?: Place[];
  /** Speech, transcribed from the reel's audio. */
  transcript?: string;
  transcript_segment_count?: number;
  spoken_language?: string;
  /** 'frames' when the caption was read off the video rather than supplied. */
  caption_source?: string;
  /** Number of slides, when this is a carousel. */
  slide_count?: number;
  /** Presigned cover frame for the library grid. */
  thumbnailUrl?: string;
  error?: string;
}

/** ts_ms encodes the slide index for a carousel; see SLIDE_INTERVAL_MS. */
export const SLIDE_INTERVAL_MS = 1000;
export const tsMsToSlide = (tsMs: number) => Math.round(tsMs / SLIDE_INTERVAL_MS) + 1;

/**
 * Whether this record is slides rather than a timeline.
 *
 * Not `type === 'carousel'` alone: a pasted link to a single-image post is a
 * `post` with one slide, and calling that a carousel would be a lie in the data
 * model. slide_count is what both cases have in common.
 */
export const isSlideshow = (media: Pick<Media, 'type' | 'slide_count'>) =>
  media.type === 'carousel' || (media.slide_count ?? 0) > 0;

/** Slides have no timeline, so label their frames by slide instead. */
export const momentLabel = (media: Pick<Media, 'type' | 'slide_count'>, tsMs: number) =>
  isSlideshow(media) ? `Slide ${tsMsToSlide(tsMs)}` : `${(tsMs / 1000).toFixed(1)}s`;

export interface Frame {
  media_id: string;
  ts_ms: number;
  url?: string;
  kind?: 'cover' | 'scene' | 'sample' | 'slide';
  slide_index?: number;
  description?: string;
  ocr_text?: string;
}

export interface PlaceEvidence {
  ts_ms: number;
  text: string;
  kind: 'signage' | 'menu' | 'street_sign' | 'on_screen_caption' | 'other';
}

export interface Place {
  name: string;
  kind: string;
  /** read_from_frame is grounded in legible text; inferred is the model reasoning. */
  basis: 'read_from_frame' | 'from_caption' | 'inferred';
  evidence: PlaceEvidence[];
}

export interface TranscriptSegment {
  media_id: string;
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

/** The HTTP API's JWT authorizer is scoped to the user pool client, so it wants the id token. */
async function authHeader(): Promise<Record<string, string>> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error('not signed in');
  return { authorization: token };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_URL) throw new Error('NEXT_PUBLIC_API_URL is not set — run scripts/write-web-env.sh');
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(await authHeader()) },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error((detail as { error?: string }).error ?? `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export const listMedia = (cursor?: string) =>
  call<{ items: Media[]; cursor?: string }>(`/media${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);

export const getMedia = (id: string) => call<MediaDetail>(`/media/${id}`);

export const deleteMedia = (id: string) => call<{ deleted: string }>(`/media/${id}`, { method: 'DELETE' });

export interface RetryResult {
  mediaId: string;
  status: string;
  /** true when the video will be fetched from Instagram again. */
  refetches: boolean;
  framesRemoved: number;
  segmentsRemoved: number;
  removedFromIndex: number;
}

/** Run the pipeline again for a reel that failed. */
export const retryMedia = (id: string) =>
  call<RetryResult>(`/media/${id}/retry`, { method: 'POST' });

export const addFromUrl = (url: string) =>
  call<{ mediaId: string; media: Media }>('/media/url', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });

export interface Citation {
  media_id: string;
  ts_ms: number;
}

export interface AskAnswer {
  threadId: string | null;
  mode?: 'answer';
  /** false when the indexed frames did not support an answer. */
  answered: boolean;
  answer: string;
  citations: Citation[];
  sources?: Source[];
  retrieved?: Citation[];
}

/** A clip a citation points at, so a chip can say whose it was. */
export interface Source {
  media_id: string;
  type?: Media['type'];
  uploader?: string;
  caption?: string;
  slide_count?: number;
}

export interface PlanItem {
  text: string;
  citations: Citation[];
}

export interface Plan {
  title: string;
  overview: string;
  sections: Array<{ heading: string; items: PlanItem[] }>;
  gaps: string[];
  queries?: string[];
  moments?: number;
  itemsDropped?: number;
}

/**
 * A plan is not returned by the request that asked for it: building one takes
 * about a minute and the API cuts an integration off at thirty seconds. The
 * thread comes back immediately and the answer lands on it.
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

/** Ask a question, optionally scoped to one reel. */
export const ask = (question: string, options: { mediaId?: string; threadId?: string } = {}) =>
  call<AskAnswer>('/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, mediaId: options.mediaId, threadId: options.threadId }),
  });

/**
 * Wakes the search index ahead of a question.
 *
 * The collection scales to zero after ten idle minutes and the first search
 * afterwards takes tens of seconds — longer than the API will wait. Firing this
 * when the question box is focused spends that wait while the question is being
 * typed. Best effort: failures are ignored, because the question itself will
 * report anything that is actually wrong.
 */
export const warmSearch = () =>
  call<{ warmed: boolean; ms: number }>('/ask/warm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

/** Start a plan built from the whole library. Returns as soon as it is queued. */
export const startPlan = (request: string, options: { mediaId?: string; threadId?: string } = {}) =>
  call<PlanStarted>('/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      question: request,
      mode: 'plan',
      mediaId: options.mediaId,
      threadId: options.threadId,
    }),
  });

/**
 * Whether a line of text is asking for something built rather than a fact
 * looked up. Deliberately a local guess and not a model call: it costs nothing,
 * it is instant, and the panel shows which mode it picked so a wrong guess is
 * one click to correct.
 */
const BUILD_VERBS = /^(create|make|build|write|draft|plan|give me|put together|assemble|compile)\b/i;
const BUILD_NOUNS = /\b(itinerary|travel plan|trip plan|guide|checklist|packing list|shortlist|summary of everything|all the tips|all tips)\b/i;

export function looksLikePlan(text: string): boolean {
  const trimmed = text.trim();
  if (BUILD_VERBS.test(trimmed)) return true;
  if (BUILD_NOUNS.test(trimmed)) return true;
  // "using all my clips …" is asking across the library, whatever follows.
  return /\b(all|every) (my |the )?(clips|reels|videos|saves)\b/i.test(trimmed);
}

/** Labels a cited moment with whose clip it came from. */
export function sourceLabel(source: Source | undefined, tsMs: number): string {
  const moment = momentLabel({ type: source?.type ?? 'reel', slide_count: source?.slide_count }, tsMs);
  const who = source?.uploader?.split('|')[0].trim();
  return who ? `${who} · ${moment}` : moment;
}

export const listThreads = () => call<{ items: Thread[] }>('/threads');

export interface SimilarMatch {
  media_id: string;
  ts_ms: number;
  score: number;
  description: string;
  ocr_text: string;
  url?: string;
}

/** Uploads a screenshot to search with. It goes to its own prefix, not the library. */
export async function lensUpload(file: File): Promise<{ s3Key: string }> {
  const contentType = file.type.toLowerCase();
  const { s3Key, uploadUrl } = await call<{ s3Key: string; uploadUrl: string }>('/lens/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contentType, bytes: file.size }),
  });
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': contentType }, body: file });
  if (!put.ok) throw new Error(`upload failed: ${put.status}`);
  return { s3Key };
}

export const findSimilar = (query: { s3Key: string } | { mediaId: string; tsMs: number }) =>
  call<{ matches: SimilarMatch[] }>('/lens/similar', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(query),
  });

export interface LensEntity {
  kind: 'product' | 'brand' | 'place' | 'dish' | 'on_screen_text' | 'other';
  value: string;
  /** true only when the value is legible text in the frame, not an inference. */
  read_from_image: boolean;
}

export interface WebResult {
  title: string;
  url: string;
  description: string;
}

export interface WebLensAnswer {
  query: string;
  entities: LensEntity[];
  /** false when no search API key has been set. */
  configured: boolean;
  answered: boolean;
  summary: string;
  results: WebResult[];
  citedUrls: string[];
}

export const searchTheWeb = (query: { s3Key: string } | { mediaId: string; tsMs: number }) =>
  call<WebLensAnswer>('/lens/web', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(query),
  });

export const getThread = (id: string) =>
  call<{ threadId: string; messages: ThreadMessage[] }>(`/threads/${id}`);

/**
 * Uploads several images as one carousel rather than as separate posts, so the
 * whole thing is analysed together and Ask can reason across the slides.
 */
export async function uploadCarousel(
  files: File[],
  onProgress?: (fraction: number) => void,
): Promise<Media> {
  const slides = files.map((file) => ({
    filename: file.name,
    contentType: file.type.toLowerCase(),
    bytes: file.size,
  }));

  const { mediaId, slides: targets } = await call<{
    mediaId: string;
    slides: Array<{ index: number; uploadUrl: string; contentType: string }>;
  }>('/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slides }),
  });

  let done = 0;
  for (const target of targets) {
    await putWithProgress(target.uploadUrl, files[target.index], target.contentType);
    done += 1;
    onProgress?.(done / targets.length);
  }

  return call<Media>(`/media/${mediaId}/complete`, { method: 'POST' });
}

/**
 * Three steps: reserve the id, PUT the bytes straight to S3 with the presigned
 * URL, then tell the API the object landed so it can queue the pipeline.
 */
export async function uploadFile(file: File, onProgress?: (fraction: number) => void): Promise<Media> {
  // The presigned URL signs this exact string, so both calls must agree on it.
  const contentType = file.type.toLowerCase();

  const { mediaId, uploadUrl } = await call<{ mediaId: string; uploadUrl: string }>('/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: file.name, contentType, bytes: file.size }),
  });

  await putWithProgress(uploadUrl, file, contentType, onProgress);

  return call<Media>(`/media/${mediaId}/complete`, { method: 'POST' });
}

/** XHR rather than fetch, purely because fetch gives no upload progress. */
function putWithProgress(
  url: string,
  file: File,
  contentType: string,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload failed: ${xhr.status}`));
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.send(file);
  });
}

/*
 * Connected mode's client, kept deliberately.
 *
 * The Connect Instagram screens were removed at MJ's request, but the phase 6
 * endpoints are still deployed — so these stay as the documented client for
 * them. Restoring the option means re-adding app/connect/, nothing more.
 */

export interface ConnectionStatus {
  connected: boolean;
  /** false until the Meta app id and secret are both in place. */
  configured: boolean;
  username?: string;
  igUserId?: string;
  scopes?: string;
  expiresAt?: string;
  daysLeft?: number;
  lastSyncAt?: string;
}

export interface SyncResult {
  checked: number;
  results: Array<{ ig_media_id: string; status: string; mediaId?: string; reason?: string }>;
}

export const connectionStatus = () => call<ConnectionStatus>('/connect/instagram');

export const startConnect = () =>
  call<{ authorizeUrl: string; redirectUri: string }>('/connect/instagram/start', { method: 'POST' });

export const completeConnect = (code: string, state: string) =>
  call<{ connected: boolean; username?: string; expiresInDays?: number }>('/connect/instagram/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, state }),
  });

export const disconnectInstagram = () =>
  call<{ connected: boolean }>('/connect/instagram', { method: 'DELETE' });

export const syncInstagram = (limit?: number) =>
  call<SyncResult>('/connect/instagram/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit }),
  });
