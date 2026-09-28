import { HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { BatchWriteCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import { badRequest, handler, notFound, pathParam } from '../shared/http';
import type { MediaRecord } from '../shared/media';

const s3 = new S3Client({});
const sfn = new SFNClient({});
const BUCKET = process.env.MEDIA_BUCKET!;
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;
const THUMBNAIL_FUNCTION_ARN = process.env.THUMBNAIL_FUNCTION_ARN;

const lambda = new LambdaClient({});
const FRAMES_TABLE = process.env.FRAMES_TABLE!;
/** How long a job row survives before the jobs table's TTL removes it. */
const JOB_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * POST /media/{id}/complete — the browser finished its presigned PUT.
 * Verifies the object really landed, then moves the item to `queued`.
 */
export const main = handler(async (event) => {
  const id = pathParam(event, 'id');

  const existing = await ddb.send(new GetCommand({ TableName: TABLES.media, Key: { id } }));
  const media = existing.Item as MediaRecord | undefined;
  if (!media) throw notFound('media not found');
  if (media.type !== 'carousel' && !media.s3_key) {
    throw badRequest('media has no upload to complete');
  }
  if (media.status !== 'awaiting_upload') return media; // idempotent

  // A carousel has no single original: its slides are already the frames, so
  // completion registers them rather than checking one object.
  if (media.type === 'carousel') return completeCarousel(id, media);

  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: media.s3_key }));
  } catch {
    throw badRequest('upload not found in the media store; retry the PUT');
  }

  // Defence in depth behind the signed content-type: never hand Phase 2's
  // ffmpeg an object whose real type is not the one we recorded.
  if (head.ContentType && media.content_type && head.ContentType !== media.content_type) {
    throw badRequest(`uploaded object is ${head.ContentType}, expected ${media.content_type}`);
  }
  if (!head.ContentLength) throw badRequest('uploaded object is empty');

  const updated = await ddb.send(
    new UpdateCommand({
      TableName: TABLES.media,
      Key: { id },
      UpdateExpression: 'SET #status = :queued, #bytes = :bytes',
      ExpressionAttributeNames: { '#status': 'status', '#bytes': 'bytes' },
      ExpressionAttributeValues: { ':queued': 'queued', ':bytes': head.ContentLength ?? media.bytes },
      ReturnValues: 'ALL_NEW',
    }),
  );

  // Analysis runs on ingest: the pipeline owns every status after `queued`.
  if (STATE_MACHINE_ARN) {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        // Execution names must be unique; a retried completion starts a fresh run.
        name: `${id}-${Date.now()}`,
        input: JSON.stringify({
          mediaId: id,
          source: media.source,
          // A string, because the state machine writes it as a DynamoDB 'N'.
          jobExpiresAt: String(Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS),
        }),
      }),
    );
  }

  return updated.Attributes as MediaRecord;
});

/**
 * Registers a carousel's uploaded slides as frames and starts the pipeline
 * past extraction: there is no video to extract from, the images *are* the
 * frames.
 */
async function completeCarousel(id: string, media: MediaRecord) {
  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `media/${id}/frames/` }),
  );
  const objects = (listed.Contents ?? [])
    .filter((object) => (object.Size ?? 0) > 0)
    .sort((a, b) => String(a.Key).localeCompare(String(b.Key)));

  if (objects.length === 0) throw badRequest('no slides were uploaded; retry the PUTs');

  const now = new Date().toISOString();
  const rows = objects.map((object, index) => ({
    PutRequest: {
      Item: {
        media_id: id,
        // The key encodes the slide's ts_ms, so parse it rather than assume the
        // listing order matches what was presigned.
        ts_ms: Number(String(object.Key).split('/').pop()!.split('.')[0]),
        s3_key: object.Key,
        kind: 'slide',
        slide_index: index,
        created_at: now,
      },
    },
  }));
  for (let i = 0; i < rows.length; i += 25) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [FRAMES_TABLE]: rows.slice(i, i + 25) } }));
  }

  const updated = await ddb.send(
    new UpdateCommand({
      TableName: TABLES.media,
      Key: { id },
      UpdateExpression: 'SET #status = :queued, slide_count = :count, cover_s3_key = :cover',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':queued': 'queued',
        ':count': objects.length,
        ':cover': objects[0].Key,
      },
      ReturnValues: 'ALL_NEW',
    }),
  );

  /*
   * The grid's thumbnail, from the one handler in this stack that has ffmpeg.
   * Uploaded slides never touch the extractor — this path only lists S3 and
   * writes rows — so without this the grid falls back to a full-size slide,
   * which for a carousel is the 1568px image the vision pass reads text off.
   *
   * Fire and forget, and failures are swallowed: an upload must not fail over
   * a grid image, and the fallback still renders.
   */
  if (THUMBNAIL_FUNCTION_ARN) {
    try {
      await lambda.send(
        new InvokeCommand({
          FunctionName: THUMBNAIL_FUNCTION_ARN,
          InvocationType: 'Event',
          Payload: Buffer.from(JSON.stringify({ mediaId: id })),
        }),
      );
    } catch (err) {
      console.warn('could not queue the thumbnail; the grid will use the cover', { id, err });
    }
  }

  if (STATE_MACHINE_ARN) {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: `${id}-${Date.now()}`,
        input: JSON.stringify({
          mediaId: id,
          source: media.source,
          // Skips download, extraction and transcription: slides are frames
          // already, and a carousel has no audio.
          kind: 'carousel',
          jobExpiresAt: String(Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS),
        }),
      }),
    );
  }

  return updated.Attributes as MediaRecord;
}
