import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstagramUrl, ALLOWED_CONTENT_TYPES } from '../lambda/shared/media';
import { encodeCursor, decodeCursor } from '../lambda/shared/ddb';

test('parseInstagramUrl normalises the permalink shapes we accept', () => {
  const cases: Array<[string, { permalink: string; type: string }]> = [
    ['https://www.instagram.com/reel/Cx1y2z3AbCd/', { permalink: 'https://www.instagram.com/reel/Cx1y2z3AbCd/', type: 'reel' }],
    ['https://instagram.com/reels/Cx1y2z3AbCd', { permalink: 'https://www.instagram.com/reel/Cx1y2z3AbCd/', type: 'reel' }],
    ['https://www.instagram.com/someuser/reel/Cx1y2z3AbCd/?igsh=abc', { permalink: 'https://www.instagram.com/reel/Cx1y2z3AbCd/', type: 'reel' }],
    ['https://www.instagram.com/p/Cx1y2z3AbCd/', { permalink: 'https://www.instagram.com/p/Cx1y2z3AbCd/', type: 'post' }],
  ];
  for (const [input, expected] of cases) {
    const parsed = parseInstagramUrl(input);
    assert.ok(parsed, `expected ${input} to parse`);
    assert.equal(parsed.permalink, expected.permalink);
    assert.equal(parsed.type, expected.type);
  }
});

test('parseInstagramUrl rejects non-Instagram and malformed urls', () => {
  for (const bad of [
    'https://example.com/reel/Cx1y2z3AbCd/',
    'https://www.instagram.com/someuser/',
    'https://www.instagram.com/reel/',
    'not a url',
    'https://instagram.com.evil.test/reel/Cx1y2z3AbCd/',
  ]) {
    assert.equal(parseInstagramUrl(bad), undefined, `expected ${bad} to be rejected`);
  }
});

test('every allowed content type maps to a file extension and media type', () => {
  for (const [contentType, spec] of Object.entries(ALLOWED_CONTENT_TYPES)) {
    assert.match(spec.ext, /^\.[a-z0-9]+$/, contentType);
    assert.ok(['reel', 'post', 'carousel'].includes(spec.type));
  }
});

test('pagination cursors round-trip and survive garbage', () => {
  const key = { entity: 'media', created_at: '2026-09-21T10:00:00.000Z', id: 'abc' };
  assert.deepEqual(decodeCursor(encodeCursor(key)), key);
  assert.equal(encodeCursor(undefined), undefined);
  assert.equal(decodeCursor('!!!not-base64!!!'), undefined);
});
