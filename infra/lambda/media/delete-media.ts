import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import { callerId, handler, pathParam } from '../shared/http';
import { hasSaved, saversOf, unsaveMedia } from '../shared/saves';
import { purgeDerived, purgeObjects } from './purge';

/**
 * DELETE /media/{id} — remove it from the caller's library.
 *
 * This is the change multi-tenancy forces, and it is not cosmetic. Content is
 * shared: one download, one analysis and one set of index documents serve
 * everyone who saved a reel. So deleting has to mean *unsaving*, or the first
 * person to tidy up would empty a reel out of everyone else's library, taking
 * the 13.2¢ analysis and the downloaded video with it.
 *
 * The content itself is purged only when the last saver lets go. Nothing is
 * reference-counted: the saves table is asked who is left, which is the same
 * question and cannot drift out of step with reality.
 */
export const main = handler(async (event) => {
  const id = pathParam(event, 'id');
  const userId = callerId(event);

  // Idempotent on purpose, as before: a delete that half-finished has to be
  // completable, so a caller who no longer holds it still drives the cleanup
  // check rather than getting a 404.
  if (await hasSaved(userId, id)) await unsaveMedia(userId, id);

  const remaining = await saversOf(id);
  if (remaining.length > 0) {
    return { removedFromLibrary: id, contentKept: true, remainingSavers: remaining.length };
  }

  /*
   * Nobody holds it now, so the content goes. The index matters most: a document
   * left behind stays retrievable, and Ask would go on citing a reel that is in
   * nobody's library.
   *
   * Two people unsaving at the same instant can both see an empty list and both
   * purge. That is tolerable because every step here is idempotent — it was
   * already built that way for half-finished deletes.
   */
  const objectsRemoved = await purgeObjects(id, { keepOriginal: false });
  const purged = await purgeDerived(id);
  await ddb.send(new DeleteCommand({ TableName: TABLES.media, Key: { id } }));

  return { removedFromLibrary: id, contentKept: false, objectsRemoved, ...purged };
});
