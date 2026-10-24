import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import type { MediaRecord } from '../shared/media';
import { loadApiKey } from './brave';
import { checkClaims } from './claims';

export interface ClaimJob {
  mediaId: string;
  /** Who asked, from the JWT at the request: the tokens go on their ledger. */
  userId: string;
}

/** Runs a hype-or-true check away from the request; see claim-check.ts. */
export async function handler(job: ClaimJob): Promise<void> {
  const { mediaId, userId } = job;
  console.log('claim check started', { mediaId });
  try {
    const record = await ddb.send(new GetCommand({ TableName: TABLES.media, Key: { id: mediaId } }));
    const media = record.Item as MediaRecord | undefined;
    if (!media) throw new Error(`media ${mediaId} not found`);

    const apiKey = await loadApiKey();
    // Without search this would be the model's memory dressed up as a check.
    if (!apiKey) throw new Error('web search is not configured: no Brave API key has been set');

    const report = await checkClaims(media, apiKey, userId);
    await ddb.send(
      new UpdateCommand({
        TableName: TABLES.media,
        Key: { id: mediaId },
        UpdateExpression: 'SET claim_check.#status = :ready, claim_check.finished_at = :now, claim_check.report = :report',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':ready': 'ready', ':now': new Date().toISOString(), ':report': report },
        // A reel deleted or retried while this ran keeps no stale verdict.
        ConditionExpression: 'attribute_exists(claim_check)',
      }),
    );
    console.log('claim check finished', {
      mediaId,
      score: report.score,
      label: report.label,
      claims: report.claims.length,
      judged: report.judged,
      signals: report.hype_signals.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('claim check failed', { mediaId, message });
    // The failure belongs on the record, or the page polls a placeholder forever.
    await ddb
      .send(
        new UpdateCommand({
          TableName: TABLES.media,
          Key: { id: mediaId },
          UpdateExpression: 'SET claim_check.#status = :failed, claim_check.#error = :error, claim_check.finished_at = :now',
          ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
          ExpressionAttributeValues: { ':failed': 'failed', ':error': message.slice(0, 500), ':now': new Date().toISOString() },
          ConditionExpression: 'attribute_exists(claim_check)',
        }),
      )
      .catch(() => undefined);
  }
}
