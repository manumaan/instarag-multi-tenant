import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRequest, planObjectKey } from '../lambda/shared/plan-cache';

test('the same request in different case, spacing or punctuation is the same request', () => {
  const a = normalizeRequest('Create me a travel plan for Istanbul with all the tips');
  assert.equal(normalizeRequest('create me a travel plan  for istanbul with all the tips.'), a);
  assert.equal(normalizeRequest('  CREATE ME A TRAVEL PLAN FOR ISTANBUL WITH ALL THE TIPS!? '), a);
  // A different request is a different request.
  assert.notEqual(normalizeRequest('create me a travel plan for Tokyo with all the tips'), a);
});

test('a cached plan lives under its owner, never only behind a hash', () => {
  // Plans are built from a private library: the user in the path is what keeps
  // one person's cached plan out of another's reach.
  assert.equal(planObjectKey('user-1', 'abc', 'json'), 'plans/user-1/abc.json');
  assert.equal(planObjectKey('user-1', 'abc', 'pdf'), 'plans/user-1/abc.pdf');
});
