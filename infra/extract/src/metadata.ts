/**
 * Mapping from yt-dlp's `--dump-single-json` output onto our media record.
 *
 * Only the fields the data model already has: a public reel's description gives
 * us the caption without an OCR pass.
 */

export interface YtDlpThumbnail {
  id?: string;
  url?: string;
}

export interface YtDlpInfo {
  id?: string;
  title?: string;
  description?: string;
  /** Present on anything with a video stream; absent on an image slide. */
  formats?: unknown[];
  /** The direct media url yt-dlp resolved, when there is one. */
  url?: string;
  /** For an image post this is the picture itself, at full size. */
  thumbnail?: string;
  thumbnails?: YtDlpThumbnail[];
  /** A carousel comes back as a playlist, one entry per card. */
  entries?: Array<YtDlpInfo | null>;
  /** Epoch seconds. */
  timestamp?: number;
  /** YYYYMMDD, present when `timestamp` is not. */
  upload_date?: string;
  duration?: number;
  uploader?: string;
  uploader_id?: string;
  webpage_url?: string;
  ext?: string;
  filesize?: number;
  filesize_approx?: number;
  is_live?: boolean;
  availability?: string;
}

export interface MediaFields {
  caption_raw?: string;
  caption_normalized?: string;
  taken_at?: string;
  duration_ms?: number;
  uploader?: string;
}

/** Zero-width characters Instagram captions are littered with. */
const INVISIBLE = new RegExp('[\\u200b-\\u200f\\u2028\\u2029\\ufeff]', 'g');

/**
 * Keeps the caption's meaning and its hashtags, drops the noise: invisible
 * characters, CRLF, trailing spaces and runs of blank lines.
 */
export function normalizeCaption(caption: string): string {
  return caption
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function takenAtFrom(info: YtDlpInfo): string | undefined {
  if (typeof info.timestamp === 'number' && Number.isFinite(info.timestamp)) {
    return new Date(info.timestamp * 1000).toISOString();
  }
  const date = info.upload_date;
  if (date && /^\d{8}$/.test(date)) {
    return new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00.000Z`).toISOString();
  }
  return undefined;
}

export function toMediaFields(info: YtDlpInfo): MediaFields {
  // Instagram has no separate title: yt-dlp synthesises one from the caption,
  // so it is only worth using when there is no description at all.
  const caption = info.description?.trim() || undefined;
  const normalized = caption ? normalizeCaption(caption) : undefined;
  return {
    caption_raw: caption,
    caption_normalized: normalized,
    taken_at: takenAtFrom(info),
    duration_ms:
      typeof info.duration === 'number' && Number.isFinite(info.duration)
        ? Math.round(info.duration * 1000)
        : undefined,
    uploader: info.uploader ?? info.uploader_id,
  };
}

export interface PostSlide {
  /**
   * 1-based position in the post. Kept rather than re-numbered so that a slide
   * we skip leaves a gap: "slide 3" then still means the third card of the
   * post, which is what a citation has to mean to be worth anything.
   */
  position: number;
  shortcode?: string;
  url: string;
}

export type PostShape =
  | { kind: 'video' }
  | { kind: 'slides'; slides: PostSlide[]; videoSlidesSkipped: number }
  | { kind: 'empty' };

const hasVideo = (info: YtDlpInfo): boolean => (info.formats?.length ?? 0) > 0 || Boolean(info.url);

/**
 * yt-dlp rates the variant with no size in its `stp` parameter highest, and for
 * an Instagram slide that is the uncropped, unresized original. The others are
 * square crops and padded boxes, which would cut text off the edge of a slide —
 * so `thumbnail` is the one to take, with the end of `thumbnails` as a fallback
 * because that is where the largest variants sit.
 */
function bestImage(entry: YtDlpInfo): string | undefined {
  const candidates = [entry.thumbnail, ...[...(entry.thumbnails ?? [])].reverse().map((t) => t?.url)];
  return candidates.find((url): url is string => typeof url === 'string' && url.startsWith('https://'));
}

/**
 * What a permalink actually points at.
 *
 * "No video formats found" is not a failure for an image post — it is what one
 * looks like. yt-dlp answers a carousel with a playlist whose entries carry no
 * formats, only thumbnails, and `--ignore-no-formats-error` is what keeps those
 * entries in the response instead of nulling every one of them out.
 *
 * A video among the slides is counted and skipped: extracting keyframes from it
 * would mean running the whole reel pipeline per slide, so for now the post is
 * analysed from its images and the count says what was left out.
 */
export function classifyPost(info: YtDlpInfo): PostShape {
  if (hasVideo(info)) return { kind: 'video' };

  const entries = info.entries?.length ? info.entries : [info];
  const slides: PostSlide[] = [];
  let videoSlidesSkipped = 0;

  entries.forEach((entry, index) => {
    if (!entry) return;
    if (hasVideo(entry)) {
      videoSlidesSkipped += 1;
      return;
    }
    const url = bestImage(entry);
    if (url) slides.push({ position: index + 1, shortcode: entry.id, url });
  });

  return slides.length > 0 ? { kind: 'slides', slides, videoSlidesSkipped } : { kind: 'empty' };
}

/** Phrases Instagram serves instead of media when it wants a logged-in session. */
const LOGIN_WALL = [
  'login required',
  'requested content is not available',
  // yt-dlp's catch-all names both causes; it is kept here because the observed
  // real case behind it was a wall, not a limit.
  'rate-limit reached',
  'sign in to confirm',
  'you need to log in',
  'private account',
  // What Instagram actually returned to the Lambda: a 200 with no media. It
  // means the same thing, and no number of retries will change it.
  'empty media response',
  'without being logged-in',
  'use --cookies',
];

/**
 * Turns a yt-dlp stderr dump into something the Library can show, and says
 * plainly when the cause is a login wall rather than a broken link.
 */
/**
 * What an image post or carousel looks like to yt-dlp. Distinct from a login
 * wall: reporting it as one sent the reader after cookies for a problem that
 * has nothing to do with authentication.
 */
const NO_VIDEO = ['no video formats found', 'no video could be found', 'unsupported url'];

/**
 * Anonymous rate limiting, which is **not** a login wall and not a broken link.
 * Distinct because the remedy is distinct: a login wall never clears, this
 * always does, and only one of them is worth trying again.
 *
 * Instagram's own message is "you have exceeded the rate-limit for accessing
 * posts anonymously", and nothing in LOGIN_WALL matched it — so it used to fall
 * through to a generic failure, which is in the pipeline's retry list, which
 * then fired two more requests at a service that had just asked us to slow down.
 *
 * Matched narrowly on purpose. yt-dlp has a catch-all — "Requested content is
 * not available, rate-limit reached or login required" — where it does not
 * itself know which happened; that one stays with the login wall, where its
 * handling was worked out against a real failure.
 */
const RATE_LIMITED = [
  'exceeded the rate-limit',
  'exceeded the rate limit',
  'too many requests',
  'http error 429',
];

export function explainDownloadFailure(stderr: string): {
  message: string;
  loginWalled: boolean;
  noVideo: boolean;
  rateLimited: boolean;
} {
  const haystack = stderr.toLowerCase();
  const noVideo = NO_VIDEO.some((phrase) => haystack.includes(phrase));
  const rateLimited = !noVideo && RATE_LIMITED.some((phrase) => haystack.includes(phrase));
  const loginWalled = !noVideo && !rateLimited && LOGIN_WALL.some((phrase) => haystack.includes(phrase));
  // Our subprocess wrapper prefixes "yt-dlp exited N: ", so ERROR: sits mid-line.
  const errorLine = stderr.split('\n').find((line) => line.includes('ERROR:'));
  const firstError = errorLine
    ? errorLine.slice(errorLine.indexOf('ERROR:')).trim()
    : (stderr.trim().split('\n').slice(-1)[0] ?? 'download failed');
  if (noVideo) {
    return {
      message:
        'This link has no video in it, which is what an image post or a carousel looks like. ' +
        'Upload its images instead, or connect the account if it is yours.',
      loginWalled: false,
      noVideo: true,
      rateLimited: false,
    };
  }
  if (rateLimited) {
    return {
      // Says the one thing worth knowing: waiting fixes it, and Retry is there.
      message:
        'Instagram is rate-limiting anonymous downloads right now. This clears on its own — ' +
        'try again in a little while.',
      loginWalled: false,
      noVideo: false,
      rateLimited: true,
    };
  }
  return {
    message: loginWalled
      ? `Instagram would not serve this reel without a logged-in session: ${firstError}`
      : firstError,
    loginWalled,
    noVideo: false,
    rateLimited: false,
  };
}
