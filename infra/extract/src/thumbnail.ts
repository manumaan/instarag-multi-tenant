import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { convertThumbnail, readFrame } from './ffmpeg';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const BUCKET = process.env.MEDIA_BUCKET!;
const MEDIA_TABLE = process.env.MEDIA_TABLE!;

export const thumbnailKey = (mediaId: string) => `media/${mediaId}/thumb.jpg`;

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

    const key = thumbnailKey(mediaId);
    await s3.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'image/jpeg' }),
    );
    await ddb.send(
      new UpdateCommand({
        TableName: MEDIA_TABLE,
        Key: { id: mediaId },
        UpdateExpression: 'SET thumb_s3_key = :key',
        ExpressionAttributeValues: { ':key': key },
        // Never resurrect a record deleted while this ran.
        ConditionExpression: 'attribute_exists(id)',
      }),
    );

    console.log('thumbnail written', { mediaId, key, bytes: body.length });
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
export async function handler(event: { mediaId: string }): Promise<{ mediaId: string; key?: string }> {
  const { mediaId } = event;
  if (!mediaId) throw new Error('mediaId is required');

  const record = await ddb.send(new GetCommand({ TableName: MEDIA_TABLE, Key: { id: mediaId } }));
  const media = record.Item as { cover_s3_key?: string; s3_key?: string } | undefined;
  if (!media) throw new Error(`media ${mediaId} not found`);

  // Same fallback the library grid uses for items older than cover_s3_key.
  const cover = media.cover_s3_key ?? (media.s3_key ? `media/${mediaId}/frames/00000000.jpg` : undefined);
  if (!cover) return { mediaId };

  return { mediaId, key: await writeThumbnail(mediaId, cover) };
}
