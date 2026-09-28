import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import { badRequest, callerId, handler, notFound, pathParam } from '../shared/http';
import { hasSaved } from '../shared/saves';
import type { MediaRecord } from '../shared/media';
import { purgeDerived, purgeObjects } from './purge';

const sfn = new SFNClient({});
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;
const JOB_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * POST /media/{id}/retry — run the pipeline again for a reel that failed.
 *
 * Reels fail for reasons that go away: Instagram's anonymous rate limit clears,
 * and a codec the extractor could not handle may be fixed by a deploy. Retrying
 * has to be a real re-run rather than a status flip, so anything a half-finished
 * run left behind is cleared first.
 */
export const main = handler(async (event) => {
  const id = pathParam(event, 'id');

  // Same reasoning as get-media: not-found rather than forbidden, so a caller
  // cannot probe for reels outside their library.
  const userId = callerId(event);
  if (!(await hasSaved(userId, id))) throw notFound('media not found');

  const result = await ddb.send(new GetCommand({ TableName: TABLES.media, Key: { id } }));
  const media = result.Item as MediaRecord | undefined;
  if (!media) throw notFound('media not found');

  if (media.status !== 'failed') {
    throw badRequest(`only a failed reel can be retried; this one is ${media.status}`);
  }

  // A carousel has no video at all: its slides are the source material, so a
  // re-run means re-analysing them rather than re-deriving them.
  const isCarousel = media.type === 'carousel';

  // A url-sourced reel is fetched again, so its original can go too. An upload
  // has no other copy: losing it would make the reel unrecoverable.
  const refetches = media.source === 'url' && !isCarousel;
  if (!refetches && !isCarousel && !media.s3_key) {
    throw badRequest('this reel has no stored original and cannot be re-fetched');
  }

  const purged = await purgeDerived(id, { keepFrames: isCarousel });
  const objectsRemoved = await purgeObjects(id, {
    keepOriginal: !refetches,
    keepFrames: isCarousel,
  });

  await ddb.send(
    new UpdateCommand({
      TableName: TABLES.media,
      Key: { id },
      // REMOVE the error, or a stale failure would still show next to a
      // reel that is now working. A carousel keeps its cover: that points at
      // slide 1 and is written on upload, not by the pipeline, so clearing it
      // would leave the Library tile blank for good.
      UpdateExpression: `SET #status = :queued REMOVE #error, analysis_summary, places, transcript, transcript_segment_count${
        isCarousel ? '' : ', cover_s3_key'
      }`,
      ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
      ExpressionAttributeValues: { ':queued': 'queued' },
      ConditionExpression: 'attribute_exists(id)',
    }),
  );

  await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: `${id}-retry-${Date.now()}`,
      input: JSON.stringify({
        userId,
        mediaId: id,
        source: media.source,
        // Without this a retried carousel is routed down the reel path and
        // fails looking for a video to extract.
        ...(isCarousel ? { kind: 'carousel' } : {}),
        jobExpiresAt: String(Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS),
      }),
    }),
  );

  return { mediaId: id, status: 'queued', refetches, ...purged, objectsRemoved };
});
