import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import { badRequest, callerId, handler, notFound, parseJsonBody, pathParam, type ApiEvent } from '../shared/http';
import type { MediaRecord } from '../shared/media';
import { hasSaved } from '../shared/saves';
import { STALE_MS, type ClaimCheck } from './claims';
import type { ClaimJob } from './claim-check-worker';

const lambda = new LambdaClient({});
const CLAIM_WORKER_ARN = process.env.CLAIM_WORKER_ARN!;

/** Not found rather than forbidden, as GET /media/{id}: unsaved reels are not admitted to exist. */
async function loadSaved(event: ApiEvent): Promise<MediaRecord> {
  const id = pathParam(event, 'id');
  if (!(await hasSaved(callerId(event), id))) throw notFound('media not found');
  const result = await ddb.send(new GetCommand({ TableName: TABLES.media, Key: { id } }));
  if (!result.Item) throw notFound('media not found');
  return result.Item as MediaRecord;
}

const isRunning = (check: ClaimCheck | undefined) =>
  check?.status === 'working' && Date.now() - Date.parse(check.started_at) < STALE_MS;

/** GET /media/{id}/claims — the reel's check, for polling while it runs. */
export const status = handler(async (event) => {
  const media = await loadSaved(event);
  return { mediaId: media.id, check: media.claim_check ?? null };
});

/**
 * POST /media/{id}/claims — start a hype-or-true check, or return the one there is.
 *
 * Shared per reel: a finished check is returned as is unless `refresh` is set,
 * and a running one is never started twice. The work takes longer than API
 * Gateway's 30 seconds (two model calls and a search per claim), so it runs in
 * the claim worker and the client polls GET.
 */
export const start = handler(async (event) => {
  const media = await loadSaved(event);
  const { refresh } = event.body ? parseJsonBody<{ refresh?: boolean }>(event) : { refresh: false };
  if (media.status !== 'ready') throw badRequest('this reel is still being processed; check it once it is ready');

  const existing = media.claim_check;
  if (isRunning(existing) || (existing?.status === 'ready' && !refresh)) {
    return { mediaId: media.id, check: existing, started: false };
  }

  const now = new Date().toISOString();
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLES.media,
        Key: { id: media.id },
        // The last report stays readable while the new one is built.
        UpdateExpression: existing
          ? 'SET claim_check.#status = :working, claim_check.started_at = :now REMOVE claim_check.#error, claim_check.finished_at'
          : 'SET claim_check = :fresh',
        // Two people pressing the button at once start one check, not two.
        ConditionExpression: existing
          ? 'claim_check.#status <> :working OR claim_check.started_at < :stale'
          : 'attribute_exists(id) AND attribute_not_exists(claim_check)',
        ExpressionAttributeNames: existing ? { '#status': 'status', '#error': 'error' } : undefined,
        ExpressionAttributeValues: existing
          ? { ':working': 'working', ':now': now, ':stale': new Date(Date.now() - STALE_MS).toISOString() }
          : { ':fresh': { status: 'working', started_at: now } satisfies ClaimCheck },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    const current = await ddb.send(new GetCommand({ TableName: TABLES.media, Key: { id: media.id } }));
    return { mediaId: media.id, check: (current.Item as MediaRecord | undefined)?.claim_check ?? null, started: false };
  }

  const job: ClaimJob = { mediaId: media.id, userId: callerId(event) };
  await lambda.send(
    new InvokeCommand({ FunctionName: CLAIM_WORKER_ARN, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(job)) }),
  );
  return {
    mediaId: media.id,
    check: { ...(existing ?? {}), status: 'working', started_at: now } as ClaimCheck,
    started: true,
  };
});
