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

test('the broadcaster reaches only the people who hold the content', () => {
  const broadcast = read('lambda/realtime/broadcast.ts');
  const connect = read('lambda/realtime/connect.ts');
  const authorizer = read('lambda/realtime/authorizer.ts');

  // The leak this replaces: it scanned every open socket and pushed every
  // change to all of them, caption and analysis included.
  assert.ok(!broadcast.includes('ScanCommand'), 'the broadcaster must not enumerate all sockets');
  assert.match(broadcast, /saversOf\(String\(media\.id\)\)/, 'recipients come from who saved it');
  assert.match(broadcast, /IndexName: CONNECTIONS_BY_USER/, 'sockets are looked up per user');

  // A socket with no verified identity cannot be filtered later, so it is
  // refused at $connect rather than stored and hoped about.
  assert.match(authorizer, /context: \{ userId:/);
  assert.match(connect, /if \(!userId\) return \{ statusCode: 401/);
  assert.match(connect, /user_id: userId/);
});

test('the broadcaster cannot scan sockets even if its code tried', () => {
  const realtime = read('lib/realtime.ts');
  // Capability, not just code: with Scan removed from the policy, the old
  // behaviour is unrepresentable rather than merely unwritten.
  const policy = realtime.slice(realtime.indexOf('broadcastFn.addToRolePolicy'));
  assert.ok(!/'dynamodb:Scan'/.test(policy.slice(0, 600)), 'Scan must not be granted');
  assert.match(policy, /dynamodb:Query/);
});

test('the two ledger writers agree on the row key', () => {
  // infra/extract is built from its own directory and cannot import shared, so
  // the period format exists twice. A mismatch would split one person's month
  // across two rows and make every total quietly wrong.
  const shared = require('../lambda/shared/ledger') as { usagePeriod: (at?: Date) => string };
  const extract = require('../extract/src/ledger') as { usagePeriod: (at?: Date) => string };
  const at = new Date('2026-09-28T11:22:33Z');
  assert.equal(shared.usagePeriod(at), extract.usagePeriod(at));
  assert.equal(shared.usagePeriod(at), 'usage#2026-09');
});

test('usage is charged to whoever caused the work, not to everyone holding it', () => {
  const ledger = read('lambda/shared/ledger.ts');
  const download = read('extract/src/download.ts');
  const saves = read('lambda/shared/saves.ts');

  // The asymmetry is the point: one download and one vision pass can serve many
  // libraries, and the person who pasted the link wears it. Everyone after them
  // records a save and nothing else, which is deduplication showing up in the
  // accounts rather than only in the infrastructure.
  assert.match(saves, /addUsage\(userId, \{ saves: 1 \}\)/);
  assert.match(download, /addDownloadUsage\(userId, \{ downloads: 1, bytes_downloaded: size \}\)/);
  // A refused attempt still spent a request against the rate limit.
  assert.match(download, /addDownloadUsage\(userId, \{ downloads: 1 \}\)/);

  // Counters only, incremented atomically — never read-modify-write, because
  // two handlers incrementing at once is the normal case.
  assert.match(ledger, /UpdateExpression: `ADD \$\{adds\.join\(', '\)\}`/);
  assert.ok(!ledger.includes('GetCommand'), 'the ledger must not read before writing');
});

test('a pipeline run knows who caused it', () => {
  const pipeline = read('lib/pipeline.ts');
  // Passed to every worker, so the download and the vision pass can charge the
  // right account. Absent, JsonPath fails the execution — which is why each
  // ingest path sets it.
  assert.ok(
    (pipeline.match(/userId: sfn\.JsonPath\.stringAt\('\$\.userId'\)/g) ?? []).length >= 4,
    'every worker step must receive the causing user',
  );
  for (const file of ['lambda/media/create-from-url.ts', 'lambda/media/retry-media.ts']) {
    assert.match(read(file), /input: JSON\.stringify\(\{\s*\n\s*userId,/, `${file} must set it`);
  }
});
