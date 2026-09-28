/**
 * DCT-based perceptual hash, used to drop near-duplicate keyframes.
 *
 * 32x32 grayscale -> DCT-II -> the 8x8 lowest-frequency coefficients (minus the
 * DC term) -> one bit per coefficient against their median. Two frames of the
 * same shot land within a few bits of each other; a real scene change does not.
 */

export const HASH_SIZE = 8;
export const IMAGE_SIZE = 32;

/** Precomputed cosine table: cos((2x+1) * u * pi / 2N). */
const COS = (() => {
  const table = new Float64Array(IMAGE_SIZE * IMAGE_SIZE);
  for (let x = 0; x < IMAGE_SIZE; x++) {
    for (let u = 0; u < IMAGE_SIZE; u++) {
      table[x * IMAGE_SIZE + u] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * IMAGE_SIZE));
    }
  }
  return table;
})();

/** Separable 2-D DCT-II of a 32x32 plane. */
function dct2d(pixels: Uint8Array): Float64Array {
  const rows = new Float64Array(IMAGE_SIZE * IMAGE_SIZE);
  for (let y = 0; y < IMAGE_SIZE; y++) {
    for (let u = 0; u < IMAGE_SIZE; u++) {
      let sum = 0;
      for (let x = 0; x < IMAGE_SIZE; x++) sum += pixels[y * IMAGE_SIZE + x] * COS[x * IMAGE_SIZE + u];
      rows[y * IMAGE_SIZE + u] = sum;
    }
  }
  const out = new Float64Array(IMAGE_SIZE * IMAGE_SIZE);
  for (let u = 0; u < IMAGE_SIZE; u++) {
    for (let v = 0; v < IMAGE_SIZE; v++) {
      let sum = 0;
      for (let y = 0; y < IMAGE_SIZE; y++) sum += rows[y * IMAGE_SIZE + u] * COS[y * IMAGE_SIZE + v];
      out[v * IMAGE_SIZE + u] = sum;
    }
  }
  return out;
}

/** 64-bit hash as 16 lowercase hex characters. */
export function phash(gray: Uint8Array): string {
  if (gray.length !== IMAGE_SIZE * IMAGE_SIZE) {
    throw new Error(`phash expects ${IMAGE_SIZE * IMAGE_SIZE} grayscale bytes, got ${gray.length}`);
  }
  const dct = dct2d(gray);

  // Low-frequency block, skipping the DC term (it only carries overall brightness).
  const coefficients: number[] = [];
  for (let v = 0; v < HASH_SIZE; v++) {
    for (let u = 0; u < HASH_SIZE; u++) {
      if (u === 0 && v === 0) continue;
      coefficients.push(dct[v * IMAGE_SIZE + u]);
    }
  }

  const sorted = [...coefficients].sort((a, b) => a - b);
  const median = (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2;

  // 63 coefficients + a leading 0 so the hash is a round 64 bits.
  let bits = 0n;
  for (const coefficient of coefficients) bits = (bits << 1n) | (coefficient > median ? 1n : 0n);
  return bits.toString(16).padStart(16, '0');
}

export function hammingDistance(a: string, b: string): number {
  let xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (xor) {
    xor &= xor - 1n;
    distance++;
  }
  return distance;
}

export interface Hashable {
  phash: string;
}

/**
 * Keeps frames in order, dropping any whose hash is within `threshold` bits of
 * one already kept. The first frame always survives: it is the cover.
 *
 * When more distinct frames survive than the cap allows, they are thinned
 * across the whole reel rather than truncated at the cap. Truncating meant a
 * long reel was only ever analysed up to the point the cap ran out — a 46s reel
 * stopped at 28s and nothing after that was described, indexed or answerable.
 */
export function dedupeByPhash<T extends Hashable>(frames: T[], threshold: number, cap: number): T[] {
  const distinct: T[] = [];
  for (const frame of frames) {
    const isDuplicate = distinct.some((k) => hammingDistance(k.phash, frame.phash) < threshold);
    if (!isDuplicate) distinct.push(frame);
  }
  return thinEvenly(distinct, cap);
}

/**
 * Reduces a list to at most `cap` entries, keeping the first and last and
 * spreading the rest evenly. Order is preserved.
 */
export function thinEvenly<T>(items: T[], cap: number): T[] {
  if (cap <= 0) return [];
  if (items.length <= cap) return items;
  if (cap === 1) return [items[0]];

  const kept: T[] = [];
  const step = (items.length - 1) / (cap - 1);
  for (let i = 0; i < cap; i++) kept.push(items[Math.round(i * step)]);
  return kept;
}
