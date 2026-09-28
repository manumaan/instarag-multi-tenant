import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchUrl, parseResults, searchWeb, SearchNotConfigured } from '../lambda/search/brave';

test('the search url carries the query and respects Brave\'s count cap', () => {
  const url = new URL(buildSearchUrl('Pierre Herme macaron Paris', 8));
  assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(url.searchParams.get('q'), 'Pierre Herme macaron Paris');
  assert.equal(url.searchParams.get('count'), '8');
  assert.equal(url.searchParams.get('safesearch'), 'moderate');

  // Brave caps count at 20, and 0 is not a request.
  assert.equal(new URL(buildSearchUrl('x', 500)).searchParams.get('count'), '20');
  assert.equal(new URL(buildSearchUrl('x', 0)).searchParams.get('count'), '1');
});

test('the query is encoded rather than injected into the url', () => {
  const url = new URL(buildSearchUrl('cafe & bar "Le Ruisseau" #paris', 5));
  assert.equal(url.searchParams.get('q'), 'cafe & bar "Le Ruisseau" #paris');
  assert.equal(url.searchParams.get('safesearch'), 'moderate', 'params must not be clobbered');
});

test('results parse from Brave\'s shape and drop unusable entries', () => {
  const parsed = parseResults({
    web: {
      results: [
        { title: 'Pierre Hermé Paris', url: 'https://www.pierreherme.com/', description: 'Macarons.' },
        { title: 'No url here', description: 'unusable' },
        { url: 'https://example.com/no-title', description: 'unusable' },
        { title: 'Le Ruisseau', url: 'https://example.com/le-ruisseau' },
      ],
    },
  });
  assert.deepEqual(parsed.map((r) => r.title), ['Pierre Hermé Paris', 'Le Ruisseau']);
  assert.equal(parsed[1].description, '', 'a missing description is empty, not undefined');
});

test('an empty or unexpected payload yields no results rather than throwing', () => {
  assert.deepEqual(parseResults({}), []);
  assert.deepEqual(parseResults({ web: {} }), []);
  assert.deepEqual(parseResults(null), []);
  assert.deepEqual(parseResults('nonsense'), []);
});

test('a missing key is reported as not configured, not as a failed search', async () => {
  await assert.rejects(() => searchWeb('anything', ''), SearchNotConfigured);
});
