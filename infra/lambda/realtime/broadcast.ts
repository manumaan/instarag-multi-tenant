import type { DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { ddb } from '../shared/ddb';

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;
const management = new ApiGatewayManagementApiClient({ endpoint: process.env.WS_MANAGEMENT_ENDPOINT! });

/**
 * Pushes media changes to open WebSocket connections.
 *
 * Driven by the media table's stream rather than called from the pipeline, so
 * every status transition is broadcast no matter what caused it.
 */
export const main = async (event: DynamoDBStreamEvent) => {
  const changed = event.Records.flatMap((record) => {
    if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') return [];
    const image = record.dynamodb?.NewImage;
    if (!image) return [];
    const media = unmarshall(image as Record<string, AttributeValue>);
    const previous = record.dynamodb?.OldImage
      ? unmarshall(record.dynamodb.OldImage as Record<string, AttributeValue>)
      : undefined;
    // Only the transitions matter; frame writes live in another table anyway.
    if (previous && previous.status === media.status) return [];
    return [media];
  });
  if (changed.length === 0) return;

  const connections = await ddb.send(
    new ScanCommand({ TableName: CONNECTIONS_TABLE, ProjectionExpression: 'connection_id' }),
  );
  console.log('broadcasting', {
    changes: changed.map((m) => `${m.id}:${m.status}`),
    connections: connections.Items?.length ?? 0,
  });

  await Promise.all(
    (connections.Items ?? []).flatMap((connection) =>
      changed.map(async (media) => {
        const connectionId = connection.connection_id as string;
        try {
          await management.send(
            new PostToConnectionCommand({
              ConnectionId: connectionId,
              Data: Buffer.from(JSON.stringify({ type: 'media', media })),
            }),
          );
        } catch (err) {
          // 410 Gone: the browser went away without a $disconnect.
          if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 410) {
            await ddb.send(
              new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: { connection_id: connectionId } }),
            );
          } else {
            console.error('post to connection failed', { connectionId, err });
          }
        }
      }),
    ),
  );
};
