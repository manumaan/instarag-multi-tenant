import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/ddb';

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;

export const main = async (event: APIGatewayProxyWebsocketEventV2) => {
  await ddb.send(
    new DeleteCommand({
      TableName: CONNECTIONS_TABLE,
      Key: { connection_id: event.requestContext.connectionId },
    }),
  );
  return { statusCode: 200, body: 'disconnected' };
};
