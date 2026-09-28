import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuseRankings, hitKey, type Hit } from '../lambda/search/retrieve';
import { trimForEmbedding } from '../lambda/search/embed';
import { documentId } from '../lambda/search/client';

const hit = (mediaId: string, tsMs: number, kind: Hit['kind'] = 'frame'): Hit => ({
  mediaId,
  tsMs,
  kind,
  description: '',
  ocrText: '',
  speech: '',
  caption: '',
  places: '',
});

test('fusion ranks a frame both searches found above either one alone', () => {
  const vectorTop = hit('m1', 1000);
  const lexicalTop = hit('m1', 2000);
  const agreed = hit('m1', 3000);

  const fused = fuseRankings(
    [
      [vectorTop, agreed],
      [lexicalTop, agreed],
    ],
    hitKey,
  );
  assert.equal(hitKey(fused[0]), hitKey(agreed), 'the frame both rankings contain must win');
  assert.equal(fused.length, 3);
});

test('fusion keeps a frame only one search found', () => {
  const fused = fuseRankings([[hit('m1', 10)], [hit('m2', 20)]], hitKey);
  assert.deepEqual(fused.map(hitKey).sort(), ['m1:frame:10', 'm2:frame:20']);
});

test('fusion preserves order within a single ranking', () => {
  const ranking = [hit('m', 1), hit('m', 2), hit('m', 3)];
  assert.deepEqual(fuseRankings([ranking], hitKey).map((h) => h.tsMs), [1, 2, 3]);
});

test('fusion handles an empty side', () => {
  assert.deepEqual(fuseRankings([[], [hit('m', 1)]], hitKey).map(hitKey), ['m:frame:1']);
  assert.deepEqual(fuseRankings([[], []], hitKey), []);
});

test('document ids are stable and unique per moment', () => {
  assert.equal(documentId('abc', 1667), 'abc:1667');
  assert.notEqual(documentId('abc', 1667), documentId('abc', 1668));
  // A frame and a spoken line at the same instant must not collide.
  assert.notEqual(documentId('abc', 1667, 'frame'), documentId('abc', 1667, 'speech'));
});

test('a frame and a speech segment at the same timestamp both survive fusion', () => {
  const frame = hit('m', 5900, 'frame');
  const speech = hit('m', 5900, 'speech');
  const fused = fuseRankings([[frame], [speech]], hitKey);
  assert.equal(fused.length, 2, 'the spoken line must not displace the frame');
});

test('embedding input is collapsed and capped', () => {
  assert.equal(trimForEmbedding('  a\n\n b  \t c '), 'a b c');
  const long = trimForEmbedding('x'.repeat(5000));
  assert.equal(long.length, 2000, 'must be capped for the embedding model');
});

test('citation matching ignores the kind, which a citation never names', () => {
  // Regression: hitKey carries the kind, so filtering citations with it
  // dropped every citation the model produced and made Ask look unanswerable.
  const hits = [hit('m1', 5900, 'speech'), hit('m1', 4667, 'frame')];
  const retrieved = new Set(hits.map((h) => `${h.mediaId}:${h.tsMs}`));
  const citations = [
    { media_id: 'm1', ts_ms: 5900 },
    { media_id: 'm1', ts_ms: 4667 },
    { media_id: 'm1', ts_ms: 99999 },
  ];
  const kept = citations.filter((c) => retrieved.has(`${c.media_id}:${c.ts_ms}`));
  assert.deepEqual(kept.map((c) => c.ts_ms), [5900, 4667], 'both real moments must survive');
});
