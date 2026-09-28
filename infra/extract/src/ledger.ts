import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const USAGE_TABLE = process.env.USAGE_TABLE;

/**
 * Must match `usagePeriod` in `lambda/shared/ledger.ts`. The two cannot share a
 * module — infra/extract is built from its own directory — and a mismatch would
 * split one person's month across two rows, making every total quietly wrong.
 * A test asserts they agree.
 */
export const usagePeriod = (at = new Date()) => `usage#${at.toISOString().slice(0, 7)}`;

/**
 * Downloads and bytes, charged to whoever caused the fetch.
 *
 * Content is shared, so this is paid once: the person who pasted the link wears
 * the download, and everyone who saves it afterwards records a save and no
 * bytes at all, because none moved. That is deduplication showing up in the
 * accounts rather than only in the infrastructure.
 */
export async function addDownloadUsage(
  userId: string | undefined,
  delta: { downloads?: number; bytes_downloaded?: number },
): Promise<void> {
  if (!userId || !USAGE_TABLE) return;
  const entries = Object.entries(delta).filter(([, v]) => typeof v === 'number' && v !== 0);
  if (entries.length === 0) return;

  const names: Record<string, string> = {};
  const values: Record<string, number> = {};
  const adds = entries.map(([field, value], i) => {
    names[`#f${i}`] = field;
    values[`:v${i}`] = value as number;
    return `#f${i} :v${i}`;
  });

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: USAGE_TABLE,
        Key: { user_id: userId, period: usagePeriod() },
        UpdateExpression: `ADD ${adds.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  } catch (err) {
    // A lost counter must never fail a download that otherwise worked.
    console.warn('could not record download usage', { userId, delta, err });
  }
}
