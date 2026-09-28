import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/ddb';
import { handler, pathParam } from '../shared/http';

const MESSAGES_TABLE = process.env.MESSAGES_TABLE!;

/** GET /threads/{id} — a thread's turns, oldest first, with their citations. */
export const main = handler(async (event) => {
  const threadId = pathParam(event, 'id');
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
