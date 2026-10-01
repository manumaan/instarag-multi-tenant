import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from './ddb';
import { savedMediaIds } from './saves';

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET!;

/*
 * A finished plan, kept so the same request is not built twice.
 *
 * A plan costs about a minute and a few thousand output tokens, and the same
 * person asking the same thing of the same library gets the same plan. So the
 * key is exactly that triple — who, what, and which clips:
 *
 * - who: plans are built from a private library, so a cached plan is never
 *   shared between people (it would quote someone else's saves);
 * - what: the request, normalised for case, spacing and trailing punctuation;
 * - which clips: the ids of this person's *ready* reels. Saving, removing, or
 *   a reel finishing its analysis changes the key, so the next request builds
 *   afresh instead of serving a plan that is missing the new clip.
 *
 * Stored in the media bucket under plans/{user}/, next to its PDF (plans/{user}/{key}.pdf),
 * which is uploaded the first time someone shares it and served from then on.
 */

export interface CachedPlan {
  status: 'ready' | 'unsupported';
  content: string;
  citations: Array<{ media_id: string; ts_ms: number }>;
  plan: Record<string, unknown>;
  sources: unknown[];
}

export function normalizeRequest(request: string): string {
  return request
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.!?]+$/, '')
    .trim();
}

/** The ids among these that have finished analysis — only those can be in a plan. */
async function readyIds(ids: string[]): Promise<string[]> {
  const ready: string[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    let keys: Array<Record<string, unknown>> | undefined = ids.slice(i, i + 100).map((id) => ({ id }));
    // Unprocessed keys are retried: a throttle must not quietly change the key.
    for (let attempt = 0; keys?.length && attempt < 5; attempt += 1) {
      const out = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [TABLES.media]: {
              Keys: keys,
              ProjectionExpression: 'id, #s',
              ExpressionAttributeNames: { '#s': 'status' },
            },
          },
        }),
      );
      for (const item of out.Responses?.[TABLES.media] ?? []) {
        if (item.status === 'ready') ready.push(String(item.id));
      }
      keys = out.UnprocessedKeys?.[TABLES.media]?.Keys as Array<Record<string, unknown>> | undefined;
    }
  }
  return ready.sort();
}

export async function planCacheKey(userId: string, request: string, mediaId?: string): Promise<string> {
  const library = await readyIds(await savedMediaIds(userId));
  return createHash('sha256')
    .update(JSON.stringify({ v: 1, request: normalizeRequest(request), mediaId: mediaId ?? null, library }))
    .digest('hex')
    .slice(0, 40);
}

/** The S3 key for a cached plan's JSON or its PDF. The user is in the path, never only in the hash. */
export const planObjectKey = (userId: string, key: string, ext: 'json' | 'pdf') => `plans/${userId}/${key}.${ext}`;

export async function readCachedPlan(userId: string, key: string): Promise<CachedPlan | undefined> {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: planObjectKey(userId, key, 'json') }));
    return JSON.parse(await out.Body!.transformToString()) as CachedPlan;
  } catch (err) {
    // A miss is the normal case. Anything else is logged and treated as a miss:
    // the cache must never be the reason a plan cannot be built.
    if ((err as { name?: string }).name !== 'NoSuchKey') console.warn('plan cache read failed', { key, err });
    return undefined;
  }
}

export async function writeCachedPlan(userId: string, key: string, plan: CachedPlan): Promise<void> {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: planObjectKey(userId, key, 'json'),
        Body: JSON.stringify(plan),
        ContentType: 'application/json',
      }),
    );
  } catch (err) {
    // Same reasoning: a plan that was built is delivered even if caching it failed.
    console.warn('plan cache write failed', { key, err });
  }
}
