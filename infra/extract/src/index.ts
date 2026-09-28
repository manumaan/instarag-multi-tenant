import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { writeThumbnail } from './thumbnail';
import { dedupeByPhash, phash } from './phash';
import { mapWithConcurrency } from './concurrency';
import {
  convertStill,
  extractAudio,
  extractSceneFrames,
  frameAt,
  grayscalePlane,
  probe,
  readFrame,
} from './ffmpeg';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const BUCKET = process.env.MEDIA_BUCKET!;
const MEDIA_TABLE = process.env.MEDIA_TABLE!;
const FRAMES_TABLE = process.env.FRAMES_TABLE!;

/** Keyframe spec. Tunable by cost budget; see the README. */
const SCENE_THRESHOLD = Number(process.env.SCENE_THRESHOLD ?? 0.35);
const MAX_FRAMES = Number(process.env.MAX_FRAMES ?? 12);
const PHASH_THRESHOLD = Number(process.env.PHASH_THRESHOLD ?? 8);
/** Below this many scene cuts a longer clip gets evenly sampled instead. */
const MIN_SCENE_FRAMES = 3;
const SAMPLE_IF_LONGER_THAN_MS = 6000;
/**
 * ffmpeg passes in flight while hashing candidates. Each is a short process
 * doing little work, so serialising them spent most of the stage on process
 * startup; the cap keeps a long reel from oversubscribing the CPU.
 */
const HASH_CONCURRENCY = Number(process.env.HASH_CONCURRENCY ?? 4);

export interface ExtractEvent {
  mediaId: string;
}

export interface ExtractResult {
  mediaId: string;
  frameCount: number;
  candidateCount: number;
  durationMs: number;
  strategy: 'still' | 'scene' | 'scene+sampled';
  /** Drives the pipeline's choice of whether to transcribe. */
  hasAudio: boolean;
  audioS3Key?: string;
}

interface Candidate {
  tsMs: number;
  file: string;
  phash: string;
  kind: 'cover' | 'scene' | 'sample';
}

export async function handler(event: ExtractEvent): Promise<ExtractResult> {
  const { mediaId } = event;
  if (!mediaId) throw new Error('mediaId is required');

  const record = await ddb.send(new GetCommand({ TableName: MEDIA_TABLE, Key: { id: mediaId } }));
  const media = record.Item as { s3_key?: string; content_type?: string } | undefined;
  if (!media) throw new Error(`media ${mediaId} not found`);
  if (!media.s3_key) throw new Error(`media ${mediaId} has no stored object to extract from`);

  const workDir = await mkdtemp(path.join(tmpdir(), `extract-${mediaId}-`));
  try {
    const input = path.join(workDir, path.basename(media.s3_key));
    await downloadToFile(media.s3_key, input);

    const isVideo = media.content_type?.startsWith('video/') ?? true;
    const { candidates, durationMs, strategy, hasAudio } = isVideo
      ? await videoCandidates(input, workDir)
      : await stillCandidates(input, workDir);

    // The speech track is pulled here because this is the one place that
    // already has the decoded input and ffmpeg to hand.
    let audioS3Key: string | undefined;
    if (hasAudio) {
      const audioFile = path.join(workDir, 'audio.m4a');
      await extractAudio(input, audioFile);
      audioS3Key = `media/${mediaId}/audio.m4a`;
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: audioS3Key,
          Body: await readFrame(audioFile),
          ContentType: 'audio/mp4',
        }),
      );
    }

    const kept = dedupeByPhash(candidates, PHASH_THRESHOLD, MAX_FRAMES);
    await storeFrames(mediaId, kept);
    await recordCover(mediaId, kept[0]);

    console.log('extracted', {
      mediaId,
      strategy,
      candidates: candidates.length,
      kept: kept.length,
      durationMs,
      hasAudio,
    });
    return {
      mediaId,
      frameCount: kept.length,
      candidateCount: candidates.length,
      durationMs,
      strategy,
      hasAudio,
      audioS3Key,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function stillCandidates(input: string, workDir: string) {
  const still = await convertStill(input, path.join(workDir, 'cover.jpg'));
  return {
    candidates: [{ ...still, phash: phash(await grayscalePlane(still.file)), kind: 'cover' as const }],
    durationMs: 0,
    strategy: 'still' as const,
    hasAudio: false,
  };
}

async function videoCandidates(input: string, workDir: string) {
  const { durationMs, hasAudio } = await probe(input);

  // The cover always survives dedupe, so it goes first.
  const cover = await frameAt(input, 0, path.join(workDir, 'cover.jpg'));
  const sceneFrames = await extractSceneFrames(input, workDir, SCENE_THRESHOLD);

  let strategy: ExtractResult['strategy'] = 'scene';
  let extra: Array<{ tsMs: number; file: string; kind: Candidate['kind'] }> = sceneFrames.map((f) => ({
    ...f,
    kind: 'scene' as const,
  }));

  // A talking-head reel can have no cuts at all; even sampling still gives Ask
  // something to work with.
  if (sceneFrames.length < MIN_SCENE_FRAMES && durationMs > SAMPLE_IF_LONGER_THAN_MS) {
    strategy = 'scene+sampled';
    const step = Math.floor(durationMs / MAX_FRAMES);
    const indices = Array.from({ length: MAX_FRAMES - 1 }, (_, i) => i + 1);
    const sampled = await mapWithConcurrency(indices, HASH_CONCURRENCY, async (i) => ({
      ...(await frameAt(input, step * i, path.join(workDir, `sample-${String(i).padStart(4, '0')}.jpg`))),
      kind: 'sample' as const,
    }));
    extra = [...extra, ...sampled].sort((a, b) => a.tsMs - b.tsMs);
  }

  const hashed = await mapWithConcurrency(
    [{ ...cover, kind: 'cover' as const }, ...extra],
    HASH_CONCURRENCY,
    async (frame) => ({ ...frame, phash: phash(await grayscalePlane(frame.file)) }),
  );
  const candidates: Candidate[] = hashed;

  return { candidates, durationMs, strategy, hasAudio };
}

async function downloadToFile(key: string, destination: string) {
  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const body = await object.Body!.transformToByteArray();
  await writeFile(destination, body);
}

async function storeFrames(mediaId: string, frames: Candidate[]) {
  const items = [];
  for (const frame of frames) {
    const key = `media/${mediaId}/frames/${String(frame.tsMs).padStart(8, '0')}.jpg`;
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: await readFrame(frame.file),
        ContentType: 'image/jpeg',
      }),
    );
    items.push({
      PutRequest: {
        Item: {
          media_id: mediaId,
          ts_ms: frame.tsMs,
          s3_key: key,
          phash: frame.phash,
          kind: frame.kind,
          created_at: new Date().toISOString(),
        },
      },
    });
  }

  for (let i = 0; i < items.length; i += 25) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [FRAMES_TABLE]: items.slice(i, i + 25) } }));
  }
}

/**
 * Stores the cover frame's key on the media record so the library grid can
 * presign one thumbnail per row without querying the frames table per row.
 */
async function recordCover(mediaId: string, cover: Candidate | undefined) {
  if (!cover) return;
  const key = `media/${mediaId}/frames/${String(cover.tsMs).padStart(8, '0')}.jpg`;
  await ddb.send(
    new UpdateCommand({
      TableName: MEDIA_TABLE,
      Key: { id: mediaId },
      UpdateExpression: 'SET cover_s3_key = :key',
      ExpressionAttributeValues: { ':key': key },
      ConditionExpression: 'attribute_exists(id)',
    }),
  );
  // The grid draws a ~250px tile; the cover is 720px. Give it its own image.
  await writeThumbnail(mediaId, key);
}
