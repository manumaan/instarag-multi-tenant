import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  classifyPost,
  explainDownloadFailure,
  normalizeCaption,
  takenAtFrom,
  toMediaFields,
  type YtDlpInfo,
} from '../extract/src/metadata';
import { SLIDE_INTERVAL_MS as EXTRACT_SLIDE_INTERVAL_MS } from '../extract/src/download';
import { SLIDE_INTERVAL_MS } from '../lambda/shared/media';

/**
 * A real `yt-dlp --dump-single-json --ignore-no-formats-error` response for a
 * public carousel, trimmed to three slides. Captured rather than invented: the
 * shape that matters here — entries with no formats and a thumbnail each — is
 * Instagram's, and an invented fixture would only assert what we assumed.
 */
const carouselInfo = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'carousel-info.json'), 'utf8'),
) as YtDlpInfo;

const ZWSP = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);
const LINE_SEP = String.fromCharCode(0x2028);

test('normalizeCaption strips invisible characters but keeps hashtags', () => {
  const caption = `Sunset at the${ZWSP} pier${BOM}   \r\n\r\n\r\nBest light${LINE_SEP} all week   \n#sunset #pier`;
  const normalized = normalizeCaption(caption);
  assert.equal(normalized, 'Sunset at the pier\n\nBest light all week\n#sunset #pier');
  const invisible = new RegExp(`[${ZWSP}${BOM}${LINE_SEP}]`);
  assert.ok(!invisible.test(normalized), 'invisible characters survived');
  assert.match(normalized, /#sunset #pier/);
});

test('normalizeCaption leaves an ordinary caption alone', () => {
  assert.equal(normalizeCaption('One line only'), 'One line only');
  assert.equal(normalizeCaption('  padded  '), 'padded');
});

test('takenAtFrom prefers the timestamp and falls back to upload_date', () => {
  assert.equal(takenAtFrom({ timestamp: 1789000000 }), new Date(1789000000000).toISOString());
  assert.equal(takenAtFrom({ upload_date: '20260921' }), '2026-09-21T00:00:00.000Z');
  assert.equal(takenAtFrom({ upload_date: 'not-a-date' }), undefined);
  assert.equal(takenAtFrom({}), undefined);
});

test('toMediaFields maps a reel payload onto the data model', () => {
  const fields = toMediaFields({
    id: 'Cx1y2z3AbCd',
    description: `Look at this${ZWSP} view\n\n\n#travel`,
    timestamp: 1789000000,
    duration: 8.04,
    uploader: 'someaccount',
    ext: 'mp4',
  });
  assert.equal(fields.caption_raw, `Look at this${ZWSP} view\n\n\n#travel`);
  assert.equal(fields.caption_normalized, 'Look at this view\n\n#travel');
  assert.equal(fields.duration_ms, 8040);
  assert.equal(fields.uploader, 'someaccount');
  assert.equal(fields.taken_at, new Date(1789000000000).toISOString());
});

test('toMediaFields leaves a captionless reel without a caption', () => {
  const fields = toMediaFields({ description: '   ', uploader_id: '12345' });
  assert.equal(fields.caption_raw, undefined);
  assert.equal(fields.caption_normalized, undefined);
  assert.equal(fields.uploader, '12345');
});

test('explainDownloadFailure names a login wall as such', () => {
  const walled = explainDownloadFailure(
    'yt-dlp exited 1: ERROR: [Instagram] Cx1y: Requested content is not available, rate-limit reached or login required',
  );
  assert.equal(walled.loginWalled, true);
  assert.match(walled.message, /would not serve this reel without a logged-in session/);

  const missing = explainDownloadFailure('yt-dlp exited 1: ERROR: [Instagram] Cx1y: Post not found');
  assert.equal(missing.loginWalled, false);
  assert.equal(missing.message, 'ERROR: [Instagram] Cx1y: Post not found');

  const noise = explainDownloadFailure('something odd happened');
  assert.equal(noise.loginWalled, false);
  assert.equal(noise.message, 'something odd happened');
});

test('an empty media response is treated as a wall, not a retryable fault', () => {
  const observed = explainDownloadFailure(
    'yt-dlp exited 1: ERROR: [Instagram] Zz9: Instagram sent an empty media response. ' +
      'Check if this post is accessible in your browser without being logged-in.',
  );
  assert.equal(observed.loginWalled, true, 'must not be retried');
  assert.match(observed.message, /would not serve this reel without a logged-in session/);
});

test('a post with no video is not reported as a login wall', () => {
  // This mattered: "no video formats found" was classified as a wall, so an
  // image post or carousel told the reader to go and find cookies for a
  // problem that has nothing to do with authentication.
  const noVideo = explainDownloadFailure(
    'yt-dlp exited 1: ERROR: [Instagram] Dx1y: No video formats found!; please report this issue',
  );
  assert.equal(noVideo.noVideo, true);
  assert.equal(noVideo.loginWalled, false, 'must not be mistaken for a login wall');
  assert.match(noVideo.message, /image post or a carousel/);
  assert.match(noVideo.message, /Upload its images instead/);

  // A real wall is still a wall.
  const walled = explainDownloadFailure('yt-dlp exited 1: ERROR: [Instagram] Dx1y: login required');
  assert.equal(walled.loginWalled, true);
  assert.equal(walled.noVideo, false);
});

test('classifyPost reads a real carousel response as slides', () => {
  const shape = classifyPost(carouselInfo);
  assert.equal(shape.kind, 'slides');
  if (shape.kind !== 'slides') return;

  assert.equal(shape.slides.length, 3);
  assert.deepEqual(shape.slides.map((s) => s.position), [1, 2, 3]);
  assert.equal(shape.videoSlidesSkipped, 0);
  for (const slide of shape.slides) {
    assert.match(slide.url, /^https:\/\//);
    // The uncropped, unresized variant: a square crop would cut text off a slide.
    assert.match(slide.url, /stp=dst-jpg_e35_tt6/);
  }
  // The caption comes from the post, so no OCR pass is needed for it.
  assert.ok(toMediaFields(carouselInfo).caption_raw);
});

test('classifyPost still recognises a reel', () => {
  const shape = classifyPost({ id: 'abc', formats: [{ ext: 'mp4' }], thumbnail: 'https://cdn/x.jpg' });
  assert.equal(shape.kind, 'video');
});

test('classifyPost treats a single image post as one slide', () => {
  const shape = classifyPost({ id: 'abc', thumbnail: 'https://cdn/only.jpg' });
  assert.equal(shape.kind, 'slides');
  if (shape.kind !== 'slides') return;
  assert.deepEqual(shape.slides, [{ position: 1, shortcode: 'abc', url: 'https://cdn/only.jpg' }]);
});

test('a video card in a mixed carousel is skipped without renumbering the rest', () => {
  const shape = classifyPost({
    entries: [
      { id: 'a', thumbnail: 'https://cdn/1.jpg' },
      { id: 'b', formats: [{ ext: 'mp4' }], thumbnail: 'https://cdn/2.jpg' },
      { id: 'c', thumbnail: 'https://cdn/3.jpg' },
    ],
  });
  assert.equal(shape.kind, 'slides');
  if (shape.kind !== 'slides') return;
  assert.equal(shape.videoSlidesSkipped, 1);
  // Slide 3 must still be the third card of the post, or every citation after
  // the skipped one points at the wrong picture.
  assert.deepEqual(shape.slides.map((s) => s.position), [1, 3]);
});

test('classifyPost reports a post with neither video nor images as empty', () => {
  assert.equal(classifyPost({ id: 'abc' }).kind, 'empty');
  assert.equal(classifyPost({ entries: [null, null] }).kind, 'empty');
});

test('the slide interval agrees across the two bundles', () => {
  // download.ts cannot import the shared constant: infra/extract is built on its
  // own. If these drift, every slide citation silently points at another slide.
  assert.equal(EXTRACT_SLIDE_INTERVAL_MS, SLIDE_INTERVAL_MS);
});

test('the rate limit is not a login wall, and says so', () => {
  // Instagram's own wording, which matched nothing in LOGIN_WALL, so it fell
  // through to a generic failure that the pipeline then retried — sending more
  // of exactly what had tripped it.
  const real = 'ERROR: [Instagram] ABC: You have exceeded the rate-limit for accessing posts anonymously';
  const explained = explainDownloadFailure(real);

  assert.equal(explained.rateLimited, true);
  assert.equal(explained.loginWalled, false, 'a rate limit clears; a login wall does not');
  assert.equal(explained.noVideo, false);
  assert.match(explained.message, /clears on its own/);
});

test('a login wall is still a login wall', () => {
  const walled = explainDownloadFailure('ERROR: Requested content is not available, login required');
  assert.equal(walled.loginWalled, true);
  assert.equal(walled.rateLimited, false);

  // yt-dlp's catch-all names both causes and knows neither. It keeps the wall
  // handling that was worked out against a real failure, rather than being
  // claimed by the narrower match.
  const ambiguous = explainDownloadFailure(
    'ERROR: [Instagram] X: Requested content is not available, rate-limit reached or login required',
  );
  assert.equal(ambiguous.loginWalled, true);
  assert.equal(ambiguous.rateLimited, false);
});

test('an image post is neither', () => {
  const post = explainDownloadFailure('ERROR: [Instagram] X: No video formats found!');
  assert.equal(post.noVideo, true);
  assert.equal(post.rateLimited, false);
  assert.equal(post.loginWalled, false);
});
