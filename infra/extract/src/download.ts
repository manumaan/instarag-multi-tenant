import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { convertSlide, readFrame, run } from './ffmpeg';
import { mapWithConcurrency } from './concurrency';
import { writeThumbnail } from './thumbnail';
import { recordDownload } from './metrics';
import { addDownloadUsage } from './ledger';
import {
  classifyPost,
  explainDownloadFailure,
  toMediaFields,
  type PostSlide,
  type YtDlpInfo,
} from './metadata';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const BUCKET = process.env.MEDIA_BUCKET!;
const MEDIA_TABLE = process.env.MEDIA_TABLE!;
const FRAMES_TABLE = process.env.FRAMES_TABLE!;
const YT_DLP = process.env.YT_DLP_PATH ?? 'yt-dlp';
/**
 * Python needs the system OpenSSL, not the Node runtime's, or its ssl module
 * fails to load. Set on the subprocess only. See the Dockerfile.
 */
const YT_DLP_ENV = { LD_LIBRARY_PATH: process.env.PY_LD_LIBRARY_PATH ?? '/usr/lib64:/lib64' };
const FFMPEG_DIR = '/usr/local/bin';
/** Keep a reel comfortably under the extractor's ephemeral storage. */
const MAX_BYTES = Number(process.env.MAX_DOWNLOAD_BYTES ?? 500 * 1024 * 1024);
/** The same cap the upload path applies (MAX_SLIDES in lambda/media/create-upload.ts). */
const MAX_SLIDES = Number(process.env.MAX_SLIDES ?? 20);
/**
 * Must equal SLIDE_INTERVAL_MS in lambda/shared/media.ts. The two cannot share a
 * module: this bundle is built from infra/extract on its own. A test asserts
 * they agree, because a mismatch would silently renumber every slide citation.
 */
export const SLIDE_INTERVAL_MS = 1000;
/** A full-size Instagram slide is a few MB; this is room for an outlier. */
const MAX_SLIDE_BYTES = Number(process.env.MAX_SLIDE_BYTES ?? 25 * 1024 * 1024);
/** Bounded, so a 20-slide post cannot open 20 CDN connections at once. */
const SLIDE_CONCURRENCY = Number(process.env.SLIDE_CONCURRENCY ?? 4);

export interface DownloadEvent {
  mediaId: string;
  /** Whoever caused this fetch, carried from the execution input. */
  userId?: string;
}

export interface DownloadResult {
  mediaId: string;
  /** Which way the pipeline goes next: extract a video, or analyse slides. */
  kind: 'reel' | 'carousel';
  s3Key?: string;
  bytes: number;
  hasCaption: boolean;
  slides?: number;
  /** Video cards in a mixed carousel, which are counted rather than analysed. */
  videoSlidesSkipped?: number;
}

/**
 * Fetches what a public permalink points at into the media store, then hands off
 * to the same pipeline the upload path uses.
 *
 * A reel becomes a video to extract keyframes from; an image post or carousel
 * becomes slides, which are frames already. Which one it is cannot be known
 * until the metadata pass has run, so the pipeline branches on the result rather
 * than on the pasted url.
 *
 * Public posts only: no credentials, no cookies, no logged-in session.
 */
export async function handler(event: DownloadEvent): Promise<DownloadResult> {
  const { mediaId, userId } = event;
  if (!mediaId) throw new Error('mediaId is required');

  const record = await ddb.send(new GetCommand({ TableName: MEDIA_TABLE, Key: { id: mediaId } }));
  const media = record.Item as { permalink?: string } | undefined;
  if (!media) throw new Error(`media ${mediaId} not found`);
  if (!media.permalink) throw new Error(`media ${mediaId} has no permalink to download`);

  const workDir = await mkdtemp(path.join(tmpdir(), `download-${mediaId}-`));
  try {
    const info = await probeRemote(media.permalink);

    const shape = classifyPost(info);
    if (shape.kind === 'empty') {
      // Not the same as a login wall, and not something a retry will fix.
      const error = new Error(
        'Instagram served neither a video nor any images for this link. It may be private, ' +
          'deleted, or a kind of post we do not handle yet.',
      );
      error.name = 'NoVideoInPost';
      throw error;
    }
    if (shape.kind === 'slides') {
      return await storeSlides(mediaId, info, shape.slides, shape.videoSlidesSkipped, workDir, userId);
    }

    const declared = info.filesize ?? info.filesize_approx;
    if (declared && declared > MAX_BYTES) {
      throw new Error(`reel is ${declared} bytes, over the ${MAX_BYTES} byte limit`);
    }

    const file = await download(media.permalink, workDir);
    const { size } = await stat(file);
    if (size > MAX_BYTES) throw new Error(`downloaded ${size} bytes, over the ${MAX_BYTES} byte limit`);

    const s3Key = `media/${mediaId}/original.mp4`;
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: s3Key,
        Body: createReadStream(file),
        ContentLength: size,
        ContentType: 'video/mp4',
      }),
    );

    const fields = toMediaFields(info);

    // Only set what the metadata actually gave us: a reel with no caption would
    // otherwise leave :raw referenced but undefined, which DynamoDB rejects.
    const sets = ['s3_key = :key', 'content_type = :type', '#bytes = :bytes'];
    const values: Record<string, unknown> = { ':key': s3Key, ':type': 'video/mp4', ':bytes': size };
    const optional: Array<[attribute: string, placeholder: string, value: unknown]> = [
      ['caption_raw', ':raw', fields.caption_raw],
      ['caption_normalized', ':norm', fields.caption_normalized],
      ['taken_at', ':taken', fields.taken_at],
      ['uploader', ':uploader', fields.uploader],
    ];
    for (const [attribute, placeholder, value] of optional) {
      if (value === undefined) continue;
      sets.push(`${attribute} = ${placeholder}`);
      values[placeholder] = value;
    }

    // attribute_exists: never resurrect a record deleted while this ran.
    await ddb.send(
      new UpdateCommand({
        TableName: MEDIA_TABLE,
        Key: { id: mediaId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: { '#bytes': 'bytes' },
        ExpressionAttributeValues: values,
        ConditionExpression: 'attribute_exists(id)',
      }),
    );

    console.log('downloaded', {
      mediaId,
      bytes: size,
      hasCaption: Boolean(fields.caption_raw),
      uploader: fields.uploader,
    });
    recordDownload('ok', { mediaId, bytes: size, kind: 'reel' });
    await addDownloadUsage(userId, { downloads: 1, bytes_downloaded: size });
    return { mediaId, kind: 'reel', s3Key, bytes: size, hasCaption: Boolean(fields.caption_raw) };
  } catch (err) {
    recordDownload((err as Error).name === 'InstagramRateLimited' ? 'rate_limited' : 'failed', {
      mediaId,
    });
    // A refused attempt still spent a request against the anonymous limit, so
    // it counts — bytes did not move, so those do not.
    await addDownloadUsage(userId, { downloads: 1 });
    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Fetches a post's slides into the record's frames/ prefix and registers each as
 * a frame, which is exactly the shape the upload path produces. The pipeline can
 * then run the carousel branch it already has: no download, no extraction, no
 * transcription, straight to the vision pass.
 *
 * Slide numbers come from the slide's position in the post, not from its index
 * in what we fetched, so a skipped video card leaves a gap rather than shifting
 * every later citation by one.
 */
async function storeSlides(
  mediaId: string,
  info: YtDlpInfo,
  slides: PostSlide[],
  videoSlidesSkipped: number,
  workDir: string,
  userId?: string,
): Promise<DownloadResult> {
  const wanted = slides.slice(0, MAX_SLIDES);
  if (wanted.length < slides.length) {
    console.log('capping slides', { mediaId, found: slides.length, cap: MAX_SLIDES });
  }
  // Instagram's CDN is happier with the referer yt-dlp itself sends.
  const referer = 'https://www.instagram.com/';

  const stored = await mapWithConcurrency(wanted, SLIDE_CONCURRENCY, async (slide, index) => {
    const tsMs = (slide.position - 1) * SLIDE_INTERVAL_MS;
    const original = path.join(workDir, `slide-${index}.bin`);
    const encoded = path.join(workDir, `slide-${index}.jpg`);

    const response = await fetch(slide.url, { headers: { referer } });
    if (!response.ok) {
      throw new Error(`slide ${slide.position} fetch failed: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error(`slide ${slide.position} came back empty`);
    if (bytes.length > MAX_SLIDE_BYTES) {
      throw new Error(`slide ${slide.position} is ${bytes.length} bytes, over the ${MAX_SLIDE_BYTES} byte limit`);
    }
    await writeFile(original, bytes);
    await convertSlide(original, encoded);
    await rm(original, { force: true });

    const body = await readFrame(encoded);
    const key = `media/${mediaId}/frames/${String(tsMs).padStart(8, '0')}.jpg`;
    await s3.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'image/jpeg' }),
    );
    return { tsMs, key, slideIndex: slide.position - 1, bytes: body.length };
  });

  const now = new Date().toISOString();
  const rows = stored.map((slide) => ({
    PutRequest: {
      Item: {
        media_id: mediaId,
        ts_ms: slide.tsMs,
        s3_key: slide.key,
        kind: 'slide',
        slide_index: slide.slideIndex,
        created_at: now,
      },
    },
  }));
  for (let i = 0; i < rows.length; i += 25) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [FRAMES_TABLE]: rows.slice(i, i + 25) } }));
  }

  const fields = toMediaFields(info);
  const bytes = stored.reduce((total, slide) => total + slide.bytes, 0);
  // A single image is a post, not a carousel; slide_count is what the UI reads
  // to know it is looking at slides either way.
  const sets = ['#type = :type', 'slide_count = :count', 'cover_s3_key = :cover', '#bytes = :bytes'];
  const values: Record<string, unknown> = {
    ':type': stored.length > 1 ? 'carousel' : 'post',
    ':count': stored.length,
    ':cover': stored[0].key,
    ':bytes': bytes,
  };
  const optional: Array<[attribute: string, placeholder: string, value: unknown]> = [
    ['caption_raw', ':raw', fields.caption_raw],
    ['caption_normalized', ':norm', fields.caption_normalized],
    ['taken_at', ':taken', fields.taken_at],
    ['uploader', ':uploader', fields.uploader],
  ];
  for (const [attribute, placeholder, value] of optional) {
    if (value === undefined) continue;
    sets.push(`${attribute} = ${placeholder}`);
    values[placeholder] = value;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: MEDIA_TABLE,
      Key: { id: mediaId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: { '#type': 'type', '#bytes': 'bytes' },
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(id)',
    }),
  );

  // A slide is encoded at 1568px so the vision pass can read it; the grid needs
  // nothing like that.
  await writeThumbnail(mediaId, stored[0].key);

  console.log('stored slides', {
    mediaId,
    slides: stored.length,
    videoSlidesSkipped,
    bytes,
    hasCaption: Boolean(fields.caption_raw),
  });
  recordDownload('ok', { mediaId, bytes, kind: 'carousel' });
  await addDownloadUsage(userId, { downloads: 1, bytes_downloaded: bytes });
  return {
    mediaId,
    kind: 'carousel',
    bytes,
    hasCaption: Boolean(fields.caption_raw),
    slides: stored.length,
    videoSlidesSkipped,
  };
}

/** Metadata pass first: it is cheap and tells us the size before we commit to it. */
async function probeRemote(url: string): Promise<YtDlpInfo> {
  try {
    const { stdout } = await run(
      YT_DLP,
      [
        ...baseArgs(),
        // Without this, every entry of an image carousel comes back null and the
        // whole call exits non-zero: "no video formats found" per slide. It is
        // what turns an image post from an error into something we can read.
        '--ignore-no-formats-error',
        '--dump-single-json',
        '--skip-download',
        url,
      ],
      YT_DLP_ENV,
    );
    return JSON.parse(stdout.toString('utf8')) as YtDlpInfo;
  } catch (err) {
    throw asDownloadError(err);
  }
}

async function download(url: string, workDir: string): Promise<string> {
  try {
    await run(
      YT_DLP,
      [
      ...baseArgs(),
      // Prefer a single progressive mp4; fall back to merging the best streams.
      '-f', 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
      '--merge-output-format', 'mp4',
      '--ffmpeg-location', FFMPEG_DIR,
      '-o', path.join(workDir, 'reel.%(ext)s'),
      url,
      ],
      YT_DLP_ENV,
    );
  } catch (err) {
    throw asDownloadError(err);
  }

  const files = await readdir(workDir);
  const downloaded = files.find((f) => f.startsWith('reel.'));
  if (!downloaded) throw new Error('yt-dlp reported success but wrote no file');
  return path.join(workDir, downloaded);
}

function baseArgs(): string[] {
  return [
    '--no-warnings',
    '--no-progress',
    '--no-playlist',
    '--no-cache-dir',
    // No cookies, no credentials: public reels only.
    '--no-cookies',
    '--socket-timeout', '30',
    '--retries', '3',
  ];
}

/** Surfaces a login wall as a login wall rather than a generic exit code. */
function asDownloadError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const { message, loginWalled, noVideo, rateLimited } = explainDownloadFailure(raw);
  const error = new Error(message);
  // Distinct names so the pipeline does not retry what cannot succeed: neither
  // a login wall nor a post with no video will change on a second attempt.
  error.name = noVideo
    ? 'NoVideoInPost'
    : rateLimited
      ? // Deliberately not DownloadFailed: that name is in the pipeline's retry
        // list, and retrying a rate limit sends more of exactly what tripped it.
        'InstagramRateLimited'
      : loginWalled
        ? 'InstagramLoginWall'
        : 'DownloadFailed';
  return error;
}
