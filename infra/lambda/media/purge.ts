import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { BatchWriteCommand, DeleteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import { openSearchClient, INDEX_NAME } from '../search/client';

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET!;
const CAPTION_FACTS_TABLE = process.env.CAPTION_FACTS_TABLE!;
const TRANSCRIPT_SEGMENTS_TABLE = process.env.TRANSCRIPT_SEGMENTS_TABLE!;

export interface PurgeResult {
  framesRemoved: number;
  /** Carousels only: rows kept, analysis fields cleared. See keepFrames below. */
  framesReset: number;
  segmentsRemoved: number;
  removedFromIndex: number;
}

export interface PurgeOptions {
  /**
   * A carousel's slides are its source material, not pipeline output: the frame
   * rows hold the s3_key of each slide image and there is no video to
   * re-extract them from. Deleting them would leave a re-run with nothing to
   * analyse, so they are reset instead.
   */
  keepFrames?: boolean;
}

/**
 * Removes everything derived from a reel: frames, transcript segments, caption
 * facts and index documents.
 *
 * Shared by delete and retry. Retry needs it because a half-finished pipeline
 * leaves partial frames behind, and re-running over them would mix one run's
 * output with another's.
 */
export async function purgeDerived(mediaId: string, options: PurgeOptions = {}): Promise<PurgeResult> {
  const [frames, segmentsRemoved, removedFromIndex] = await Promise.all([
    options.keepFrames
      ? resetFrameAnalysis(mediaId)
      : clearRows(TABLES.frames, mediaId, 'media_id, ts_ms'),
    clearRows(TRANSCRIPT_SEGMENTS_TABLE, mediaId, 'media_id, start_ms'),
    deleteFromIndex(mediaId),
  ]);
  await ddb.send(new DeleteCommand({ TableName: CAPTION_FACTS_TABLE, Key: { media_id: mediaId } }));
  return {
    framesRemoved: options.keepFrames ? 0 : frames,
    framesReset: options.keepFrames ? frames : 0,
    segmentsRemoved,
    removedFromIndex,
  };
}

/** Frame images and, on a delete, the original. Keeps the prefix tidy. */
export async function purgeObjects(
  mediaId: string,
  options: { keepOriginal?: boolean; keepFrames?: boolean },
): Promise<number> {
  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `media/${mediaId}/` }),
  );
  const framesPrefix = `media/${mediaId}/frames/`;
  const keys = (listed.Contents ?? [])
    .map(({ Key }) => Key!)
    // A retry re-extracts from the original, so that one object stays.
    .filter((key) => !(options.keepOriginal && /\/original\.[a-z0-9]+$/.test(key)))
    // A carousel's slides live here and cannot be re-derived from anything.
    .filter((key) => !(options.keepFrames && key.startsWith(framesPrefix)));
  if (keys.length === 0) return 0;

  await s3.send(
    new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } }),
  );
  return keys.length;
}

/**
 * Clears what the vision pass wrote onto a carousel's slides, leaving the slide
 * rows themselves in place so the re-run still knows where the images are.
 */
async function resetFrameAnalysis(mediaId: string): Promise<number> {
  const rows = await ddb.send(
    new QueryCommand({
      TableName: TABLES.frames,
      KeyConditionExpression: 'media_id = :id',
      ExpressionAttributeValues: { ':id': mediaId },
      ProjectionExpression: 'media_id, ts_ms',
    }),
  );
  const items = rows.Items ?? [];
  await Promise.all(
    items.map((key) =>
      ddb.send(
        new UpdateCommand({
          TableName: TABLES.frames,
          Key: key,
          UpdateExpression: 'REMOVE #description, #ocr_text, #analysed_at',
          ExpressionAttributeNames: {
            '#description': 'description',
            '#ocr_text': 'ocr_text',
            '#analysed_at': 'analysed_at',
          },
          ConditionExpression: 'attribute_exists(media_id)',
        }),
      ),
    ),
  );
  return items.length;
}

async function clearRows(table: string, mediaId: string, keyAttributes: string): Promise<number> {
  const rows = await ddb.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: 'media_id = :id',
      ExpressionAttributeValues: { ':id': mediaId },
      ProjectionExpression: keyAttributes,
    }),
  );
  const items = rows.Items ?? [];
  for (let i = 0; i < items.length; i += 25) {
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: { [table]: items.slice(i, i + 25).map((key) => ({ DeleteRequest: { Key: key } })) },
      }),
    );
  }
  return items.length;
}

/**
 * By id from a search, not delete_by_query: OpenSearch Serverless does not
 * serve that endpoint, and the frame rows may already be gone.
 */
async function deleteFromIndex(mediaId: string): Promise<number> {
  const client = openSearchClient();
  let ids: string[];
  try {
    const found = await client.search({
      index: INDEX_NAME,
      body: { size: 500, _source: false, query: { term: { media_id: mediaId } } },
    });
    ids = ((found.body.hits.hits ?? []) as unknown as Array<{ _id: string }>).map((hit) => hit._id);
  } catch (err) {
    const type = (err as { meta?: { body?: { error?: { type?: string } } } }).meta?.body?.error?.type;
    if (type === 'index_not_found_exception') return 0;
    throw err;
  }
  if (ids.length === 0) return 0;

  const response = await client.bulk({
    body: ids.map((documentId) => ({ delete: { _index: INDEX_NAME, _id: documentId } })) as never,
  });
  const items = (response.body.items ?? []) as Array<Record<string, { status?: number }>>;
  return items.filter((item) => Object.values(item).some((op) => op.status === 200)).length;
}
