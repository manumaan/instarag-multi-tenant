import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAuthorizeUrl,
  carouselSlides,
  isIngestable,
  shouldRefresh,
  DEFAULT_SCOPES,
} from '../lambda/connect/instagram';

test('the authorize url carries the app, redirect, state and comma-joined scopes', () => {
  const url = new URL(
    buildAuthorizeUrl({
      appId: '123456',
      redirectUri: 'https://example.cloudfront.net/connect/callback/',
      state: 'nonce-1',
      scopes: ['instagram_business_basic', 'instagram_business_manage_comments'],
    }),
  );
  assert.equal(url.searchParams.get('client_id'), '123456');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.cloudfront.net/connect/callback/');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('state'), 'nonce-1');
  assert.equal(
    url.searchParams.get('scope'),
    'instagram_business_basic,instagram_business_manage_comments',
    'multiple scopes go in one comma-separated parameter',
  );
});

test('the default scope is only what reading own media needs', () => {
  assert.deepEqual(DEFAULT_SCOPES, ['instagram_business_basic']);
  const url = new URL(buildAuthorizeUrl({ appId: 'a', redirectUri: 'https://x/y', state: 's' }));
  assert.equal(url.searchParams.get('scope'), 'instagram_business_basic');
});

test('refresh only inside the window Meta allows', () => {
  const now = new Date('2026-09-22T12:00:00Z');
  const iso = (daysFromNow: number) =>
    new Date(now.getTime() + daysFromNow * 86_400_000).toISOString();

  // Too young: Meta requires the token to be at least 24 hours old.
  assert.equal(shouldRefresh(iso(-0.5), iso(59.5), now), false, 'under 24 hours old');
  // Plenty of life left: refreshing now would waste a call.
  assert.equal(shouldRefresh(iso(-10), iso(50), now), false, 'not near expiry');
  // In the window: old enough, and close enough to expiry to matter.
  assert.equal(shouldRefresh(iso(-52), iso(8), now), true, 'inside the renewal window');
  // Already expired: a refresh cannot rescue it.
  assert.equal(shouldRefresh(iso(-70), iso(-2), now), false, 'already expired');
  // Garbage in, no refresh attempted.
  assert.equal(shouldRefresh('not-a-date', iso(5), now), false);
});

test('only videos with a media_url can be ingested', () => {
  assert.equal(isIngestable({ id: '1', media_type: 'VIDEO', media_url: 'https://cdn/v.mp4' }), true);
  // Copyright-flagged media comes back without a media_url.
  assert.equal(isIngestable({ id: '2', media_type: 'VIDEO' }), false);
  assert.equal(isIngestable({ id: '3', media_type: 'IMAGE', media_url: 'https://cdn/i.jpg' }), false);
  assert.equal(isIngestable({ id: '4', media_type: 'CAROUSEL_ALBUM', media_url: 'https://cdn/c.jpg' }), false);
});

test('a carousel is ingestable through its children, a video through its own url', () => {
  const carousel = {
    id: '1',
    media_type: 'CAROUSEL_ALBUM' as const,
    children: {
      data: [
        { id: 'a', media_type: 'IMAGE' as const, media_url: 'https://cdn/1.jpg' },
        { id: 'b', media_type: 'IMAGE' as const, media_url: 'https://cdn/2.jpg' },
      ],
    },
  };
  assert.equal(isIngestable(carousel), true);
  assert.equal(carouselSlides(carousel).length, 2);

  // Children arrive only if the query asked for them; without them there is
  // nothing to ingest and saying so beats a confusing half-import.
  assert.equal(isIngestable({ id: '2', media_type: 'CAROUSEL_ALBUM' }), false);
  // Copyright-flagged children come back without a url.
  assert.equal(
    carouselSlides({
      id: '3',
      media_type: 'CAROUSEL_ALBUM',
      children: { data: [{ id: 'c', media_type: 'IMAGE' }] },
    }).length,
    0,
  );
  // A video slide is not a still: it would need the extraction pipeline.
  assert.equal(
    carouselSlides({
      id: '4',
      media_type: 'CAROUSEL_ALBUM',
      children: { data: [{ id: 'd', media_type: 'VIDEO', media_url: 'https://cdn/v.mp4' }] },
    }).length,
    0,
  );
});

test('a single image post is still skipped: there is nothing to analyse over time', () => {
  assert.equal(isIngestable({ id: '5', media_type: 'IMAGE', media_url: 'https://cdn/i.jpg' }), false);
});
