import { randomUUID } from 'node:crypto';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BatchWriteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES, MEDIA_ENTITY } from '../shared/ddb';
import { slideTsMs } from '../shared/media';
import { badRequest, handler, parseJsonBody } from '../shared/http';
import type { MediaRecord } from '../shared/media';
import {
  buildAuthorizeUrl,
  carouselSlides,
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getProfile,
  isIngestable,
  listMedia,
  DEFAULT_SCOPES,
  type IgMedia,
} from './instagram';
import { clearConnection, consumeState, loadAppSecret, putState, readConnection, writeConnection } from './store';

const s3 = new S3Client({});
const sfn = new SFNClient({});

const APP_ID = process.env.IG_APP_ID ?? '';
const REDIRECT_URI = process.env.IG_REDIRECT_URI!;
const BUCKET = process.env.MEDIA_BUCKET!;
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;
const JOB_TTL_SECONDS = 30 * 24 * 60 * 60;

/** POST /connect/instagram/start — the URL to send the browser to. */
export const start = handler(async () => {
  if (!APP_ID) throw badRequest('no Instagram app id is configured');
  if (!(await loadAppSecret())) throw badRequest('no Instagram app secret has been set');

  const state = randomUUID();
  await putState(state);
  return {
    authorizeUrl: buildAuthorizeUrl({ appId: APP_ID, redirectUri: REDIRECT_URI, state, scopes: DEFAULT_SCOPES }),
    redirectUri: REDIRECT_URI,
  };
});

/**
 * POST /connect/instagram/exchange — finishes the OAuth round trip.
 *
 * The browser lands on our own page with the code and posts it here behind the
 * app's own auth, so the code and both tokens only ever move server side.
 */
export const exchange = handler(async (event) => {
  const { code, state } = parseJsonBody<{ code?: string; state?: string }>(event);
  if (!code) throw badRequest('code is required');
  if (!state) throw badRequest('state is required');
  if (!(await consumeState(state))) throw badRequest('unrecognised or expired state; start the connection again');

  const appSecret = await loadAppSecret();
  if (!appSecret) throw badRequest('no Instagram app secret has been set');

  const shortLived = await exchangeCodeForToken({
    appId: APP_ID,
    appSecret,
    redirectUri: REDIRECT_URI,
    code,
  });
  const longLived = await exchangeForLongLivedToken({
    appSecret,
    shortLivedToken: shortLived.access_token,
  });
  const profile = await getProfile(longLived.access_token);

  const now = new Date();
  await writeConnection({
    id: 'instagram',
    ig_user_id: String(profile.id ?? shortLived.user_id ?? ''),
    username: profile.username,
    access_token: longLived.access_token,
    obtained_at: now.toISOString(),
    expires_at: new Date(now.getTime() + longLived.expires_in * 1000).toISOString(),
    scopes: (shortLived.permissions ?? DEFAULT_SCOPES.join(',')) as string,
  });

  return { connected: true, username: profile.username, expiresInDays: Math.round(longLived.expires_in / 86400) };
});

/** GET /connect/instagram — whether a connection exists, and how healthy it is. */
export const status = handler(async () => {
  const connection = await readConnection();
  if (!connection) {
    return { connected: false, configured: Boolean(APP_ID) && Boolean(await loadAppSecret()) };
  }
  const daysLeft = Math.round((new Date(connection.expires_at).getTime() - Date.now()) / 86_400_000);
  return {
    connected: true,
    configured: true,
    username: connection.username,
    igUserId: connection.ig_user_id,
    scopes: connection.scopes,
    expiresAt: connection.expires_at,
    daysLeft,
    lastSyncAt: connection.last_sync_at,
  };
});

/** DELETE /connect/instagram — forget the token. */
export const disconnect = handler(async () => {
  await clearConnection();
  return { connected: false };
});

/**
 * POST /connect/instagram/sync — ingest the account's own reels.
 *
 * The video is fetched from the API's media_url straight into the media store,
 * then handed to the same pipeline an upload uses. Nothing here touches the
 * public-page download path.
 */
export const sync = handler(async (event) => {
  const { limit } = parseJsonBody<{ limit?: number }>(event);
  const connection = await readConnection();
  if (!connection) throw badRequest('Instagram is not connected');

  const media = await listMedia(connection.access_token, limit ?? 25);
  const existing = await existingIgMediaIds();

  const results: Array<{ ig_media_id: string; status: string; mediaId?: string; reason?: string }> = [];

  for (const item of media) {
    if (existing.has(item.id)) {
      results.push({ ig_media_id: item.id, status: 'already ingested' });
      continue;
    }
    if (!isIngestable(item)) {
      results.push({
        ig_media_id: item.id,
        status: 'skipped',
        // media_url is omitted for copyright-flagged media, and images have no reel to analyse.
        reason:
          item.media_type === 'CAROUSEL_ALBUM'
            ? 'carousel has no usable image slides (copyright flagged, or all video)'
            : item.media_url
              ? `media_type ${item.media_type} is not a reel or carousel`
              : 'no media_url (copyright flagged?)',
      });
      continue;
    }
    const mediaId = item.media_type === 'CAROUSEL_ALBUM' ? await ingestCarousel(item) : await ingest(item);
    results.push({ ig_media_id: item.id, status: 'ingesting', mediaId });
  }

  await writeConnection({ ...connection, last_sync_at: new Date().toISOString() });
  return { checked: media.length, results };
});

async function existingIgMediaIds(): Promise<Set<string>> {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLES.media,
      IndexName: 'byCreatedAt',
      KeyConditionExpression: '#entity = :entity',
      ExpressionAttributeNames: { '#entity': 'entity' },
      ExpressionAttributeValues: { ':entity': MEDIA_ENTITY },
      ProjectionExpression: 'ig_media_id',
    }),
  );
  return new Set(
    (result.Items ?? []).map((item) => item.ig_media_id).filter((id): id is string => typeof id === 'string'),
  );
}

async function ingest(item: IgMedia): Promise<string> {
  const id = randomUUID();
  const s3Key = `media/${id}/original.mp4`;

  const response = await fetch(item.media_url!);
  if (!response.ok) throw new Error(`could not fetch media ${item.id}: ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());

  await s3.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, Body: body, ContentType: 'video/mp4' }),
  );

  const record: MediaRecord = {
    id,
    entity: MEDIA_ENTITY,
    source: 'api',
    type: 'reel',
    status: 'queued',
    created_at: new Date().toISOString(),
    s3_key: s3Key,
    content_type: 'video/mp4',
    bytes: body.byteLength,
    ig_media_id: item.id,
    permalink: item.permalink,
    caption_raw: item.caption,
    caption_normalized: item.caption,
    taken_at: item.timestamp,
    uploader: item.username,
  };
  await ddb.send(new PutCommand({ TableName: TABLES.media, Item: record }));

  if (STATE_MACHINE_ARN) {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: `${id}-${Date.now()}`,
        input: JSON.stringify({
          mediaId: id,
          // Not 'url': the bytes are already in S3, so the download leg is skipped.
          source: 'api',
          jobExpiresAt: String(Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS),
        }),
      }),
    );
  }
  return id;
}

const FRAMES_TABLE = process.env.FRAMES_TABLE!;

/**
 * A carousel's slides are downloaded straight in as frames, and the pipeline
 * joins at the vision pass: there is no video to extract from.
 */
async function ingestCarousel(item: IgMedia): Promise<string> {
  const slides = carouselSlides(item);
  const id = randomUUID();
  const now = new Date().toISOString();

  let totalBytes = 0;
  const rows = await Promise.all(
    slides.map(async (slide, index) => {
      const response = await fetch(slide.media_url!);
      if (!response.ok) throw new Error(`could not fetch slide ${index + 1} of ${item.id}: ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      totalBytes += body.byteLength;

      const tsMs = slideTsMs(index);
      const key = `media/${id}/frames/${String(tsMs).padStart(8, '0')}.jpg`;
      await s3.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: 'image/jpeg' }),
      );
      return {
        PutRequest: {
          Item: { media_id: id, ts_ms: tsMs, s3_key: key, kind: 'slide', slide_index: index, created_at: now },
        },
      };
    }),
  );

  for (let i = 0; i < rows.length; i += 25) {
    await ddb.send(new BatchWriteCommand({ RequestItems: { [FRAMES_TABLE]: rows.slice(i, i + 25) } }));
  }

  const record: MediaRecord = {
    id,
    entity: MEDIA_ENTITY,
    source: 'api',
    type: 'carousel',
    status: 'queued',
    created_at: now,
    content_type: 'image/carousel',
    slide_count: slides.length,
    bytes: totalBytes,
    cover_s3_key: `media/${id}/frames/${String(slideTsMs(0)).padStart(8, '0')}.jpg`,
    ig_media_id: item.id,
    permalink: item.permalink,
    caption_raw: item.caption,
    caption_normalized: item.caption,
    taken_at: item.timestamp,
    uploader: item.username,
  };
  await ddb.send(new PutCommand({ TableName: TABLES.media, Item: record }));

  if (STATE_MACHINE_ARN) {
    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name: `${id}-${Date.now()}`,
        input: JSON.stringify({
          mediaId: id,
          source: 'api',
          kind: 'carousel',
          jobExpiresAt: String(Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS),
        }),
      }),
    );
  }
  return id;
}
