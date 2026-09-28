import { z } from 'zod';

/**
 * What the vision pass returns for one reel.
 *
 * The shape is driven by what Ask has to answer. "Which cafe is in this reel"
 * needs a named place, the verbatim text it was read from, and the timestamp
 * that text appeared at, so the answer can cite {media_id, ts_ms} and the UI
 * can jump the player there. `basis` keeps a name read off a sign separate
 * from a guess, because an ungrounded answer is worse than no answer.
 */

export const EvidenceSchema = z.object({
  ts_ms: z.number().describe('timestamp of the frame this evidence was read from'),
  text: z.string().describe('the text as it appears in the frame, verbatim'),
  kind: z.enum(['signage', 'menu', 'street_sign', 'on_screen_caption', 'other']),
});

export const PlaceSchema = z.object({
  name: z.string().describe('the place name as written, or a short description when it has no visible name'),
  kind: z.enum(['cafe', 'restaurant', 'bakery', 'bar', 'shop', 'hotel', 'landmark', 'city', 'other']),
  basis: z
    .enum(['read_from_frame', 'from_caption', 'inferred'])
    .describe('read_from_frame only when the name is legible in a frame; inferred when reasoning from style or architecture'),
  evidence: z.array(EvidenceSchema).describe('empty only when basis is inferred'),
});

export const AnalysedFrameSchema = z.object({
  ts_ms: z.number(),
  description: z.string().describe('what is happening in the frame, written for search and question answering'),
  ocr_text: z.string().describe('every piece of text legible in the frame, verbatim; empty string when there is none'),
});

export const AnalysisSchema = z.object({
  reel_summary: z.string().describe('what the reel is about, in two or three sentences'),
  language: z.string().describe('BCP-47 code of the dominant language, or "und" when unclear'),
  cta: z.string().describe('call to action the reel makes, empty string when there is none'),
  caption_from_frames: z
    .string()
    .describe('the post caption if it is legible in the frames, verbatim; empty string otherwise'),
  entities: z.array(z.string()).describe('products, brands, dishes and named things worth searching for'),
  places: z.array(PlaceSchema),
  frames: z.array(AnalysedFrameSchema).describe('one entry per labelled ts_ms, using exactly those values'),
});

export type Analysis = z.infer<typeof AnalysisSchema>;
export type Place = z.infer<typeof PlaceSchema>;

/** Hashtags and @mentions, from whichever caption we ended up with. */
export function captionFacts(caption: string | undefined) {
  if (!caption) return { hashtags: [], mentions: [] };
  return {
    hashtags: [...new Set(caption.match(/#[\p{L}\p{N}_]+/gu) ?? [])],
    mentions: [...new Set(caption.match(/@[A-Za-z0-9._]+/g) ?? [])],
  };
}

/**
 * Drops frames the model invented or mislabelled: only timestamps we actually
 * sent are allowed, so a hallucinated ts_ms can never become a citation.
 */
export function reconcileFrames(analysed: Analysis['frames'], sentTimestamps: number[]) {
  const sent = new Set(sentTimestamps);
  const byTs = new Map<number, Analysis['frames'][number]>();
  for (const frame of analysed) {
    if (sent.has(frame.ts_ms) && !byTs.has(frame.ts_ms)) byTs.set(frame.ts_ms, frame);
  }
  return {
    matched: [...byTs.values()],
    missing: sentTimestamps.filter((ts) => !byTs.has(ts)),
    unexpected: analysed.filter((f) => !sent.has(f.ts_ms)).map((f) => f.ts_ms),
  };
}

/**
 * Evidence must point at a real frame too, and a place claiming to be read
 * from a frame without any evidence is downgraded rather than trusted.
 */
export function sanitisePlaces(places: Place[], sentTimestamps: number[]): Place[] {
  const sent = new Set(sentTimestamps);
  return places.map((place) => {
    const evidence = place.evidence.filter((e) => sent.has(e.ts_ms) && e.text.trim().length > 0);
    const basis = place.basis === 'read_from_frame' && evidence.length === 0 ? 'inferred' : place.basis;
    return { ...place, evidence, basis };
  });
}
