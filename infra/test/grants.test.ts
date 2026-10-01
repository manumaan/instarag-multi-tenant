import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ReelLensStack } from '../lib/reel-lens-stack';

/*
 * Every DynamoDB call a handler can make is granted to that handler's role.
 *
 * Least-privilege grants are written by hand beside each function, and the
 * multi-tenant rebuild changed what several handlers read without changing
 * what they were allowed to read. Nothing noticed until a live request failed
 * AccessDenied — twice in one day: `POST /media/url` (GetItem on media) and
 * `GET /media` (BatchGetItem on media, reached only once a library was
 * non-empty, so an empty library hid it). A handler that fails only on the path
 * nobody has exercised yet is exactly what a unit test is for.
 *
 * So this reads each handler's source, follows its calls into local modules
 * (a handler that calls saveMedia() needs what saveMedia does), resolves each
 * command's table through the function's environment, and checks the
 * synthesized role policy grants that action on that table — and on its index,
 * for a Query with an IndexName.
 *
 * Static, so it over-approximates slightly (a helper module's whole function
 * counts, not just the branch taken). That errs towards a grant that is never
 * used rather than a request that fails in production.
 */

const ROOT = path.join(__dirname, '..');

/** Construct path → [source file, exported handler]. Every Node function must be here. */
const ENTRIES: Record<string, [string, string]> = {
  'Api/CreateUpload': ['lambda/media/create-upload.ts', 'main'],
  'Api/CompleteUpload': ['lambda/media/complete-upload.ts', 'main'],
  'Api/CreateFromUrl': ['lambda/media/create-from-url.ts', 'main'],
  'Api/ListMedia': ['lambda/media/list-media.ts', 'main'],
  'Api/GetMedia': ['lambda/media/get-media.ts', 'main'],
  'Api/DeleteMedia': ['lambda/media/delete-media.ts', 'main'],
  'Api/RetryMedia': ['lambda/media/retry-media.ts', 'main'],
  'Api/PlanWorker': ['lambda/search/plan-worker.ts', 'handler'],
  'Api/Ask': ['lambda/search/ask.ts', 'main'],
  'Api/LensUpload': ['lambda/search/lens.ts', 'upload'],
  'Api/LensSimilar': ['lambda/search/lens.ts', 'similar'],
  'Api/LensWeb': ['lambda/search/web-lens.ts', 'main'],
  'Api/ListThreads': ['lambda/search/list-threads.ts', 'main'],
  'Api/GetThread': ['lambda/search/get-thread.ts', 'main'],
  'Api/PlanPdf': ['lambda/search/plan-pdf.ts', 'main'],
  'Api/AdminInviteCreate': ['lambda/admin/invites.ts', 'create'],
  'Api/AdminInviteList': ['lambda/admin/invites.ts', 'list'],
  'Api/AdminInviteRevoke': ['lambda/admin/invites.ts', 'revoke'],
  'Api/AdminUsage': ['lambda/admin/invites.ts', 'usage'],
  'Connected/Start': ['lambda/connect/handlers.ts', 'start'],
  'Connected/Exchange': ['lambda/connect/handlers.ts', 'exchange'],
  'Connected/Status': ['lambda/connect/handlers.ts', 'status'],
  'Connected/Disconnect': ['lambda/connect/handlers.ts', 'disconnect'],
  'Connected/Sync': ['lambda/connect/handlers.ts', 'sync'],
  'Connected/Refresh': ['lambda/connect/refresh.ts', 'handler'],
  'Realtime/WsAuthorizer': ['lambda/realtime/authorizer.ts', 'main'],
  'Realtime/WsConnect': ['lambda/realtime/connect.ts', 'main'],
  'Realtime/WsDisconnect': ['lambda/realtime/disconnect.ts', 'main'],
  'Realtime/WsBroadcast': ['lambda/realtime/broadcast.ts', 'main'],
  'Pipeline/AnalyseReel': ['lambda/analyse/index.ts', 'handler'],
  'Pipeline/StoreTranscriptFn': ['lambda/transcript/store.ts', 'handler'],
  'Pipeline/IndexFrames': ['lambda/search/index-frames.ts', 'handler'],
  'Auth/InviteMessage': ['lambda/auth/invite-message.ts', 'main'],
};

/**
 * Calls the analysis can reach but the handler provably never makes, each with
 * the reason. Kept short and explicit so granting an unused permission is never
 * the easier way to make this test pass.
 */
const NOT_REACHED: Record<string, string> = {
  // purgeDerived only resets frames with { keepFrames: true }, which only
  // retry-media passes; delete-media calls purgeDerived(id) and removes them.
  'Api/DeleteMedia dynamodb:UpdateItem FRAMES_TABLE': 'keepFrames is retry-only',
};

const COMMAND_ACTION: Record<string, string> = {
  Get: 'GetItem',
  Put: 'PutItem',
  Update: 'UpdateItem',
  Delete: 'DeleteItem',
  Query: 'Query',
  Scan: 'Scan',
  BatchGet: 'BatchGetItem',
  BatchWrite: 'BatchWriteItem',
  TransactWrite: 'TransactWriteItems',
  TransactGet: 'TransactGetItems',
};
const COMMAND = /new (Get|Put|Update|Delete|Query|Scan|BatchGet|BatchWrite|TransactWrite|TransactGet)(?:Items?)?Command\(/g;

interface Need {
  action: string;
  /** The environment variable naming the table, when the source makes it resolvable. */
  env?: string;
  index: boolean;
  where: string;
}

interface Module {
  file: string;
  imports: Map<string, { file: string; name: string }>;
  tableConsts: Map<string, string>;
  functions: Map<string, string>;
}

const modules = new Map<string, Module>();

/** TABLES.<key> → env var, from lambda/shared/ddb.ts. */
const TABLES_ENV = (() => {
  const src = readFileSync(path.join(ROOT, 'lambda/shared/ddb.ts'), 'utf8');
  const block = /export const TABLES = \{([\s\S]*?)\};/.exec(src)?.[1] ?? '';
  return new Map([...block.matchAll(/(\w+): process\.env\.(\w+)/g)].map((m) => [m[1], m[2]]));
})();

function resolveImport(fromFile: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(fromFile), spec);
  return [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find(existsSync);
}

function load(file: string): Module {
  const cached = modules.get(file);
  if (cached) return cached;
  const src = readFileSync(file, 'utf8');

  const imports = new Map<string, { file: string; name: string }>();
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*'(\.[^']+)'/g)) {
    const target = resolveImport(file, m[2]);
    if (!target) continue;
    for (const part of m[1].split(',')) {
      const [name, alias] = part.replace(/\btype\s+/, '').trim().split(/\s+as\s+/);
      if (name) imports.set((alias ?? name).trim(), { file: target, name: name.trim() });
    }
  }

  const tableConsts = new Map<string, string>();
  for (const m of src.matchAll(/const (\w+)\s*=\s*process\.env\.(\w+)/g)) tableConsts.set(m[1], m[2]);

  // Top-level declarations, each running to the next one. Coarse, but handler
  // modules are flat: functions and consts at column zero.
  const functions = new Map<string, string>();
  const decl = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=)/gm;
  const starts = [...src.matchAll(decl)];
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : src.length;
    functions.set(m[1] ?? m[2], src.slice(m.index, end));
  });

  const mod = { file, imports, tableConsts, functions };
  modules.set(file, mod);
  return mod;
}

function tableEnv(mod: Module, ref: string): string | undefined {
  if (ref.startsWith('TABLES.')) return TABLES_ENV.get(ref.slice('TABLES.'.length));
  const local = mod.tableConsts.get(ref);
  if (local) return local;
  // A table constant imported from another module.
  const imported = mod.imports.get(ref);
  return imported ? load(imported.file).tableConsts.get(imported.name) : undefined;
}

/** Every DynamoDB call reachable from one function, following local and imported calls. */
function needsOf(file: string, name: string, seen = new Set<string>()): Need[] {
  const key = `${file}#${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const mod = load(file);
  const body = mod.functions.get(name);
  if (!body) return [];

  const needs: Need[] = [];
  const matches = [...body.matchAll(COMMAND)];
  matches.forEach((m, i) => {
    const window = body.slice(m.index, Math.min(i + 1 < matches.length ? matches[i + 1].index : body.length, m.index + 600));
    const ref = /TableName:\s*([\w.]+)/.exec(window)?.[1] ?? /\[([\w.]+)\]:\s*\{/.exec(window)?.[1];
    needs.push({
      action: `dynamodb:${COMMAND_ACTION[m[1]]}`,
      env: ref ? tableEnv(mod, ref) : undefined,
      index: /IndexName:/.test(window),
      where: `${path.relative(ROOT, file)} ${name}()`,
    });
  });

  // Follow what the body calls or passes along — `saveMedia(`, `.then(load)` —
  // not every word: a comment mentioning "sync" is not a call to sync().
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const referenced = new Set(
    [...code.matchAll(/\b([A-Za-z_]\w*)\s*\(|[(,]\s*([A-Za-z_]\w*)\s*[,)]/g)].map((m) => m[1] ?? m[2]),
  );
  for (const ident of referenced) {
    if (ident === name) continue;
    if (mod.functions.has(ident)) needs.push(...needsOf(file, ident, seen));
    const imported = mod.imports.get(ident);
    if (imported) needs.push(...needsOf(imported.file, imported.name, seen));
  }
  return needs;
}

test('every DynamoDB call a handler can make is granted to its role', () => {
  // The CLI writes construct paths into the template; a bare App does not.
  const app = new App({ context: { 'aws:cdk:enable-path-metadata': true } });
  const stack = new ReelLensStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    webOrigins: ['http://localhost:3000'],
    retainData: true,
    analysisModel: 'claude-opus-5',
    answerModel: 'claude-sonnet-5',
    expansionModel: 'claude-haiku-4-5',
    claudeSecretName: 'test-claude-key',
    maxFrames: 20,
    embeddingModel: 'amazon.titan-embed-image-v1',
    maxOcu: 2,
    instagramAppId: '1234567890',
    monthlyBudget: 20,
    hourlyTokenBudget: 500_000,
  });
  const template = Template.fromStack(stack);
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));

  const failures: string[] = [];
  const checked = new Set<string>();

  for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
    const cdkPath = String(fn.Metadata?.['aws:cdk:path'] ?? '');
    // Container images (extract, download, thumbnail) are built from infra/extract, not lambda/.
    if (fn.Properties.PackageType === 'Image' || cdkPath.includes('/Custom')) continue;
    const id = cdkPath.replace(/^TestStack\//, '').replace(/\/Resource$/, '');
    if (id.startsWith('Custom') || id.includes('BucketDeployment') || id.includes('AutoDeleteObjects')) continue;

    const entry = ENTRIES[id];
    if (!entry) {
      failures.push(`${id}: not in ENTRIES — add its source file so its grants are checked`);
      continue;
    }
    checked.add(id);

    const roleId = fn.Properties.Role?.['Fn::GetAtt']?.[0];
    const statements = policies
      .filter((p) => JSON.stringify(p.Properties.Roles ?? []).includes(`"${roleId}"`))
      .flatMap((p) => p.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>)
      .map((s) => ({
        actions: ([] as string[]).concat(s.Action),
        resources: ([] as unknown[]).concat(s.Resource).map((r) => JSON.stringify(r)),
      }));
    const env = (fn.Properties.Environment?.Variables ?? {}) as Record<string, unknown>;

    const seen = new Set<string>();
    for (const need of needsOf(path.join(ROOT, entry[0]), entry[1])) {
      const tableRef = need.env ? env[need.env] : undefined;
      const tableId = (tableRef as { Ref?: string } | undefined)?.Ref;
      const key = `${need.action} ${need.env ?? '?'} ${need.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (NOT_REACHED[`${id} ${need.action} ${need.env}`]) continue;

      if (need.env && !tableRef) {
        failures.push(`${id}: ${need.where} reads ${need.env}, which the function's environment does not set`);
        continue;
      }
      const granted = statements.some(
        (s) =>
          s.actions.includes(need.action) &&
          s.resources.some((r) => {
            if (!tableId) return r.includes('dynamodb') || r.includes('Table');
            if (!r.includes(`"${tableId}"`)) return false;
            // A Query on an index is authorised against the index ARN, not the table's.
            return need.index ? r.includes('/index/') : !r.includes('/index/');
          }),
      );
      if (!granted) {
        failures.push(
          `${id}: ${need.where} needs ${need.action} on ${need.env ?? 'a table'}${need.index ? ' (index)' : ''}, which its role does not grant`,
        );
      }
    }
  }

  // Guard against the test quietly checking nothing if construct paths change.
  assert.ok(checked.size >= 25, `only ${checked.size} handlers were checked`);
  assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
});
