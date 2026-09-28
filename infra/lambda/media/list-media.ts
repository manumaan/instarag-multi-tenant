import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES, MEDIA_BY_CREATED_AT, MEDIA_ENTITY, decodeCursor, encodeCursor } from '../shared/ddb';
import { handler } from '../shared/http';
import type { MediaRecord } from '../shared/media';

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET!;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const URL_TTL_SECONDS = 900;

/** GET /media?limit&cursor — newest-first library listing. */
export const main = handler(async (event) => {
  const limitParam = Number(event.queryStringParameters?.limit);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLES.media,
      IndexName: MEDIA_BY_CREATED_AT,
      KeyConditionExpression: '#entity = :entity',
      ExpressionAttributeNames: { '#entity': 'entity' },
      ExpressionAttributeValues: { ':entity': MEDIA_ENTITY },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: decodeCursor(event.queryStringParameters?.cursor),
    }),
  );

  const items = (result.Items ?? []) as MediaRecord[];

  return {
    items: await Promise.all(items.map(withThumbnail)),
    cursor: encodeCursor(result.LastEvaluatedKey),
  };
});

/**
 * The cover frame's key is written onto the record during extraction, so the
 * grid costs one presign per row and no extra query. Presigning is local
 * signing, not a call, so doing it for a page of rows is cheap.
 *
 * `cover_s3_key` predates nothing: reels extracted before it existed fall back
 * to the cover's deterministic key, which is always the frame at 0ms.
 */
async function withThumbnail(media: MediaRecord): Promise<MediaRecord & { thumbnailUrl?: string }> {
  // Thumbnail first, then the cover frame, then the deterministic cover key.
  // Each fallback is a generation of this record: items ingested before
  // thumbnails existed, and before cover_s3_key existed, both still render.
  const key =
    media.thumb_s3_key ??
    media.cover_s3_key ??
    (media.s3_key ? `media/${media.id}/frames/00000000.jpg` : undefined);
  if (!key) return media;
  return {
    ...media,
    thumbnailUrl: await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
      expiresIn: URL_TTL_SECONDS,
    }),
  };
}
