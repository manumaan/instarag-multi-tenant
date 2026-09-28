import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/ddb';
import { handler } from '../shared/http';

const THREADS_TABLE = process.env.THREADS_TABLE!;

/** GET /threads — newest-first list of Ask threads. */
export const main = handler(async () => {
  const result = await ddb.send(
    new QueryCommand({
      TableName: THREADS_TABLE,
      IndexName: 'byCreatedAt',
      KeyConditionExpression: '#entity = :entity',
      ExpressionAttributeNames: { '#entity': 'entity' },
      ExpressionAttributeValues: { ':entity': 'thread' },
      ScanIndexForward: false,
      Limit: 50,
    }),
  );
  return { items: result.Items ?? [] };
});
