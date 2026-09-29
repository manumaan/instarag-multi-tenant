import { badRequest } from './http';

/** Lens query images live under their own prefix and expire on a lifecycle rule. */
export const LENS_PREFIX = 'lens/';

/**
 * A screenshot someone searched with is theirs, not content: nobody else saves
 * it, nothing derives from it and it is gone in a day. So unlike `media/`,
 * which is deliberately shared, this prefix carries the owner.
 */
export const lensPrefixFor = (userId: string) => `${LENS_PREFIX}${userId}/`;

/**
 * A key arrives in the request body, so it is the caller's to choose. The
 * prefix is what makes a borrowed one useless: a key under somebody else's
 * partition is refused before the object is read.
 */
export function requireOwnLensKey(userId: string, key: string): string {
  if (!key.startsWith(lensPrefixFor(userId))) throw badRequest('s3Key must be one of your own lens uploads');
  return key;
}
