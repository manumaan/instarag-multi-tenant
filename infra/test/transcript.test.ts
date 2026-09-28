import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectedLanguage,
  fullTranscript,
  mergeShortSegments,
  parseSegments,
  splitLongSegments,
  type TranscribeOutput,
} from '../lambda/transcript/parse';

const output: TranscribeOutput = {
  results: {
    transcripts: [{ transcript: 'Paris should be the food capital. One bite and I was speechless.' }],
    audio_segments: [
      { id: 0, start_time: '0.0', end_time: '2.84', transcript: 'Paris should be the food capital.' },
      { id: 1, start_time: '3.1', end_time: '3.6', transcript: 'One bite' },
      { id: 2, start_time: '3.7', end_time: '5.9', transcript: 'and I was speechless.' },
      { id: 3, start_time: '6.0', end_time: '7.0', transcript: '   ' },
    ],
    language_identification: [{ code: 'en-US', score: '0.99' }],
    language_code: 'en-GB',
  },
};

test('segments parse to milliseconds and drop the empty ones', () => {
  const segments = parseSegments(output);
  assert.equal(segments.length, 3, 'the whitespace-only segment must go');
  assert.deepEqual(segments[0], {
    start_ms: 0,
    end_ms: 2840,
    text: 'Paris should be the food capital.',
  });
});

test('segments come back in timestamp order even if the input is not', () => {
  const shuffled: TranscribeOutput = {
    results: {
      audio_segments: [
        { start_time: '5.0', end_time: '6.0', transcript: 'second' },
        { start_time: '1.0', end_time: '2.0', transcript: 'first' },
      ],
    },
  };
  assert.deepEqual(parseSegments(shuffled).map((s) => s.text), ['first', 'second']);
});

test('a sentence split across two short segments is merged', () => {
  const merged = mergeShortSegments(parseSegments(output));
  assert.equal(merged.length, 2, 'the half-second fragment must join its neighbour');
  assert.equal(merged[1].text, 'One bite and I was speechless.');
  assert.equal(merged[1].start_ms, 3100, 'the merged segment keeps the earlier start');
  assert.equal(merged[1].end_ms, 5900, 'and the later end, so the citation spans both');
});

test('merging leaves segments that are long enough alone', () => {
  const long = [
    { start_ms: 0, end_ms: 4000, text: 'a long line' },
    { start_ms: 4100, end_ms: 8000, text: 'another long line' },
  ];
  assert.deepEqual(mergeShortSegments(long), long);
});

test('merging does not bridge a real pause', () => {
  const across = [
    { start_ms: 0, end_ms: 4000, text: 'before the pause' },
    { start_ms: 9000, end_ms: 9400, text: 'after' },
  ];
  assert.equal(mergeShortSegments(across).length, 2, 'a 5s gap is not one sentence');
});

test('the identified language wins over the declared one', () => {
  assert.equal(detectedLanguage(output), 'en-US');
  assert.equal(detectedLanguage({ results: { language_code: 'fr-FR' } }), 'fr-FR');
  assert.equal(detectedLanguage({}), undefined);
});

test('the full transcript is the joined text', () => {
  assert.match(fullTranscript(output), /^Paris should be the food capital\./);
  assert.equal(fullTranscript({}), '');
});

test('a long segment is split at sentence boundaries with apportioned times', () => {
  // The real shape Transcribe returned: one ~21s block of several sentences.
  const long = [
    {
      start_ms: 0,
      end_ms: 21400,
      text: 'I wish you could taste this. We met our guide and started with falafel. One bite and I was speechless. Then came the macarons at Pierre Herme.',
    },
  ];
  const split = splitLongSegments(long, 10000);
  assert.ok(split.length > 1, 'a 21s block must not stay one citation');
  for (const segment of split) {
    assert.ok(segment.end_ms - segment.start_ms <= 21400, 'no segment may exceed the original');
    assert.ok(segment.text.trim().length > 0);
  }
  assert.equal(split[0].start_ms, 0, 'the first split keeps the original start');
  assert.equal(split[split.length - 1].end_ms, 21400, 'the last split keeps the original end');
  // Times must stay ordered and non-overlapping, or the player jumps backwards.
  for (let i = 1; i < split.length; i++) {
    assert.ok(split[i].start_ms >= split[i - 1].end_ms - 1, `segment ${i} overlaps its predecessor`);
  }
  assert.equal(split.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim(), long[0].text);
});

test('a short segment and an unsplittable one are left alone', () => {
  const short = [{ start_ms: 0, end_ms: 4000, text: 'One sentence only.' }];
  assert.deepEqual(splitLongSegments(short, 10000), short);
  // No sentence boundary to split on: better one long citation than a guess.
  const noBoundary = [{ start_ms: 0, end_ms: 30000, text: 'a '.repeat(200).trim() }];
  assert.equal(splitLongSegments(noBoundary, 10000).length, 1);
});
