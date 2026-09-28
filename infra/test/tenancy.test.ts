import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const read = (file: string) => readFileSync(path.join(__dirname, '..', file), 'utf8');

/*
 * These read source rather than run it, because what they assert is structural:
 * that no path to the index exists which skips the caller's scope. A behavioural
 * test would need OpenSearch and would only cover the paths it happened to call;
 * the leak this design guards against is a path nobody thought to call.
 */

test('every search of the index is scoped to the caller', () => {
  const retrieve = read('lambda/search/retrieve.ts');
  const lens = read('lambda/search/lens.ts');

  // Both entry points take a caller and refuse to search without one.
  assert.match(retrieve, /export async function retrieve\([\s\S]{0,200}userId: string/);
  assert.match(retrieve, /export async function retrieveMany\([\s\S]{0,200}userId: string/);

  // Lens queries the index directly instead of going through retrieve(), so it
  // has to apply the same filter itself. It did not, at first.
  assert.match(lens, /scopeFilter\(userId\)/, 'Lens must apply the scope filter');
  assert.match(lens, /hasSaved\(userId, body\.mediaId\)/, 'Lens must check the frame is the caller\'s');

  // Nothing may search the index outside these two files.
  for (const file of ['lambda/search/ask.ts', 'lambda/search/plan.ts', 'lambda/search/web-lens.ts']) {
    assert.ok(!read(file).includes('.search({'), `${file} queries the index without a scope`);
  }
});

test('no caller identity is ever taken from the request body or path', () => {
  // A user id from anywhere but the token would let a caller name someone else
  // and read their library. callerId() is the only source, and it reads a claim.
  const http = read('lambda/shared/http.ts');
  assert.match(http, /claims\?\.\s*sub/);

  for (const file of ['lambda/search/ask.ts', 'lambda/search/lens.ts']) {
    const src = read(file);
    assert.match(src, /callerId\(event\)/, `${file} must take the caller from the token`);
    assert.ok(
      !/body\.userId|body\.user_id|pathParam\(event, 'userId'\)/.test(src),
      `${file} takes a user id from the request`,
    );
  }
});

test('an empty library matches nothing rather than everything', () => {
  // The dangerous shape is a filter that degrades to "no filter" when a caller
  // has saved nothing, which would open the whole index to a new account.
  const retrieve = read('lambda/search/retrieve.ts');
  assert.match(retrieve, /if \(saved\.length === 0\) return undefined;/);
  assert.match(retrieve, /if \(!filter\) return \[\];/);
});

test('the plan worker is given its caller rather than inferring one', () => {
  // It runs asynchronously with no token of its own, so the id has to arrive in
  // the payload — put there by the request that had a token.
  const worker = read('lambda/search/plan-worker.ts');
  const ask = read('lambda/search/ask.ts');
  assert.match(worker, /userId: string/);
  assert.match(worker, /buildPlan\(request, \{ userId, mediaId \}\)/);
  assert.match(ask, /JSON\.stringify\(\{ threadId, createdAt: assistantAt, request, mediaId: body\.mediaId, userId \}\)/);
});
