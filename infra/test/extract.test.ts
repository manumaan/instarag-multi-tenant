import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedupeByPhash, hammingDistance, phash, thinEvenly, IMAGE_SIZE } from '../extract/src/phash';
import { parseShowinfoTimestamps } from '../extract/src/ffmpeg';

const SIZE = IMAGE_SIZE * IMAGE_SIZE;

/** A deterministic synthetic frame: diagonal gradient plus a bright blob. */
function frame(seed: number, blobX = 8, blobY = 8): Uint8Array {
  const pixels = new Uint8Array(SIZE);
  for (let y = 0; y < IMAGE_SIZE; y++) {
    for (let x = 0; x < IMAGE_SIZE; x++) {
      const inBlob = Math.abs(x - blobX) < 5 && Math.abs(y - blobY) < 5;
      pixels[y * IMAGE_SIZE + x] = (x * 4 + y * 3 + seed * 17 + (inBlob ? 120 : 0)) % 256;
    }
  }
  return pixels;
}

/** Sensor-noise-sized perturbation: the kind of change dedupe must ignore. */
function withNoise(pixels: Uint8Array, amplitude: number): Uint8Array {
  const out = new Uint8Array(pixels);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.max(0, Math.min(255, out[i] + ((i * 7919) % (2 * amplitude + 1)) - amplitude));
  }
  return out;
}

test('phash is 64 bits of hex and stable for the same input', () => {
  const hash = phash(frame(1));
  assert.match(hash, /^[0-9a-f]{16}$/);
  assert.equal(hash, phash(frame(1)));
  assert.equal(hammingDistance(hash, hash), 0);
});

test('phash rejects a plane that is not 32x32', () => {
  assert.throws(() => phash(new Uint8Array(100)), /expects 1024 grayscale bytes/);
});

test('noise leaves the hash within the dedupe threshold, a new shot does not', () => {
  const base = frame(1);
  const noisy = hammingDistance(phash(base), phash(withNoise(base, 6)));
  const differentShot = hammingDistance(phash(base), phash(frame(1, 24, 26)));
  assert.ok(noisy < 8, `noise moved the hash ${noisy} bits, expected < 8`);
  assert.ok(differentShot >= 8, `a different shot moved the hash only ${differentShot} bits`);
});

test('dedupe keeps the cover first and drops near-duplicates', () => {
  const base = frame(1);
  const frames = [
    { phash: phash(base), tag: 'cover' },
    { phash: phash(withNoise(base, 4)), tag: 'same-shot' },
    { phash: phash(frame(1, 24, 26)), tag: 'second-shot' },
  ];
  const kept = dedupeByPhash(frames, 8, 12).map((f) => f.tag);
  assert.deepEqual(kept, ['cover', 'second-shot']);
});

test('dedupe never returns more than the frame cap', () => {
  const frames = Array.from({ length: 30 }, (_, i) => ({ phash: phash(frame(i + 1, i % 32, (i * 3) % 32)) }));
  assert.ok(dedupeByPhash(frames, 8, 12).length <= 12);
  assert.ok(dedupeByPhash(frames, 0, 12).length <= 12);
});

test('showinfo timestamps parse to milliseconds in emission order', () => {
  const stderr = [
    '[Parsed_showinfo_1 @ 0x1] n:0 pts:0 pts_time:0 pos:1 fmt:yuvj420p',
    '[Parsed_showinfo_1 @ 0x1] n:1 pts:53000 pts_time:1.767 pos:2 fmt:yuvj420p',
    '[Parsed_showinfo_1 @ 0x1] n:2 pts:120000 pts_time:4.004 pos:3 fmt:yuvj420p',
  ].join('\n');
  assert.deepEqual(parseShowinfoTimestamps(stderr), [0, 1767, 4004]);
  assert.deepEqual(parseShowinfoTimestamps('nothing here'), []);
});

test('thinning keeps the ends and spreads the middle', () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual(thinEvenly(items, 10), items, 'no thinning needed');
  assert.deepEqual(thinEvenly(items, 4), [0, 3, 6, 9], 'first and last kept, middle spread');
  assert.deepEqual(thinEvenly(items, 1), [0]);
  assert.deepEqual(thinEvenly(items, 0), []);
  assert.deepEqual(thinEvenly([], 5), []);
});

test('a long reel is covered end to end rather than truncated at the cap', () => {
  // 40 distinct shots across a 46s reel, cap 20: the real failure this fixes is
  // the tail going missing, so the last shot must survive.
  const shots = Array.from({ length: 40 }, (_, i) => ({
    phash: phash(frame(i + 1, i % 32, (i * 5) % 32)),
    tsMs: i * 1150,
  }));
  const kept = dedupeByPhash(shots, 8, 20);
  assert.ok(kept.length <= 20, `kept ${kept.length}`);
  assert.equal(kept[0].tsMs, 0, 'the cover must survive');
  assert.equal(
    kept[kept.length - 1].tsMs,
    shots[shots.length - 1].tsMs,
    'the end of the reel must survive the cap',
  );
  const spread = kept[kept.length - 1].tsMs - kept[0].tsMs;
  assert.ok(spread > 40000, `frames only span ${spread}ms of a 46s reel`);
});
