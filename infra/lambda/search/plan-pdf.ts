import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/ddb';
import { HttpError, badRequest, callerId, handler, parseJsonBody } from '../shared/http';
import { requireThread } from '../shared/threads';
import { planObjectKey } from '../shared/plan-cache';

const s3 = new S3Client({});
const BUCKET = process.env.MEDIA_BUCKET!;
const MESSAGES_TABLE = process.env.MESSAGES_TABLE!;
const URL_TTL_SECONDS = 300;

/**
 * POST /plans/pdf { threadId, messageAt } — the stored PDF for a plan, or a
 * place to store one.
 *
 * A plan's PDF is built on the device that first shares it (expo-print on the
 * phone, the browser on the web) and uploaded here; every later share, from
 * either app, downloads that file instead of building it again. It lives next
 * to the cached plan, under the same key, so a repeated request that is served
 * from the plan cache also gets its PDF back.
 *
 * - `{ exists: true, url }` — download and share this.
 * - `{ exists: false, uploadUrl }` — build it, PUT it here (application/pdf), share it.
 */
export const main = handler(async (event) => {
  const userId = callerId(event);
  const { threadId, messageAt } = parseJsonBody<{ threadId?: string; messageAt?: string }>(event);
  if (!threadId || !messageAt) throw badRequest('threadId and messageAt are required');

  // The thread must be the caller's; the messages table cannot tell by itself.
  await requireThread(userId, threadId);
  const message = (
    await ddb.send(
      new GetCommand({
        TableName: MESSAGES_TABLE,
        Key: { thread_id: threadId, created_at: messageAt },
        ProjectionExpression: 'plan_key, #s',
        ExpressionAttributeNames: { '#s': 'status' },
      }),
    )
  ).Item;
  if (!message?.plan_key) throw new HttpError(404, 'no stored plan for this message');
  if (message.status !== 'ready' && message.status !== 'unsupported') throw badRequest('the plan is not finished');

  const Key = planObjectKey(userId, String(message.plan_key), 'pdf');
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
    return {
      exists: true,
      url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key }), { expiresIn: URL_TTL_SECONDS }),
    };
  } catch (err) {
    if ((err as { name?: string }).name !== 'NotFound') throw err;
  }
  return {
    exists: false,
    uploadUrl: await getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key, ContentType: 'application/pdf' }), {
      expiresIn: URL_TTL_SECONDS,
    }),
  };
});
