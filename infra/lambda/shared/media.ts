/** Media lifecycle. The ingest pipeline owns everything after `queued`. */
export const MEDIA_STATUS = [
  'awaiting_upload',
  'queued',
  'downloading',
  'extracting',
  'analysing',
  'indexing',
  'ready',
  'failed',
] as const;
export type MediaStatus = (typeof MEDIA_STATUS)[number];

export type MediaSource = 'api' | 'upload' | 'url';
export type MediaType = 'reel' | 'post' | 'carousel';

export interface MediaRecord {
  id: string;
  /** Constant, exists only to give the recency GSI a partition key. */
  entity: string;
  source: MediaSource;
  type: MediaType;
  status: MediaStatus;
  created_at: string;
  s3_key?: string;
  /** Cover frame, for the library grid's thumbnail. */
  cover_s3_key?: string;
  /** The library grid's image: the cover, downscaled to tile size. */
  thumb_s3_key?: string;
  content_type?: string;
  bytes?: number;
  original_filename?: string;
  permalink?: string;
  ig_media_id?: string;
  caption_raw?: string;
  caption_normalized?: string;
  taken_at?: string;
  /** Account that posted a downloaded reel, from the public page metadata. */
  uploader?: string;
  /** Number of slides, when this is a carousel. */
  slide_count?: number;
  /** Speech, transcribed from the reel's audio track. */
  transcript?: string;
  transcript_segment_count?: number;
  spoken_language?: string;
  error?: string;
}

/** Uploads we accept in drop-in mode: screen recordings and screenshots. */
export const ALLOWED_CONTENT_TYPES: Record<string, { ext: string; type: MediaType }> = {
  'video/mp4': { ext: '.mp4', type: 'reel' },
  'video/quicktime': { ext: '.mov', type: 'reel' },
  'video/webm': { ext: '.webm', type: 'reel' },
  'image/jpeg': { ext: '.jpg', type: 'post' },
  'image/png': { ext: '.png', type: 'post' },
  'image/webp': { ext: '.webp', type: 'post' },
};

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

/**
 * A carousel's slides are stored as frames, because frames are already the
 * citable unit: one row per image, keyed by (media_id, ts_ms), which lets
 * analysis, the index, Ask and Lens work on a carousel unchanged.
 *
 * ts_ms carries the slide index times this, so a slide is a whole "second"
 * apart from its neighbour and nothing that sorts or keys by ts_ms needs to
 * know the difference. The UI labels them "Slide N" rather than a time.
 */
export const SLIDE_INTERVAL_MS = 1000;

export const slideTsMs = (index: number) => index * SLIDE_INTERVAL_MS;
export const tsMsToSlide = (tsMs: number) => Math.round(tsMs / SLIDE_INTERVAL_MS) + 1;

/**
 * Instagram permalinks we recognise in drop-in mode.
 * /reel/<code>, /reels/<code> and /p/<code>, with or without a username segment.
 */
const IG_PERMALINK =
  /^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(reel|reels|p|tv)\/([A-Za-z0-9_-]{5,})\/?/;

export function parseInstagramUrl(url: string): { permalink: string; shortcode: string; type: MediaType } | undefined {
  const match = IG_PERMALINK.exec(url.trim());
  if (!match) return undefined;
  const [, kind, shortcode] = match;
  return {
    permalink: `https://www.instagram.com/${kind === 'reels' ? 'reel' : kind}/${shortcode}/`,
    shortcode,
    type: kind === 'p' ? 'post' : 'reel',
  };
}
