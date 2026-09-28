import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from './ddb';

/**
 * The shape of a ledger row's key. Duplicated in `extract/src/ledger.ts`,
 * because that bundle is built from its own directory and cannot import this
 * one. A test asserts the two agree — a mismatch would split one person's usage
 * across two rows and make every total wrong without anything failing.
 */
export const usagePeriod = (at = new Date()) => `usage#${at.toISOString().slice(0, 7)}`;

export interface UsageDelta {
  downloads?: number;
  bytes_downloaded?: number;
  tokens_in?: number;
  tokens_out?: number;
  analyses?: number;
  plans?: number;
  saves?: number;
}

/**
 * What a person has cost, per calendar month.
 *
 * `ADD` rather than read-modify-write: it is atomic, needs no read, and two
 * handlers incrementing at once is the normal case rather than a conflict.
 *
 * **Attribution is to whoever caused the work, not to everyone who benefits.**
 * Content is shared, so one download and one 13.2¢ vision pass can serve many
 * libraries; the person who pasted the link pays for it and everyone after them
 * records a save and nothing else. That asymmetry is the point rather than a
 * rounding error — it is what makes deduplication visible as a saving, and it
 * means these numbers answer "what did this person cost me", which is the
 * question a quota and a bill both ask.
 *
 * Best effort. Losing a counter should never fail the work it was counting:
 * the CloudWatch metrics alongside it are the alarming path, and this is the
 * per-person record.
 */
export async function addUsage(userId: string | undefined, delta: UsageDelta): Promise<void> {
  if (!userId) return;

  const entries = Object.entries(delta).filter(([, value]) => typeof value === 'number' && value !== 0);
  if (entries.length === 0) return;

  const names: Record<string, string> = {};
  const values: Record<string, number> = { };
  const adds = entries.map(([field, value], i) => {
    names[`#f${i}`] = field;
    values[`:v${i}`] = value as number;
    return `#f${i} :v${i}`;
  });

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLES.usage,
        Key: { user_id: userId, period: usagePeriod() },
        UpdateExpression: `ADD ${adds.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  } catch (err) {
    console.warn('could not record usage', { userId, delta, err });
  }
}
