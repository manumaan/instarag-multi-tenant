import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import { callerId, handler, notFound, pathParam } from '../shared/http';
import { hasSaved } from '../shared/saves';
import type { MediaRecord } from '../shared/media';

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET!;
const TRANSCRIPT_SEGMENTS_TABLE = process.env.TRANSCRIPT_SEGMENTS_TABLE!;
const URL_TTL_SECONDS = 900;

/** GET /media/{id} — record, playback URL, keyframe filmstrip and transcript. */
export const main = handler(async (event) => {
  const id = pathParam(event, 'id');

  /*
   * Not found, deliberately, rather than forbidden: a caller who has not saved
   * a reel should not be able to learn whether it exists by asking. The content
   * is shared, so "exists" and "yours" are different questions and only one of
   * them is answerable.
   */
  if (!(await hasSaved(callerId(event), id))) throw notFound('media not found');

  const result = await ddb.send(new GetCommand({ TableName: TABLES.media, Key: { id } }));
  const media = result.Item as MediaRecord | undefined;
  if (!media) throw notFound('media not found');

  const [framesResult, segmentsResult] = await Promise.all([
    ddb.send(
      new QueryCommand({
        TableName: TABLES.frames,
        KeyConditionExpression: 'media_id = :id',
        ExpressionAttributeValues: { ':id': id },
      }),
    ),
    ddb.send(
      new QueryCommand({
        TableName: TRANSCRIPT_SEGMENTS_TABLE,
        KeyConditionExpression: 'media_id = :id',
        ExpressionAttributeValues: { ':id': id },
      }),
    ),
  ]);

  const frames = await Promise.all(
    (framesResult.Items ?? []).map(async (frame) => ({
      ...frame,
      url: frame.s3_key
        ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: frame.s3_key as string }), {
            expiresIn: URL_TTL_SECONDS,
          })
        : undefined,
    })),
  );

  const playbackUrl =
    media.s3_key && media.status !== 'awaiting_upload'
      ? await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: media.s3_key }), {
          expiresIn: URL_TTL_SECONDS,
        })
      : undefined;

  return {
    media,
    frames,
    transcriptSegments: segmentsResult.Items ?? [],
    playbackUrl,
    expiresIn: URL_TTL_SECONDS,
  };
});
