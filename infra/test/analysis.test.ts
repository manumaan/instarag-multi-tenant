import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionFacts, reconcileFrames, sanitisePlaces, type Place } from '../lambda/analyse/schema';
import { buildInstruction } from '../lambda/analyse/prompt';

test('captionFacts pulls hashtags and mentions, deduplicated', () => {
  const caption = 'PARIS is the food capital!!\n\nThanks @no_diet_club and @no_diet_club\n#fyp #food #paris #food';
  const facts = captionFacts(caption);
  assert.deepEqual(facts.hashtags, ['#fyp', '#food', '#paris']);
  assert.deepEqual(facts.mentions, ['@no_diet_club']);
});

test('captionFacts copes with no caption at all', () => {
  assert.deepEqual(captionFacts(undefined), { hashtags: [], mentions: [] });
  assert.deepEqual(captionFacts('no tags here'), { hashtags: [], mentions: [] });
});

test('reconcileFrames drops timestamps we never sent', () => {
  const sent = [0, 1667, 3033];
  const result = reconcileFrames(
    [
      { ts_ms: 0, description: 'a', ocr_text: '' },
      { ts_ms: 9999, description: 'invented', ocr_text: '' },
      { ts_ms: 3033, description: 'c', ocr_text: 'BOULANGERIE' },
    ],
    sent,
  );
  assert.deepEqual(result.matched.map((f) => f.ts_ms), [0, 3033]);
  assert.deepEqual(result.missing, [1667]);
  assert.deepEqual(result.unexpected, [9999]);
});

test('reconcileFrames keeps the first entry when a timestamp repeats', () => {
  const result = reconcileFrames(
    [
      { ts_ms: 0, description: 'first', ocr_text: '' },
      { ts_ms: 0, description: 'second', ocr_text: '' },
    ],
    [0],
  );
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].description, 'first');
});

test('a place claiming to be read from a frame without evidence is downgraded', () => {
  const places: Place[] = [
    { name: 'Invented Cafe', kind: 'cafe', basis: 'read_from_frame', evidence: [] },
    {
      name: "L'As du Fallafel",
      kind: 'restaurant',
      basis: 'read_from_frame',
      evidence: [
        { ts_ms: 4667, text: "L'AS DU FALLAFEL", kind: 'signage' },
        { ts_ms: 99999, text: 'not a real frame', kind: 'signage' },
        { ts_ms: 4667, text: '   ', kind: 'signage' },
      ],
    },
  ];
  const [invented, real] = sanitisePlaces(places, [4667, 10300]);
  assert.equal(invented.basis, 'inferred', 'no evidence means it was not read');
  assert.equal(real.basis, 'read_from_frame');
  assert.deepEqual(real.evidence.map((e) => e.ts_ms), [4667], 'evidence must point at a frame we sent');
});

test('the instruction tells the model to read the caption only when we lack one', () => {
  const withCaption = buildInstruction({ caption: 'PARIS food capital #paris' });
  assert.match(withCaption, /Caption posted with the reel/);
  assert.match(withCaption, /Leave caption_from_frames empty/);

  const without = buildInstruction({});
  assert.match(without, /no caption stored/);
  assert.doesNotMatch(without, /Leave caption_from_frames empty/);
});

test('the instruction demands grounded places and exact timestamps', () => {
  const instruction = buildInstruction({ caption: 'x' });
  assert.match(instruction, /one frames entry per labelled ts_ms/);
  assert.match(instruction, /read_from_frame only when the name is actually legible/);
  assert.match(instruction, /Never present an inferred/);
});

test('a carousel is described as slides, not as a timeline', () => {
  const carousel = buildInstruction({ isCarousel: true, caption: 'five tips' });
  assert.match(carousel, /slides of one Instagram carousel post/);
  assert.match(carousel, /encodes the slide number rather than a time/);
  // The summary should describe the argument across slides, not just each image.
  assert.match(carousel, /what the post as a whole is saying/);
  assert.match(carousel, /Caption posted with the carousel/);
  assert.doesNotMatch(carousel, /keyframes of one Instagram reel/);
});

test('a reel is still described as a reel', () => {
  const reel = buildInstruction({ caption: 'paris food' });
  assert.match(reel, /keyframes of one Instagram reel/);
  assert.match(reel, /Caption posted with the reel/);
  assert.doesNotMatch(reel, /carousel/);
});

test('both forms still demand one entry per labelled ts_ms and grounded places', () => {
  for (const instruction of [buildInstruction({}), buildInstruction({ isCarousel: true })]) {
    assert.match(instruction, /one frames entry per labelled ts_ms/);
    assert.match(instruction, /read_from_frame only when the name is actually legible/);
    assert.match(instruction, /Never present an inferred/);
  }
});
