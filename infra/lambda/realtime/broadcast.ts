import type { DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { ddb } from '../shared/ddb';
import { saversOf } from '../shared/saves';

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;
const CONNECTIONS_BY_USER = 'byUser';
const management = new ApiGatewayManagementApiClient({ endpoint: process.env.WS_MANAGEMENT_ENDPOINT! });

/**
 * Pushes content changes to the sockets of the people who hold that content.
 *
 * Driven by the media table's stream rather than called from the pipeline, so
 * every status transition is broadcast no matter what caused it.
 *
 * The single-user version scanned every open connection and pushed every change
 * to all of them, which multi-tenancy turns into a leak — one person's reel
 * arriving in someone else's browser with its caption and analysis attached.
 * Content is shared, so a change belongs to whoever saved it: `saves.byMedia`
 * answers who that is, and their sockets come from the `byUser` index.
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

  /*
   * Who is entitled to each change. Resolved per change rather than once,
   * because two reels in one batch can belong to different people — and cached
   * per user, because in the common case they do not.
   *
   * An INSERT can arrive before the ingest has written its save, since the media
   * row goes in first, so the very first `queued` push may reach nobody. That is
   * harmless: whoever triggered it already has the record from the response that
   * created it, and the next transition finds the save.
   */
  const deliveries = new Map<string, Record<string, unknown>[]>();
  const socketsOf = new Map<string, string[]>();

  for (const media of changed) {
    for (const userId of await saversOf(String(media.id))) {
      if (!socketsOf.has(userId)) {
        const open = await ddb.send(
          new QueryCommand({
            TableName: CONNECTIONS_TABLE,
            IndexName: CONNECTIONS_BY_USER,
            KeyConditionExpression: 'user_id = :u',
            ExpressionAttributeValues: { ':u': userId },
            ProjectionExpression: 'connection_id',
          }),
        );
        socketsOf.set(userId, (open.Items ?? []).map((item) => String(item.connection_id)));
      }
      for (const connectionId of socketsOf.get(userId) ?? []) {
        deliveries.set(connectionId, [...(deliveries.get(connectionId) ?? []), media]);
      }
    }
  }

  console.log('broadcasting', {
    changes: changed.map((m) => `${m.id}:${m.status}`),
    recipients: socketsOf.size,
    sockets: deliveries.size,
  });

  await Promise.all(
    [...deliveries].flatMap(([connectionId, items]) =>
      items.map(async (media) => {
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
