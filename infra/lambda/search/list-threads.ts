import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/ddb';
import { callerId, handler } from '../shared/http';

const THREADS_TABLE = process.env.THREADS_TABLE!;

/** GET /threads — this caller's Ask threads, newest first. */
export const main = handler(async (event) => {
  const userId = callerId(event);
  const result = await ddb.send(
    new QueryCommand({
      TableName: THREADS_TABLE,
      // A local index: the caller's own partition, sorted by time. The query
      // cannot name another partition, so there is no scope to widen.
      IndexName: 'byCreatedAt',
      KeyConditionExpression: 'user_id = :u',
      ExpressionAttributeValues: { ':u': userId },
      ScanIndexForward: false,
      Limit: 50,
    }),
  );
  return { items: result.Items ?? [] };
});
