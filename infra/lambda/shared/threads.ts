import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb';
import { HttpError } from './http';

const THREADS_TABLE = process.env.THREADS_TABLE!;

/**
 * A thread belongs to one person, and the owner is its partition key: there is
 * no key that reaches anyone else's.
 *
 * The check is still needed because a thread id travels to the browser and
 * comes back on the next turn. Without it, posting someone else's id would
 * append turns to their conversation — the messages table is keyed by thread
 * alone, so it cannot tell whose hand is on it. Every path into that table goes
 * through here first.
 */
export async function requireThread(userId: string, threadId: string): Promise<void> {
  const row = await ddb.send(
    new GetCommand({
      TableName: THREADS_TABLE,
      Key: { user_id: userId, id: threadId },
      ProjectionExpression: 'id',
    }),
  );
  // Not found rather than forbidden: whether someone else's thread exists is
  // none of the caller's business.
  if (!row.Item) throw new HttpError(404, 'thread not found');
}
