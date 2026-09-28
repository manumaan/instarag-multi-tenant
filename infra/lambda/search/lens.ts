import { randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import { badRequest, handler, parseJsonBody } from '../shared/http';
import { documentId, openSearchClient, INDEX_NAME } from './client';
import { embed } from './embed';

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET!;
const URL_TTL_SECONDS = 900;

/** Lens query images live under their own prefix and expire on a lifecycle rule. */
const LENS_PREFIX = 'lens/';

const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const MAX_QUERY_BYTES = 20 * 1024 * 1024;

/** POST /lens/uploads — presigned PUT for a screenshot to search with. */
export const upload = handler(async (event) => {
  const body = parseJsonBody<{ contentType?: string; bytes?: number }>(event);
  const contentType = body.contentType?.toLowerCase();
  if (!contentType) throw badRequest('contentType is required');
  const extension = ALLOWED_IMAGE_TYPES[contentType];
  if (!extension) {
    throw badRequest(`unsupported contentType ${contentType}; allowed: ${Object.keys(ALLOWED_IMAGE_TYPES).join(', ')}`);
  }
  if (typeof body.bytes !== 'number' || body.bytes <= 0) throw badRequest('bytes must be a positive number');
  if (body.bytes > MAX_QUERY_BYTES) throw badRequest(`image exceeds the ${MAX_QUERY_BYTES} byte limit`);

  const key = `${LENS_PREFIX}${randomUUID()}${extension}`;
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: URL_TTL_SECONDS, signableHeaders: new Set(['content-type']) },
  );
  return { s3Key: key, uploadUrl, expiresIn: URL_TTL_SECONDS };
});

interface SimilarBody {
  /** A screenshot uploaded via POST /lens/uploads. */
  s3Key?: string;
  /** Or a frame already in the library. */
  mediaId?: string;
  tsMs?: number;
  limit?: number;
}

export interface SimilarMatch {
  media_id: string;
  ts_ms: number;
  score: number;
  description: string;
  ocr_text: string;
  url?: string;
}

/**
 * POST /lens/similar — nearest neighbours of a screenshot or an existing frame.
 *
 * Image-to-image works without a second index because the frame vectors were
 * produced by Titan Multimodal from the image itself; a query image embeds into
 * the same space.
 */
export const similar = handler(async (event) => {
  const body = parseJsonBody<SimilarBody>(event);
  const limit = Math.min(Math.max(body.limit ?? 12, 1), 50);
  const client = openSearchClient();

  let vector: number[];
  let excludeId: string | undefined;

  if (body.s3Key) {
    if (!body.s3Key.startsWith(LENS_PREFIX)) throw badRequest('s3Key must be a lens upload');
    const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: body.s3Key }));
    const imageBase64 = Buffer.from(await object.Body!.transformToByteArray()).toString('base64');
    vector = await embed({ imageBase64 });
  } else if (body.mediaId && typeof body.tsMs === 'number') {
    // Reuse the vector already in the index rather than re-embedding the frame.
    excludeId = documentId(body.mediaId, body.tsMs, 'frame');
    // Only a genuine 404 means "not indexed"; anything else (permissions, a
    // cold collection) must surface rather than masquerade as a missing frame.
    let existing;
    try {
      existing = await client.get({ index: INDEX_NAME, id: excludeId });
    } catch (err) {
      const status = (err as { meta?: { statusCode?: number } }).meta?.statusCode;
      if (status !== 404) throw err;
    }
    const stored = (existing?.body?._source as { embedding?: number[] } | undefined)?.embedding;
    if (!stored) {
      throw badRequest(`frame ${body.tsMs}ms of ${body.mediaId} is not in the index`);
    }
    vector = stored;
  } else {
    throw badRequest('either s3Key, or mediaId and tsMs, is required');
  }

  const response = await client.search({
    index: INDEX_NAME,
    body: {
      // One extra, so dropping the query frame itself cannot shorten the page.
      size: limit + 1,
      query: {
        bool: {
          must: [{ knn: { embedding: { vector, k: limit + 1 } } }],
          // Frames only: a spoken line has no image to look like.
          filter: [{ term: { kind: 'frame' } }],
        },
      },
      _source: { excludes: ['embedding'] },
    },
  });

  const hits = ((response.body.hits.hits ?? []) as unknown as Array<{
    _id: string;
    _score: number;
    _source: Record<string, unknown>;
  }>)
    .filter((hit) => hit._id !== excludeId)
    .slice(0, limit);

  const matches: SimilarMatch[] = hits.map((hit) => ({
    media_id: String(hit._source.media_id),
    ts_ms: Number(hit._source.ts_ms),
    score: hit._score,
    description: String(hit._source.description ?? ''),
    ocr_text: String(hit._source.ocr_text ?? ''),
  }));

  return { matches: await withThumbnails(matches) };
});

/**
 * Frame images are presigned from the frames table rather than stored in the
 * index, so the index needs no mapping change to serve Lens.
 *
 * A match whose frame row is gone is dropped, not returned imageless. An index
 * document can outlive its frame — a delete that failed halfway leaves one
 * behind — and Lens is a list of pictures, so a hit with no picture is a ghost
 * result: it cannot be looked at and it cannot be opened.
 */
async function withThumbnails(matches: SimilarMatch[]): Promise<SimilarMatch[]> {
  if (matches.length === 0) return matches;

  const s3Keys = await frameKeys(matches.map(({ media_id, ts_ms }) => ({ media_id, ts_ms })));

  const found = matches.flatMap((match) => {
    const key = s3Keys.get(`${match.media_id}:${match.ts_ms}`);
    return key ? [{ match, key }] : [];
  });

  return Promise.all(
    found.map(async ({ match, key }) => ({
      ...match,
      url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
        expiresIn: URL_TTL_SECONDS,
      }),
    })),
  );
}

interface FrameKey {
  media_id: string;
  ts_ms: number;
}

/**
 * BatchGet is allowed to return part of what was asked for and hand the rest
 * back as UnprocessedKeys. Ignoring them loses thumbnails for results that are
 * perfectly present, so the leftovers are asked for again.
 */
async function frameKeys(keys: FrameKey[]): Promise<Map<string, string>> {
  const s3Keys = new Map<string, string>();
  let pending = keys;

  for (let attempt = 0; pending.length > 0 && attempt < 4; attempt += 1) {
    const fetched = await ddb.send(
      new BatchGetCommand({
        RequestItems: { [TABLES.frames]: { Keys: pending, ProjectionExpression: 'media_id, ts_ms, s3_key' } },
      }),
    );
    for (const row of fetched.Responses?.[TABLES.frames] ?? []) {
      if (row.s3_key) s3Keys.set(`${row.media_id}:${row.ts_ms}`, String(row.s3_key));
    }
    pending = (fetched.UnprocessedKeys?.[TABLES.frames]?.Keys ?? []) as FrameKey[];
  }

  return s3Keys;
}
