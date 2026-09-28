import { randomUUID } from 'node:crypto';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES, MEDIA_ENTITY, MEDIA_BY_PERMALINK } from '../shared/ddb';
import { badRequest, handler, parseJsonBody } from '../shared/http';
import { parseInstagramUrl, type MediaRecord } from '../shared/media';

const sfn = new SFNClient({});
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;
/** How long a job row survives before the jobs table's TTL removes it. */
const JOB_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * POST /media/url — register a pasted reel permalink and fetch it.
 *
 * The pipeline downloads the video behind a public permalink, then runs the
 * same extraction the upload path uses. Public reels only: no credentials, no
 * cookies, no logged-in session.
 *
 * A reel already in the library is returned as-is rather than fetched again.
 * Instagram rate-limits anonymous access, and re-downloading something we
 * already hold spends that budget for nothing — a burst of repeats is exactly
 * what triggers the login wall.
 */
export const main = handler(async (event) => {
  const { url } = parseJsonBody<{ url?: string }>(event);
  if (!url) throw badRequest('url is required');

  const parsed = parseInstagramUrl(url);
  if (!parsed) throw badRequest('url must be an instagram.com reel or post permalink');

  const existing = await findByPermalink(parsed.permalink);
  if (existing) {
    return { mediaId: existing.id, media: existing, alreadyInLibrary: true };
  }

  const record: MediaRecord = {
    id: randomUUID(),
    entity: MEDIA_ENTITY,
    source: 'url',
    type: parsed.type,
    status: 'queued',
    created_at: new Date().toISOString(),
    permalink: parsed.permalink,
  };
  await ddb.send(new PutCommand({ TableName: TABLES.media, Item: record }));

  if (STATE_MACHINE_ARN) {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: `${record.id}-${Date.now()}`,
        input: JSON.stringify({
          mediaId: record.id,
          source: record.source,
          jobExpiresAt: String(Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS),
        }),
      }),
    );
  }

  return { mediaId: record.id, media: record };
});

/**
 * An earlier ingest of the same reel, if there is one worth reusing.
 *
 * A failed attempt is not reused: the whole point of re-pasting after a rate
 * limit clears is to try again.
 */
async function findByPermalink(permalink: string): Promise<MediaRecord | undefined> {
  const found = await ddb.send(
    new QueryCommand({
      TableName: TABLES.media,
      IndexName: MEDIA_BY_PERMALINK,
      KeyConditionExpression: 'permalink = :permalink',
      ExpressionAttributeValues: { ':permalink': permalink },
    }),
  );
  const usable = (found.Items ?? [])
    .filter((item) => item.status !== 'failed')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return usable[0] as MediaRecord | undefined;
}
