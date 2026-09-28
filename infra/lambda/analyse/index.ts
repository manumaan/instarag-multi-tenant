import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { claude } from '../shared/claude';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { ddb, TABLES } from '../shared/ddb';
import { tsMsToSlide, type MediaRecord } from '../shared/media';
import { AnalysisSchema, captionFacts, reconcileFrames, sanitisePlaces, type Analysis } from './schema';
import { buildInstruction } from './prompt';
import { recordUsage } from '../shared/usage';

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET!;
const CAPTION_FACTS_TABLE = process.env.CAPTION_FACTS_TABLE!;

/**
 * Bedrock serves these models only through cross-region inference profiles
 * (the `us.` prefix), and only via the bedrock-runtime path on this account —
 * the newer Mantle endpoint has neither model. Configurable so switching
 * models is a redeploy, not a code change.
 */
const MODEL_ID = process.env.ANALYSIS_MODEL_ID!;
const EFFORT = (process.env.ANALYSIS_EFFORT ?? 'medium') as 'low' | 'medium' | 'high';
const MAX_TOKENS = Number(process.env.ANALYSIS_MAX_TOKENS ?? 16000);


export interface AnalyseEvent {
  mediaId: string;
}

export interface AnalyseResult {
  mediaId: string;
  frameCount: number;
  placeCount: number;
  groundedPlaceCount: number;
  missingFrames: number[];
  inputTokens: number;
  outputTokens: number;
}

/** One Bedrock call per reel: every keyframe in one request, in timestamp order. */
export async function handler(event: AnalyseEvent): Promise<AnalyseResult> {
  const { mediaId } = event;
  if (!mediaId) throw new Error('mediaId is required');

  const record = await ddb.send(new GetCommand({ TableName: TABLES.media, Key: { id: mediaId } }));
  const media = record.Item as MediaRecord | undefined;
  if (!media) throw new Error(`media ${mediaId} not found`);

  const frameRows = await ddb.send(
    new QueryCommand({
      TableName: TABLES.frames,
      KeyConditionExpression: 'media_id = :id',
      ExpressionAttributeValues: { ':id': mediaId },
    }),
  );
  const frames = (frameRows.Items ?? [])
    .filter((f) => typeof f.s3_key === 'string')
    .sort((a, b) => Number(a.ts_ms) - Number(b.ts_ms));
  if (frames.length === 0) throw new Error(`media ${mediaId} has no frames to analyse`);

  const sentTimestamps = frames.map((f) => Number(f.ts_ms));

  // Each image is preceded by its timestamp so the model can key its output by
  // the same values, which is what makes {media_id, ts_ms} citations possible.
  const isCarousel = media.type === 'carousel';
  const content: Array<Record<string, unknown>> = [];
  for (const frame of frames) {
    content.push({
      type: 'text',
      text: isCarousel
        ? `slide ${tsMsToSlide(Number(frame.ts_ms))} (ts_ms=${frame.ts_ms})`
        : `frame ts_ms=${frame.ts_ms}`,
    });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: await fetchFrame(frame.s3_key as string) },
    });
  }
  content.push({
    type: 'text',
    text: buildInstruction({
      caption: media.caption_normalized ?? media.caption_raw,
      permalink: media.permalink,
      isCarousel,
    }),
  });

  const response = await (await claude()).messages.parse({
    model: MODEL_ID,
    max_tokens: MAX_TOKENS,
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT, format: zodOutputFormat(AnalysisSchema) },
    messages: [{ role: 'user', content: content as never }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('the model declined to analyse this reel');
  }
  recordUsage('analyse', MODEL_ID, response.usage);

  const analysis = response.parsed_output as Analysis | null;
  if (!analysis) throw new Error(`model returned no parsable analysis (stop_reason ${response.stop_reason})`);

  const { matched, missing, unexpected } = reconcileFrames(analysis.frames, sentTimestamps);
  const places = sanitisePlaces(analysis.places, sentTimestamps);

  await writeFrameAnalysis(mediaId, matched);
  const readFromFrames = analysis.caption_from_frames?.trim();
  const caption = media.caption_normalized ?? media.caption_raw ?? (readFromFrames || undefined);
  await writeCaptionFacts(mediaId, caption, analysis, places);
  await writeMediaAnalysis(mediaId, analysis, places, caption, Boolean(media.caption_raw));

  const result: AnalyseResult = {
    mediaId,
    frameCount: matched.length,
    placeCount: places.length,
    groundedPlaceCount: places.filter((p) => p.basis === 'read_from_frame').length,
    missingFrames: missing,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
  // Logged per reel so spend is observable before the Phase 7 cap exists.
  console.log('analysed', { ...result, unexpectedFrames: unexpected, model: MODEL_ID });
  return result;
}

async function fetchFrame(key: string): Promise<string> {
  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await object.Body!.transformToByteArray()).toString('base64');
}

async function writeFrameAnalysis(mediaId: string, frames: Analysis['frames']) {
  // Updates, not BatchWrite puts: the extractor already wrote s3_key and phash
  // on these rows and a put would drop them.
  await Promise.all(
    frames.map((frame) =>
      ddb.send(
        new UpdateCommand({
          TableName: TABLES.frames,
          Key: { media_id: mediaId, ts_ms: frame.ts_ms },
          UpdateExpression: 'SET description = :d, ocr_text = :o, analysed_at = :t',
          ExpressionAttributeValues: {
            ':d': frame.description,
            ':o': frame.ocr_text,
            ':t': new Date().toISOString(),
          },
          ConditionExpression: 'attribute_exists(media_id)',
        }),
      ),
    ),
  );
}

async function writeCaptionFacts(
  mediaId: string,
  caption: string | undefined,
  analysis: Analysis,
  places: Analysis['places'],
) {
  const { hashtags, mentions } = captionFacts(caption);
  await ddb.send(
    new PutCommand({
      TableName: CAPTION_FACTS_TABLE,
      Item: {
        media_id: mediaId,
        hashtags,
        mentions,
        entities: analysis.entities,
        places,
        language: analysis.language,
        cta: analysis.cta,
        updated_at: new Date().toISOString(),
      },
    }),
  );
}

async function writeMediaAnalysis(
  mediaId: string,
  analysis: Analysis,
  places: Analysis['places'],
  caption: string | undefined,
  hadCaption: boolean,
) {
  const sets = ['analysis_summary = :summary', 'places = :places', 'analysed_at = :now'];
  const values: Record<string, unknown> = {
    ':summary': analysis.reel_summary,
    ':places': places,
    ':now': new Date().toISOString(),
  };

  // A caption read off the frames is only written when we did not already have one.
  if (!hadCaption && caption) {
    sets.push('caption_raw = :raw', 'caption_normalized = :norm', 'caption_source = :source');
    values[':raw'] = caption;
    values[':norm'] = caption;
    values[':source'] = 'frames';
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
}
