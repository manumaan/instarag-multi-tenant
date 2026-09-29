import { getMedia, type Citation } from './api';

/*
 * Pictures for cited moments.
 *
 * A plan item cites {media_id, ts_ms}, and that moment is a keyframe the
 * pipeline already stored — so the picture next to a tip is the frame the tip
 * was read from, not an illustration. GET /media/{id} already returns every
 * frame with a presigned URL, so this needs no backend change: one call per
 * cited reel, however many tips cite it.
 *
 * A spoken moment (a transcript segment) has no frame at its exact time, so it
 * takes the nearest frame at or before it — what was on screen as it was said.
 */

/** Presigned URLs last 15 minutes; refetch a little before that. */
const TTL_MS = 12 * 60 * 1000;
const cache = new Map<string, { at: number; frames: Promise<Array<{ ts_ms: number; url?: string }>> }>();

function framesOf(mediaId: string) {
  const hit = cache.get(mediaId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.frames;
  const frames = getMedia(mediaId)
    .then((d) => d.frames.map((f) => ({ ts_ms: f.ts_ms, url: f.url })).sort((a, b) => a.ts_ms - b.ts_ms))
    .catch(() => {
      cache.delete(mediaId); // a failure should not stick for twelve minutes
      return [];
    });
  cache.set(mediaId, { at: Date.now(), frames });
  return frames;
}

export const frameKey = (c: Citation) => `${c.media_id}:${c.ts_ms}`;

/** frameKey → image URL, for every citation that has a picture. */
export async function framePictures(citations: Citation[]): Promise<Map<string, string>> {
  const byMedia = new Map<string, Citation[]>();
  for (const c of citations) byMedia.set(c.media_id, [...(byMedia.get(c.media_id) ?? []), c]);

  const pictures = new Map<string, string>();
  await Promise.all(
    [...byMedia].map(async ([mediaId, cited]) => {
      const frames = await framesOf(mediaId);
      for (const c of cited) {
        const exact = frames.find((f) => f.ts_ms === c.ts_ms);
        const nearest = exact ?? [...frames].reverse().find((f) => f.ts_ms <= c.ts_ms) ?? frames[0];
        if (nearest?.url) pictures.set(frameKey(c), nearest.url);
      }
    }),
  );
  return pictures;
}
