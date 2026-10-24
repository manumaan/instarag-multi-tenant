import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { FRAME_THUMB_LONGEST_EDGE, THUMB_SMALL_LONGEST_EDGE, convertThumbnail, readFrame } from './ffmpeg';
import { mapWithConcurrency } from './concurrency';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const BUCKET = process.env.MEDIA_BUCKET!;
const MEDIA_TABLE = process.env.MEDIA_TABLE!;
const FRAMES_TABLE = process.env.FRAMES_TABLE!;

export const thumbnailKey = (mediaId: string) => `media/${mediaId}/thumb.jpg`;
/** A keyframe's filmstrip copy, beside it under frames/ so purge and delete treat them alike. */
export const frameThumbKey = (mediaId: string, tsMs: number) =>
  `media/${mediaId}/frames/small/${String(tsMs).padStart(8, '0')}.jpg`;

/** Writes one keyframe's filmstrip copy from a local JPEG and returns its key. */
export async function writeFrameThumb(sourceFile: string, mediaId: string, tsMs: number): Promise<string> {
  const out = `${sourceFile}.small.jpg`;
  await convertThumbnail(sourceFile, out, FRAME_THUMB_LONGEST_EDGE);
  const key = frameThumbKey(mediaId, tsMs);
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: await readFrame(out), ContentType: 'image/jpeg' }));
  return key;
}

/**
 * Backfill: filmstrip copies for a reel's existing keyframes. Only the rows
 * gain a key; descriptions and OCR on them are left exactly as they are.
 */
async function backfillFrameThumbs(mediaId: string): Promise<number> {
  const rows = await ddb.send(
    new QueryCommand({
      TableName: FRAMES_TABLE,
      KeyConditionExpression: 'media_id = :id',
      ExpressionAttributeValues: { ':id': mediaId },
    }),
  );
  const todo = (rows.Items ?? []).filter((f) => f.s3_key && !f.thumb_s3_key && f.kind !== 'slide');
  const workDir = await mkdtemp(path.join(tmpdir(), `frame-thumbs-${mediaId}-`));
  try {
    await mapWithConcurrency(todo, 4, async (frame) => {
      const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: frame.s3_key as string }));
      const source = path.join(workDir, `${frame.ts_ms}.jpg`);
      await writeFile(source, await object.Body!.transformToByteArray());
      const key = await writeFrameThumb(source, mediaId, frame.ts_ms as number);
      await ddb.send(
        new UpdateCommand({
          TableName: FRAMES_TABLE,
          Key: { media_id: mediaId, ts_ms: frame.ts_ms },
          UpdateExpression: 'SET thumb_s3_key = :key',
          ExpressionAttributeValues: { ':key': key },
          ConditionExpression: 'attribute_exists(media_id)',
        }),
      );
    });
    return todo.length;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** The phone's tile image (see THUMB_SMALL_LONGEST_EDGE). */
export const smallThumbnailKey = (mediaId: string) => `media/${mediaId}/thumb-s.jpg`;

/**
 * Writes the library grid's image for one item.
 *
 * The grid used to presign the cover frame itself, which is sized for a
 * different job: 720px for a reel keyframe, and 1568px for a carousel slide
 * because the vision pass reads body text off it. Drawn into a ~250px tile that
 * is 3x more pixels than any screen shows, and the whole library came to
 * 1.22 MB for fourteen tiles.
 *
 * Best effort by design: a reel with no thumbnail still renders, because the
 * grid falls back to the cover. Failing an ingest over a grid image would be
 * the wrong trade.
 */
export async function writeThumbnail(mediaId: string, sourceKey: string): Promise<string | undefined> {
  const workDir = await mkdtemp(path.join(tmpdir(), `thumb-${mediaId}-`));
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: sourceKey }));
    const source = path.join(workDir, 'source.jpg');
    await writeFile(source, await object.Body!.transformToByteArray());

    const out = path.join(workDir, 'thumb.jpg');
    await convertThumbnail(source, out);
    const body = await readFrame(out);
    const smallOut = path.join(workDir, 'thumb-s.jpg');
    await convertThumbnail(source, smallOut, THUMB_SMALL_LONGEST_EDGE);
    const smallBody = await readFrame(smallOut);

    const key = thumbnailKey(mediaId);
    const smallKey = smallThumbnailKey(mediaId);
    await Promise.all([
      s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'image/jpeg' })),
      s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: smallKey, Body: smallBody, ContentType: 'image/jpeg' })),
    ]);
    await ddb.send(
      new UpdateCommand({
        TableName: MEDIA_TABLE,
        Key: { id: mediaId },
        UpdateExpression: 'SET thumb_s3_key = :key, thumb_small_s3_key = :small',
        ExpressionAttributeValues: { ':key': key, ':small': smallKey },
        // Never resurrect a record deleted while this ran.
        ConditionExpression: 'attribute_exists(id)',
      }),
    );

    console.log('thumbnail written', { mediaId, key, bytes: body.length, smallBytes: smallBody.length });
    return key;
  } catch (err) {
    console.warn('thumbnail failed; the grid will fall back to the cover frame', { mediaId, err });
    return undefined;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * The same work as a handler, so items ingested before thumbnails existed can
 * be backfilled without re-running extraction — which would rewrite their frame
 * rows and throw away the analysis on them.
 */
export async function handler(event: {
  mediaId: string;
  /** Backfill the keyframes' filmstrip copies instead of the grid image. */
  frames?: boolean;
}): Promise<{ mediaId: string; key?: string; frameThumbs?: number }> {
  const { mediaId } = event;
  if (!mediaId) throw new Error('mediaId is required');
  if (event.frames) return { mediaId, frameThumbs: await backfillFrameThumbs(mediaId) };

  const record = await ddb.send(new GetCommand({ TableName: MEDIA_TABLE, Key: { id: mediaId } }));
  const media = record.Item as { cover_s3_key?: string; s3_key?: string } | undefined;
  if (!media) throw new Error(`media ${mediaId} not found`);

  // Same fallback the library grid uses for items older than cover_s3_key.
  const cover = media.cover_s3_key ?? (media.s3_key ? `media/${mediaId}/frames/00000000.jpg` : undefined);
  if (!cover) return { mediaId };

  return { mediaId, key: await writeThumbnail(mediaId, cover) };
}
