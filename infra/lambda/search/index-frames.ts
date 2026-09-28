import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import { mapWithConcurrency } from '../shared/concurrency';
import type { MediaRecord } from '../shared/media';
import { documentId, openSearchClient, INDEX_NAME, type IndexedDocument } from './client';
import { embed } from './embed';

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET!;
const CAPTION_FACTS_TABLE = process.env.CAPTION_FACTS_TABLE!;
const TRANSCRIPT_SEGMENTS_TABLE = process.env.TRANSCRIPT_SEGMENTS_TABLE!;
/**
 * Embeddings in flight at once. Each is an S3 read plus a Bedrock call and is
 * almost entirely network wait, so serialising them was the single slowest
 * thing in the pipeline. Capped so a long reel cannot trigger throttling.
 */
const EMBED_CONCURRENCY = Number(process.env.EMBED_CONCURRENCY ?? 8);

export interface IndexEvent {
  mediaId: string;
}

export interface IndexResult {
  mediaId: string;
  indexed: number;
  frames: number;
  speechSegments: number;
  skipped: number;
}

/**
 * Embeds every keyframe and writes one document per frame.
 *
 * Each vector covers the frame image *and* its description and OCR text
 * together, which is what lets one index serve both "find similar" from a
 * screenshot and a written question.
 */
export async function handler(event: IndexEvent): Promise<IndexResult> {
  const { mediaId } = event;
  if (!mediaId) throw new Error('mediaId is required');

  const [mediaResult, factsResult, frameRows, segmentRows] = await Promise.all([
    ddb.send(new GetCommand({ TableName: TABLES.media, Key: { id: mediaId } })),
    ddb.send(new GetCommand({ TableName: CAPTION_FACTS_TABLE, Key: { media_id: mediaId } })),
    ddb.send(
      new QueryCommand({
        TableName: TABLES.frames,
        KeyConditionExpression: 'media_id = :id',
        ExpressionAttributeValues: { ':id': mediaId },
      }),
    ),
    ddb.send(
      new QueryCommand({
        TableName: TRANSCRIPT_SEGMENTS_TABLE,
        KeyConditionExpression: 'media_id = :id',
        ExpressionAttributeValues: { ':id': mediaId },
      }),
    ),
  ]);

  const media = mediaResult.Item as MediaRecord | undefined;
  if (!media) throw new Error(`media ${mediaId} not found`);

  const caption = media.caption_normalized ?? media.caption_raw ?? '';
  const places = ((factsResult.Item?.places as Array<{ name?: string }> | undefined) ?? [])
    .map((place) => place.name)
    .filter(Boolean)
    .join(', ');

  const frames = (frameRows.Items ?? [])
    .filter((frame) => typeof frame.s3_key === 'string')
    .sort((a, b) => Number(a.ts_ms) - Number(b.ts_ms));

  const client = openSearchClient();
  let skipped = 0;

  const frameDocuments = await mapWithConcurrency(frames, EMBED_CONCURRENCY, async (frame) => {
    const description = (frame.description as string | undefined) ?? '';
    const ocrText = (frame.ocr_text as string | undefined) ?? '';
    // Without analysis there is nothing textual to match on; the image alone
    // still embeds, so index it rather than dropping the frame.
    if (!description && !ocrText) skipped += 1;

    const imageBase64 = await fetchFrame(frame.s3_key as string);
    const document: IndexedDocument = {
      media_id: mediaId,
      ts_ms: Number(frame.ts_ms),
      kind: 'frame',
      description,
      ocr_text: ocrText,
      speech: '',
      caption,
      places,
      taken_at: media.taken_at,
      embedding: await embed({
        imageBase64,
        text: [description, ocrText, places, caption].filter(Boolean).join('\n'),
      }),
    };
    return document;
  });

  // Speech segments embed from their text alone: there is no image for a spoken
  // moment, and Titan takes text on its own.
  const segments = (segmentRows.Items ?? [])
    .map((segment) => ({
      startMs: Number(segment.start_ms),
      endMs: Number(segment.end_ms ?? segment.start_ms),
      text: String(segment.text ?? '').trim(),
    }))
    .filter((segment) => segment.text)
    .sort((a, b) => a.startMs - b.startMs);

  const speechDocuments = await mapWithConcurrency(segments, EMBED_CONCURRENCY, async (segment) => {
    const document: IndexedDocument = {
      media_id: mediaId,
      ts_ms: segment.startMs,
      kind: 'speech',
      description: '',
      ocr_text: '',
      speech: segment.text,
      caption,
      places,
      taken_at: media.taken_at,
      end_ms: segment.endMs,
      embedding: await embed({ text: [segment.text, places].filter(Boolean).join('\n') }),
    };
    return document;
  });

  const operations: unknown[] = [];
  for (const document of [...frameDocuments, ...speechDocuments]) {
    operations.push({ index: { _index: INDEX_NAME, _id: documentId(mediaId, document.ts_ms, document.kind) } });
    operations.push(document);
  }

  const frameCount = frameDocuments.length;
  const speechCount = speechDocuments.length;
  if (operations.length === 0) {
    return { mediaId, indexed: 0, frames: 0, speechSegments: 0, skipped };
  }

  // No refresh param: OpenSearch Serverless rejects it ("true refresh policy is
  // not supported") and refreshes on its own within a few seconds.
  const response = await client.bulk({ body: operations as never });
  const errored = (response.body.items ?? []).filter((item: Record<string, { error?: unknown }>) =>
    Object.values(item).some((op) => op.error),
  );
  if (errored.length > 0) {
    throw new Error(`indexing failed for ${errored.length} frames: ${JSON.stringify(errored[0]).slice(0, 400)}`);
  }

  const result = {
    mediaId,
    indexed: operations.length / 2,
    frames: frameCount,
    speechSegments: speechCount,
    skipped,
  };
  console.log('indexed', result);
  return result;
}

async function fetchFrame(key: string): Promise<string> {
  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await object.Body!.transformToByteArray()).toString('base64');
}
