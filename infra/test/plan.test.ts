import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundPlan, momentKey, planQueries, type Plan } from '../lambda/search/plan';

const retrieved = new Set([momentKey('reel-a', 0), momentKey('reel-a', 3000), momentKey('reel-b', 1500)]);

const plan = (sections: Plan['sections']): Plan => ({
  title: 'Istanbul',
  overview: 'What the clips cover.',
  sections,
  gaps: [],
});

test('planQueries always keeps the request, then the topic, then the facets', () => {
  const queries = planQueries('create me a travel plan for istanbul with all tips', {
    topic: 'Istanbul',
    queries: ['Istanbul transport card', 'Istanbul food'],
  });
  assert.deepEqual(queries, [
    'create me a travel plan for istanbul with all tips',
    'Istanbul',
    'Istanbul transport card',
    'Istanbul food',
  ]);
});

test('planQueries survives an expansion that returned nothing', () => {
  // The expansion is a convenience. Losing it costs breadth, not the answer.
  assert.deepEqual(planQueries('plan a trip to Istanbul'), ['plan a trip to Istanbul']);
  assert.deepEqual(planQueries('plan a trip', { topic: '', queries: [] }), ['plan a trip']);
});

test('planQueries deduplicates and caps the number of searches', () => {
  const queries = planQueries('Istanbul', {
    topic: 'istanbul',
    queries: ['ISTANBUL', 'a', 'b', 'c', 'd', 'e', 'f'],
  });
  // Each query costs an embedding call and two searches, so the list is capped.
  assert.equal(queries.length, 6);
  assert.deepEqual(queries.slice(0, 2), ['Istanbul', 'a']);
});

test('an item the retrieved moments do not support is dropped', () => {
  // The whole point: the model knows Istanbul without any clips, and a plausible
  // uncited itinerary is the failure this app exists to avoid.
  const grounded = groundPlan(
    plan([
      {
        heading: 'Getting around',
        items: [
          { text: 'Buy an Istanbulkart.', citations: [{ media_id: 'reel-a', ts_ms: 0 }] },
          { text: 'The funicular runs until midnight.', citations: [{ media_id: 'reel-z', ts_ms: 9000 }] },
        ],
      },
    ]),
    retrieved,
  );

  assert.equal(grounded.itemsKept, 1);
  assert.equal(grounded.itemsDropped, 1);
  assert.deepEqual(
    grounded.sections[0].items.map((i) => i.text),
    ['Buy an Istanbulkart.'],
  );
});

test('a partly invented citation list keeps only the real moments', () => {
  const grounded = groundPlan(
    plan([
      {
        heading: 'Food',
        items: [
          {
            text: 'Try the spice bazaar.',
            citations: [
              { media_id: 'reel-b', ts_ms: 1500 },
              { media_id: 'reel-b', ts_ms: 4500 },
            ],
          },
        ],
      },
    ]),
    retrieved,
  );
  assert.equal(grounded.itemsKept, 1);
  assert.deepEqual(grounded.sections[0].items[0].citations, [{ media_id: 'reel-b', ts_ms: 1500 }]);
});

test('a section left with nothing standing disappears', () => {
  const grounded = groundPlan(
    plan([
      { heading: 'Nightlife', items: [{ text: 'Invented.', citations: [{ media_id: 'x', ts_ms: 1 }] }] },
      { heading: 'Sights', items: [{ text: 'Real.', citations: [{ media_id: 'reel-a', ts_ms: 3000 }] }] },
    ]),
    retrieved,
  );
  assert.deepEqual(
    grounded.sections.map((s) => s.heading),
    ['Sights'],
  );
});

test('a plan with nothing left standing is not an answer', () => {
  const grounded = groundPlan(
    plan([{ heading: 'All of it', items: [{ text: 'Invented.', citations: [] }] }]),
    retrieved,
  );
  assert.equal(grounded.itemsKept, 0);
  assert.deepEqual(grounded.sections, []);
});
