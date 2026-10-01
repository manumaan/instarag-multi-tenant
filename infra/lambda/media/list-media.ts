import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES, decodeCursor, encodeCursor } from '../shared/ddb';
import { callerId, handler } from '../shared/http';
import { SAVES_BY_SAVED_AT } from '../shared/saves';
import type { MediaRecord } from '../shared/media';

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET!;
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const URL_TTL_SECONDS = 900;

/**
 * GET /media?limit&cursor — the caller's library, newest save first.
 *
 * Two steps, because a library is a set of saves over shared content: page the
 * caller's saves, then fetch the content those point at. Ordering lives on the
 * save, not the reel — you see things in the order *you* took them, which is
 * also why the same reel can sit in two people's libraries at different places.
 */
export const main = handler(async (event) => {
  const userId = callerId(event);
  const limitParam = Number(event.queryStringParameters?.limit);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;
  // The phone asks for its smaller tile image; the web keeps the 520px one.
  const small = event.queryStringParameters?.size === 'small';

  const saves = await ddb.send(
    new QueryCommand({
      TableName: TABLES.saves,
      IndexName: SAVES_BY_SAVED_AT,
      KeyConditionExpression: 'user_id = :u',
      ExpressionAttributeValues: { ':u': userId },
      ScanIndexForward: false,
      Limit: limit,
      ExclusiveStartKey: decodeCursor(event.queryStringParameters?.cursor),
    }),
  );

  const ids = (saves.Items ?? []).map((save) => String(save.media_id));
  if (ids.length === 0) return { items: [], cursor: undefined };

  const fetched = await ddb.send(
    new BatchGetCommand({ RequestItems: { [TABLES.media]: { Keys: ids.map((id) => ({ id })) } } }),
  );
  const byId = new Map(
    ((fetched.Responses?.[TABLES.media] ?? []) as MediaRecord[]).map((record) => [record.id, record]),
  );

  // Ordered by the save, and skipping any whose content has gone: a save that
  // outlives its reel is a row to ignore, not an error to raise.
  const items = ids.flatMap((id) => {
    const record = byId.get(id);
    return record ? [record] : [];
  });

  return {
    items: await Promise.all(items.map((item) => withThumbnail(item, small))),
    cursor: encodeCursor(saves.LastEvaluatedKey),
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
async function withThumbnail(media: MediaRecord, small = false): Promise<MediaRecord & { thumbnailUrl?: string }> {
  // Thumbnail first, then the cover frame, then the deterministic cover key.
  // Each fallback is a generation of this record: items ingested before
  // thumbnails existed, and before cover_s3_key existed, both still render.
  const key =
    (small ? media.thumb_small_s3_key : undefined) ??
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
