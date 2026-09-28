import { GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import { handler, pathParam } from '../shared/http';
import type { MediaRecord } from '../shared/media';
import { purgeDerived, purgeObjects } from './purge';

/**
 * DELETE /media/{id} — drop the record, its frames, its caption facts, every
 * object under its prefix, and its documents in the vector index.
 *
 * The index matters: a document left behind stays retrievable, so Ask would go
 * on citing a reel the user deleted.
 */
export const main = handler(async (event) => {
  const id = pathParam(event, 'id');

  const result = await ddb.send(new GetCommand({ TableName: TABLES.media, Key: { id } }));
  const media = result.Item as MediaRecord | undefined;

  // Deliberately idempotent: a delete that failed halfway leaves objects, rows
  // or index documents behind, and retrying has to finish the job rather than
  // 404 because the media row is already gone.
  if (!media) console.log('media row already gone; cleaning up whatever remains', { id });

  const objectsRemoved = await purgeObjects(id, { keepOriginal: false });
  const purged = await purgeDerived(id);

  await ddb.send(new DeleteCommand({ TableName: TABLES.media, Key: { id } }));

  return { deleted: id, objectsRemoved, ...purged };
});
