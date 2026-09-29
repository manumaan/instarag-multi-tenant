import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/ddb';
import { callerId, handler, pathParam } from '../shared/http';
import { requireThread } from '../shared/threads';

const MESSAGES_TABLE = process.env.MESSAGES_TABLE!;

/** GET /threads/{id} — a thread's turns, oldest first, with their citations. */
export const main = handler(async (event) => {
  const userId = callerId(event);
  const threadId = pathParam(event, 'id');
  // The messages table is keyed by thread alone, so this is the only thing
  // standing between a guessed id and someone else's conversation. It is also
  // the poll a plan's progress rides on, which runs every second or two.
  await requireThread(userId, threadId);

  const result = await ddb.send(
    new QueryCommand({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: 'thread_id = :t',
      ExpressionAttributeValues: { ':t': threadId },
      ScanIndexForward: true,
    }),
  );
  return { threadId, messages: result.Items ?? [] };
});
