import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import { badRequest, callerId, handler, parseJsonBody } from '../shared/http';
import { saveMedia } from '../shared/saves';
import { parseInstagramUrl, type MediaRecord } from '../shared/media';

const sfn = new SFNClient({});
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;
/** How long a job row survives before the jobs table's TTL removes it. */
const JOB_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * POST /media/url — save a pasted permalink, fetching it only if nobody has.
 *
 * The shortcode is the media id, so the same link is the same row for everyone.
 * That makes deduplication a GetItem, and makes it *global*: if anyone has
 * already ingested this reel, saving it costs one write — no Instagram request
 * against a rate limit that is the binding constraint as users arrive, and no
 * second 13.2¢ vision pass for an answer that would be identical.
 *
 * What stays private is the save. Sharing the analysis is safe because the reel
 * is public; sharing *that you saved it* would not be.
 */
export const main = handler(async (event) => {
  const userId = callerId(event);
  const { url } = parseJsonBody<{ url?: string }>(event);
  if (!url) throw badRequest('url is required');

  const parsed = parseInstagramUrl(url);
  if (!parsed) throw badRequest('url must be an instagram.com reel or post permalink');

  // The shortcode is the id: one row per reel, for everyone.
  const mediaId = parsed.shortcode;
  const existing = (
    await ddb.send(new GetCommand({ TableName: TABLES.media, Key: { id: mediaId } }))
  ).Item as MediaRecord | undefined;

  // Anything not failed is either done or on its way, and either way this
  // caller just needs to hold it. A failed one is worth another attempt —
  // re-pasting after a rate limit clears is the point of the Retry button.
  if (existing && existing.status !== 'failed') {
    await saveMedia(userId, mediaId);
    return { mediaId, media: existing, alreadyIngested: true };
  }

  const record: MediaRecord = {
    id: mediaId,
    source: 'url',
    type: parsed.type,
    status: 'queued',
    created_at: new Date().toISOString(),
    permalink: parsed.permalink,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLES.media,
        Item: record,
        // Two people pasting the same new link at once would otherwise both
        // write it and both start a pipeline. The loser of this condition falls
        // through to saving what the winner created.
        ConditionExpression: 'attribute_not_exists(id) OR #status = :failed',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':failed': 'failed' },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
    await saveMedia(userId, mediaId);
    const winner = (
      await ddb.send(new GetCommand({ TableName: TABLES.media, Key: { id: mediaId } }))
    ).Item as MediaRecord | undefined;
    return { mediaId, media: winner ?? record, alreadyIngested: true };
  }

  await saveMedia(userId, mediaId);

  if (STATE_MACHINE_ARN) {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: `${mediaId}-${Date.now()}`,
        input: JSON.stringify({
          userId,
          mediaId,
          source: record.source,
          jobExpiresAt: String(Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS),
        }),
      }),
    );
  }

  return { mediaId, media: record };
});
