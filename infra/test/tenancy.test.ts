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

test('every admin handler re-checks the group itself', () => {
  const admin = read('lambda/admin/invites.ts');

  // Signup is closed, so these routes are the only way an account comes into
  // existence. A client that hides the screen is a convenience; this is the
  // control, and it has to sit inside each handler rather than at the door.
  const exported = admin.match(/export const (\w+) = handler/g) ?? [];
  assert.ok(exported.length >= 4, 'expected create, list, revoke and usage');
  assert.equal(
    (admin.match(/requireAdmin\(event\)/g) ?? []).length,
    exported.length,
    'every exported admin handler must call requireAdmin',
  );

  // Not-found rather than forbidden: an admin surface should not confirm it
  // exists to someone who may not use it.
  assert.match(admin, /new HttpError\(404, 'not found'\)/);

  // Admin is a claim, never an address in the source.
  assert.ok(!/manu|@gmail|@example/i.test(admin), 'no address may be hardcoded as admin');
  assert.match(read('lambda/shared/http.ts'), /callerGroups\(event\)\.includes\('admin'\)/);
});

test('an accepted invite cannot be withdrawn as if it were pending', () => {
  const admin = read('lambda/admin/invites.ts');
  // Someone who has signed in has a library, threads and a usage history.
  // Deleting them from a screen called "invites" would be a destructive act
  // wearing an administrative label.
  assert.match(admin, /status !== 'FORCE_CHANGE_PASSWORD'/);
  assert.match(admin, /would delete a member rather than withdraw an invite/);
});

test('the admin handlers get named Cognito actions on one pool', () => {
  const api = read('lib/api.ts');
  // A wildcard on cognito-idp would include changing passwords and reading
  // every user's attributes. Each handler gets only what it calls.
  assert.ok(!/'cognito-idp:\*'/.test(api));
  assert.match(api, /actions: \['cognito-idp:AdminCreateUser'\]/);
  assert.match(api, /actions: \['cognito-idp:AdminGetUser', 'cognito-idp:AdminDeleteUser'\]/);
  assert.ok(!/resources: \['\*'\][\s\S]{0,80}cognito/.test(api), 'never a wildcard resource');
});

test('an Instagram token belongs to one account, by its key', () => {
  const store = read('lambda/connect/store.ts');

  // The user is the partition key, not a field on a row keyed by something
  // else. That is what makes a cross-account read impossible rather than
  // merely checked: there is no shared row to read.
  assert.match(store, /Key: \{ user_id: userId, kind: CONNECTION_KIND \}/);
  assert.ok(
    !/CONNECTION_ID|id: 'instagram'/.test(store),
    'no constant id may key the connection row',
  );
  assert.match(
    read('lib/connected.ts'),
    /partitionKey: \{ name: 'user_id'[\s\S]{0,120}sortKey: \{ name: 'kind'/,
    'the table itself must be keyed by user',
  );
});

test('an OAuth state cannot be consumed by anyone but the caller who began it', () => {
  const store = read('lambda/connect/store.ts');
  // Both halves of the lookup sit inside the starting user's partition, so a
  // state handed to another account simply is not there.
  assert.match(store, /putState\(userId: string, state: string\)/);
  assert.match(store, /consumeState\(userId: string, state: string\)/);
  assert.match(store, /const key = \{ user_id: userId, kind: stateKind\(state\) \}/);

  const handlers = read('lambda/connect/handlers.ts');
  assert.match(handlers, /consumeState\(userId, state\)/);
  // Every connect handler resolves a caller, including the three that used to
  // take no event at all because there was only ever one account.
  for (const name of ['start', 'exchange', 'status', 'disconnect', 'sync']) {
    assert.match(
      handlers,
      new RegExp(`export const ${name} = handler\\(async \\(event\\) => \\{\\n  const userId = callerId\\(event\\);`),
      `${name} must take its caller from the token`,
    );
  }
});

test('the scheduled refresh renews every account, and one failure does not stop it', () => {
  const refresh = read('lambda/connect/refresh.ts');
  // It has no caller of its own, so it is the one place that reads across
  // users — and it must reach all of them, or a token lapses unnoticed.
  assert.match(refresh, /allConnections\(\)/);
  assert.ok(!/readConnection/.test(refresh), 'the sweep must not read a single connection');
  assert.match(refresh, /catch \(err\)/, 'a token Meta refuses must not end the sweep');
  assert.match(refresh, /user_id: connection\.user_id/);
});

test('a synced post the library already holds is saved, not downloaded again', () => {
  const handlers = read('lambda/connect/handlers.ts');
  // Content is global: the shortcode is the id for a pasted link and for a
  // sync alike, so ingesting again would mean two rows, two downloads and two
  // of everything downstream.
  assert.match(handlers, /parseInstagramUrl\(item\.permalink\)\?\.shortcode/);
  assert.match(handlers, /if \(held\.Item\)/);
  assert.match(handlers, /if \(!mine\) await saveMedia\(userId, shortcode\)/);
  assert.match(handlers, /const id = shortcode \?\? randomUUID\(\)/);
});

test('sync may write its own saves and usage', () => {
  const connected = read('lib/connected.ts');
  // It creates saves and is charged for what it fetches; without these the
  // sync fails on its first save with AccessDenied, after the download.
  assert.match(connected, /actions: \['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:Query'\][\s\S]{0,80}savesTable/);
  assert.match(connected, /actions: \['dynamodb:UpdateItem'\][\s\S]{0,80}usageTable/);
  // The media table lost its indexes when the shortcode became its key.
  assert.ok(!/mediaTable\.tableArn\}\/index/.test(connected), 'the media table has no indexes');
});

test('a thread belongs to one person, by its key', () => {
  const storage = read('lib/storage.ts');
  // The owner is the partition, so listing threads cannot name anyone else's.
  assert.match(
    storage,
    /ThreadsTable'[\s\S]{0,200}partitionKey: \{ name: 'user_id'[\s\S]{0,120}sortKey: \{ name: 'id'/,
  );
  // The replaced GSI partitioned on a constant, which is both a leak and a hot
  // key. Ordering is a local index now: same partition, sorted by time.
  assert.ok(!/entity.*AttributeType/.test(storage), 'no constant-partition index may remain');
  assert.match(storage, /addLocalSecondaryIndex\(\{[\s\S]{0,120}sortKey: \{ name: 'created_at'/);

  const list = read('lambda/search/list-threads.ts');
  assert.match(list, /const userId = callerId\(event\)/);
  assert.match(list, /KeyConditionExpression: 'user_id = :u'/);
  assert.ok(!/':entity'/.test(list), 'the list must not query a shared partition');
});

test('a thread id from the request is checked before turns are appended to it', () => {
  // The messages table is keyed by thread alone and cannot tell whose hand is
  // on it, so every path into it goes through the owner check first.
  const threads = read('lambda/shared/threads.ts');
  assert.match(threads, /Key: \{ user_id: userId, id: threadId \}/);
  assert.match(threads, /new HttpError\(404, 'thread not found'\)/);

  const ask = read('lambda/search/ask.ts');
  assert.match(ask, /await requireThread\(userId, threadId\)/);
  assert.ok(
    !/body\.threadId \?\? randomUUID\(\)/.test(ask),
    'a supplied thread id must be checked, not adopted',
  );

  const get = read('lambda/search/get-thread.ts');
  assert.match(get, /await requireThread\(userId, threadId\)/);
});

test('a lens screenshot is the caller\'s own, and a frame must be in their library', () => {
  const lens = read('lambda/shared/lens.ts');
  // media/ is shared on purpose; a query screenshot is not content and carries
  // its owner, so a borrowed key is refused before the object is read.
  assert.match(lens, /lensPrefixFor = \(userId: string\) => `\$\{LENS_PREFIX\}\$\{userId\}\/`/);
  assert.match(lens, /if \(!key\.startsWith\(lensPrefixFor\(userId\)\)\) throw badRequest/);

  for (const file of ['lambda/search/lens.ts', 'lambda/search/web-lens.ts']) {
    const src = read(file);
    assert.match(src, /requireOwnLensKey\(userId,/, `${file} must check the key's owner`);
    assert.ok(
      !/startsWith\('lens\/'\)|startsWith\(LENS_PREFIX\)/.test(src),
      `${file} accepts any lens key, including someone else's`,
    );
    assert.match(src, /hasSaved\(userId, body\.mediaId\)/, `${file} must check the frame is the caller's`);
  }
});

test('both Lens model calls are charged to whoever asked', () => {
  const web = read('lambda/search/web-lens.ts');
  // It had no caller at all, so its two calls were spent by nobody.
  assert.match(web, /recordUsage\('lens-extract', MODEL_ID, extraction\.usage, userId\)/);
  assert.match(web, /recordUsage\('lens-summarise', MODEL_ID, answer\.usage, userId\)/);
});
