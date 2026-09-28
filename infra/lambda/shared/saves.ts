import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb';
import { addUsage } from './ledger';

const SAVES_TABLE = process.env.SAVES_TABLE!;

export const SAVES_BY_SAVED_AT = 'bySavedAt';
export const SAVES_BY_MEDIA = 'byMedia';

/**
 * Who has what.
 *
 * Content is global — two people who save the same reel share one download, one
 * analysis and one set of index documents — so this table is the only thing
 * that knows a library is a library. Everything a caller is allowed to see is
 * reachable from here and nowhere else.
 */
export interface Save {
  user_id: string;
  media_id: string;
  saved_at: string;
}

export async function saveMedia(userId: string, mediaId: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: SAVES_TABLE,
      Item: { user_id: userId, media_id: mediaId, saved_at: new Date().toISOString() },
      // Saving twice keeps the first timestamp: the library orders by when the
      // user first took it, and re-pasting a link should not reorder it.
      ConditionExpression: 'attribute_not_exists(user_id)',
    }),
  )
    .then(() => addUsage(userId, { saves: 1 }))
    .catch((err) => {
      // Already saved: keep the first timestamp and do not count it twice.
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
      throw err;
    });
}

export async function unsaveMedia(userId: string, mediaId: string): Promise<void> {
  await ddb.send(
    new DeleteCommand({ TableName: SAVES_TABLE, Key: { user_id: userId, media_id: mediaId } }),
  );
}

/** One get, which is what an authorisation check should cost. */
export async function hasSaved(userId: string, mediaId: string): Promise<boolean> {
  const row = await ddb.send(
    new GetCommand({
      TableName: SAVES_TABLE,
      Key: { user_id: userId, media_id: mediaId },
      ProjectionExpression: 'media_id',
    }),
  );
  return Boolean(row.Item);
}

/**
 * Every media id this caller may see.
 *
 * Paginated to the end rather than to a page: a partial list would silently
 * narrow what someone can search, which reads as missing data rather than as an
 * error. The list grows with the library — see the ceiling noted in
 * DATA-MODEL.md, which wants measuring before anyone has thousands.
 */
export async function savedMediaIds(userId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: Record<string, unknown> | undefined;

  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: SAVES_TABLE,
        KeyConditionExpression: 'user_id = :u',
        ExpressionAttributeValues: { ':u': userId },
        ProjectionExpression: 'media_id',
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of page.Items ?? []) ids.push(String(item.media_id));
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  return ids;
}

/** Who to tell when a piece of content changes state. */
export async function saversOf(mediaId: string): Promise<string[]> {
  const page = await ddb.send(
    new QueryCommand({
      TableName: SAVES_TABLE,
      IndexName: SAVES_BY_MEDIA,
      KeyConditionExpression: 'media_id = :m',
      ExpressionAttributeValues: { ':m': mediaId },
      ProjectionExpression: 'user_id',
    }),
  );
  return (page.Items ?? []).map((item) => String(item.user_id));
}
