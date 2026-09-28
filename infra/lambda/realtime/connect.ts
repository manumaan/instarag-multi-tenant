import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/ddb';

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;
/** Connections are swept by TTL in case $disconnect never arrives. */
const TTL_SECONDS = 2 * 60 * 60;

export const main = async (event: APIGatewayProxyWebsocketEventV2) => {
  /*
   * From the authorizer, which verified the token. A socket with no identity is
   * refused rather than stored: an unattributed connection could not be
   * filtered later, and the broadcaster's whole job is filtering.
   */
  const userId = (event.requestContext as { authorizer?: { userId?: string } }).authorizer?.userId;
  if (!userId) return { statusCode: 401, body: 'unauthenticated' };

  await ddb.send(
    new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        connection_id: event.requestContext.connectionId,
        user_id: userId,
        connected_at: new Date().toISOString(),
        expires_at: Math.floor(Date.now() / 1000) + TTL_SECONDS,
      },
    }),
  );
  return { statusCode: 200, body: 'connected' };
};
