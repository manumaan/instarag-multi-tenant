import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { claude } from '../shared/claude';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import { badRequest, callerId, handler, parseJsonBody } from '../shared/http';
import { requireOwnLensKey } from '../shared/lens';
import { hasSaved } from '../shared/saves';
import { searchWeb, SearchNotConfigured, type WebResult } from './brave';
import { recordUsage } from '../shared/usage';

const s3 = new S3Client({});
const secrets = new SecretsManagerClient({});

const BUCKET = process.env.MEDIA_BUCKET!;
const MODEL_ID = process.env.ANSWER_MODEL_ID!;
const SEARCH_SECRET_ARN = process.env.SEARCH_SECRET_ARN!;

/**
 * Cached across invocations, because the key changes rarely and the call is not
 * free — but with a TTL, and never when empty. Caching an empty key would stick
 * for the container's whole life and keep reporting "not configured" after the
 * key had actually been set.
 */
let cached: { key: string; at: number } | undefined;
const KEY_TTL_MS = 5 * 60 * 1000;

const EntitiesSchema = z.object({
  query: z
    .string()
    .describe('the single web search query most likely to identify what is in this image'),
  entities: z
    .array(
      z.object({
        kind: z.enum(['product', 'brand', 'place', 'dish', 'on_screen_text', 'other']),
        value: z.string(),
        /** Keeps a guess from being presented as something read. */
        read_from_image: z.boolean().describe('true only when this appears as text in the image'),
      }),
    )
    .describe('what is identifiable in the image, most distinctive first'),
});

const AnswerSchema = z.object({
  answered: z.boolean().describe('false when the results do not identify it'),
  summary: z.string().describe('what the results say it is, or what is still unknown'),
  cited_urls: z.array(z.string()).describe('only urls from the results provided'),
});

/**
 * POST /lens/web — identify what is in a frame, then look it up.
 *
 * Two model calls with a search between them: extract entities from the image
 * under a schema, search the web for them, then summarise the results. The
 * summary is constrained to the results returned, so Lens reports what the web
 * says rather than what the model remembers.
 */
export const main = handler(async (event) => {
  const userId = callerId(event);
  const body = parseJsonBody<{ s3Key?: string; mediaId?: string; tsMs?: number }>(event);

  const imageBase64 = await loadImage(userId, body);
  const apiKey = await loadApiKey();

  const extraction = await (await claude()).messages.parse({
    model: MODEL_ID,
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: zodOutputFormat(EntitiesSchema) },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          {
            type: 'text',
            text: [
              'This is a frame from an Instagram reel.',
              'Identify what someone would want to look up: the product, brand, place or dish.',
              'Read any signage, labels or on-screen text verbatim, and set read_from_image true',
              'only for those. Build one search query that would identify it — include the place',
              'name or city when visible, because "a pastry" is not searchable and',
              '"Pierre Herme macaron Paris" is.',
            ].join('\n'),
          },
        ],
      },
    ],
  });

  recordUsage('lens-extract', MODEL_ID, extraction.usage, userId);

  const extracted = extraction.parsed_output;
  if (!extracted?.query) throw new Error('could not work out what to search for');

  let results: WebResult[];
  try {
    results = await searchWeb(extracted.query, apiKey);
  } catch (err) {
    if (err instanceof SearchNotConfigured) {
      // Still useful: the entities came from the image and need no search.
      return {
        query: extracted.query,
        entities: extracted.entities,
        configured: false,
        answered: false,
        summary:
          'Web search is not configured yet. The entities below were read from the frame; add a Brave API key to look them up.',
        results: [],
        citedUrls: [],
      };
    }
    throw err;
  }

  if (results.length === 0) {
    return {
      query: extracted.query,
      entities: extracted.entities,
      configured: true,
      answered: false,
      summary: `No web results for "${extracted.query}".`,
      results: [],
      citedUrls: [],
    };
  }

  const answer = await (await claude()).messages.parse({
    model: MODEL_ID,
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: zodOutputFormat(AnswerSchema) },
    system: [
      'You summarise web search results to identify something seen in a video frame.',
      'Use only the results provided. Do not add facts you happen to know about the place',
      'or product; if the results do not identify it, say so and set answered false.',
      'Cite only urls that appear in the results.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: `Search query: ${extracted.query}\n\nResults:\n${formatResults(results)}\n\nWhat is this, according to these results?`,
      },
    ],
  });

  recordUsage('lens-summarise', MODEL_ID, answer.usage, userId);

  const parsed = answer.parsed_output;
  const allowedUrls = new Set(results.map((result) => result.url));
  // A citation the search did not return is not a citation.
  const citedUrls = (parsed?.cited_urls ?? []).filter((url) => allowedUrls.has(url));

  return {
    query: extracted.query,
    entities: extracted.entities,
    configured: true,
    answered: Boolean(parsed?.answered) && citedUrls.length > 0,
    summary: parsed?.summary ?? '',
    results,
    citedUrls,
  };
});

const formatResults = (results: WebResult[]) =>
  results.map((result, i) => `${i + 1}. ${result.title}\n   ${result.url}\n   ${result.description}`).join('\n');

async function loadApiKey(): Promise<string> {
  if (cached && Date.now() - cached.at < KEY_TTL_MS) return cached.key;

  let key = '';
  try {
    const secret = await secrets.send(new GetSecretValueCommand({ SecretId: SEARCH_SECRET_ARN }));
    const raw = (secret.SecretString ?? '').trim();
    // The secret may hold a bare key or a JSON object with an apiKey field.
    key = raw.startsWith('{') ? String(JSON.parse(raw).apiKey ?? '') : raw;
  } catch (err) {
    console.warn('could not read the search key', { err: err instanceof Error ? err.message : err });
  }

  if (key) cached = { key, at: Date.now() };
  return key;
}

async function loadImage(
  userId: string,
  body: { s3Key?: string; mediaId?: string; tsMs?: number },
): Promise<string> {
  let key: string | undefined = body.s3Key;

  if (key) {
    requireOwnLensKey(userId, key);
  } else if (body.mediaId && typeof body.tsMs === 'number') {
    // Searching *from* a frame requires holding the reel it belongs to, the
    // same rule find-similar applies. Without it, naming any reel would hand
    // back its picture — and then a description of it.
    if (!(await hasSaved(userId, body.mediaId))) {
      throw badRequest(`frame ${body.tsMs}ms of ${body.mediaId} is not in your library`);
    }
    const frames = await ddb.send(
      new QueryCommand({
        TableName: TABLES.frames,
        KeyConditionExpression: 'media_id = :id AND ts_ms = :ts',
        ExpressionAttributeValues: { ':id': body.mediaId, ':ts': body.tsMs },
      }),
    );
    key = frames.Items?.[0]?.s3_key as string | undefined;
    if (!key) throw badRequest(`frame ${body.tsMs}ms of ${body.mediaId} not found`);
  } else {
    throw badRequest('either s3Key, or mediaId and tsMs, is required');
  }

  const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await object.Body!.transformToByteArray()).toString('base64');
}
