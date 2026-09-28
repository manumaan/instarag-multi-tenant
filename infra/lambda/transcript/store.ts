import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import {
  detectedLanguage,
  fullTranscript,
  mergeShortSegments,
  parseSegments,
  splitLongSegments,
  type TranscribeOutput,
} from './parse';

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET!;
const SEGMENTS_TABLE = process.env.TRANSCRIPT_SEGMENTS_TABLE!;

export interface StoreEvent {
  mediaId: string;
  /** Where Transcribe wrote its JSON. */
  transcriptKey: string;
}

export interface StoreResult {
  mediaId: string;
  segmentCount: number;
  language?: string;
  characters: number;
}

/** Reads Transcribe's output and stores citable segments. */
export async function handler(event: StoreEvent): Promise<StoreResult> {
  const { mediaId, transcriptKey } = event;
  if (!mediaId || !transcriptKey) throw new Error('mediaId and transcriptKey are required');

  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: transcriptKey }));
  const output = JSON.parse(await object.Body!.transformToString()) as TranscribeOutput;

  // Split first, then merge: splitting can leave a short tail that belongs
  // with its neighbour.
  const segments = mergeShortSegments(splitLongSegments(parseSegments(output)));
  const transcript = fullTranscript(output);
  const language = detectedLanguage(output);

  await Promise.all(
    segments.map((segment) =>
      ddb.send(
        new PutCommand({
          TableName: SEGMENTS_TABLE,
          Item: { media_id: mediaId, start_ms: segment.start_ms, end_ms: segment.end_ms, text: segment.text },
        }),
      ),
    ),
  );

  const sets = ['transcript = :t', 'transcript_segment_count = :n'];
  const values: Record<string, unknown> = { ':t': transcript, ':n': segments.length };
  if (language) {
    sets.push('spoken_language = :lang');
    values[':lang'] = language;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: TABLES.media,
      Key: { id: mediaId },
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeValues: values,
      ConditionExpression: 'attribute_exists(id)',
    }),
  );

  const result = { mediaId, segmentCount: segments.length, language, characters: transcript.length };
  console.log('transcript stored', result);
  return result;
}
