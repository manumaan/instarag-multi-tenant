/*
 * Compares answer models on the real Ask and plan code paths, against a real
 * library, and writes a side-by-side HTML report: answer, citations kept,
 * latency, tokens and cost per model.
 *
 *   npx tsx scripts/compare-models.ts            (from infra/)
 *
 * It invokes the deployed Ask Lambda directly, as the owner, with the admin-only
 * `model`/`effort` override — so retrieval, prompts and grounding are exactly
 * what users get and only the model differs. Plans run through the plan worker
 * and are read back off the thread. Every thread it creates is deleted after.
 *
 * Needs AWS credentials for the account, and the OpenRouter key set for any
 * vendor-prefixed model.
 */
import { writeFileSync } from 'node:fs';
import { InvokeCommand, LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const STACK = process.env.STACK ?? 'ReelLensMultiTenant';
/** Whose library to ask: the owner account. */
const USER_SUB = process.env.USER_SUB ?? 'e4683418-6081-7046-ab17-6c0e1d06bf2c';
const OUT = process.env.OUT ?? `${process.env.HOME}/Downloads/model-comparison.html`;

interface Config {
  label: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
  /** USD per million tokens, input / output. */
  price: [number, number];
}

const CONFIGS: Config[] = [
  { label: 'Claude Sonnet 5 · low (current)', model: 'claude-sonnet-5', effort: 'low', price: [2, 10] },
  { label: 'GPT-6 Luna · high', model: 'openai/gpt-6-luna', effort: 'high', price: [0.1, 0.5] },
  { label: 'GPT-6 Luna Pro · high', model: 'openai/gpt-6-luna-pro', effort: 'high', price: [0.1, 0.5] },
];

const QUESTIONS = (process.env.QUESTIONS?.split('|') ?? [
  'What dish does 1932 Cihangir Doyum Mantı serve, and what does it cost?',
  'When is the Grand Bazaar closed?',
  'Which Swiss snacks are worth taking home?',
  'What mistakes do first-time visitors make in Istanbul?',
  'Where is the marble spiral staircase?',
  'How do you add motion to handheld phone video?',
]).map((q) => q.trim());

const PLANS = (process.env.PLANS?.split('|') ?? [
  'Create me a travel plan for Istanbul with all the tips',
  'Create a guide to video making with all the tips from my reels',
]).map((q) => q.trim());

const lambda = new LambdaClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

async function functionNamed(fragment: string): Promise<{ name: string; env: Record<string, string> }> {
  let marker: string | undefined;
  do {
    const page = await lambda.send(new ListFunctionsCommand({ Marker: marker }));
    // Exact stack prefix: the MVP's stack in this account has look-alike names.
    const hit = page.Functions?.find((f) => f.FunctionName?.startsWith(`${STACK}-${fragment}`));
    if (hit) return { name: hit.FunctionName!, env: hit.Environment?.Variables ?? {} };
    marker = page.NextMarker;
  } while (marker);
  throw new Error(`no ${STACK}-${fragment}* function`);
}

async function callAsk(fn: string, body: Record<string, unknown>) {
  const event = {
    routeKey: 'POST /ask',
    body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { sub: USER_SUB, 'cognito:groups': '[admin]' } } } },
  };
  const out = await lambda.send(new InvokeCommand({ FunctionName: fn, Payload: Buffer.from(JSON.stringify(event)) }));
  const response = JSON.parse(Buffer.from(out.Payload!).toString());
  const parsed = JSON.parse(response.body ?? '{}');
  if (response.statusCode >= 400) throw new Error(`${response.statusCode}: ${parsed.error ?? response.body}`);
  return parsed;
}

const cost = (c: Config, input: number, output: number) => (input * c.price[0] + output * c.price[1]) / 1e6;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!);

interface Row {
  config: Config;
  ok: boolean;
  error?: string;
  ms: number;
  input: number;
  output: number;
  usd: number;
  html: string;
  summary: string;
}

async function main() {
  const ask = await functionNamed('ApiAsk');
  // A failed Ask still writes its thread, so cleanup goes by start time and title,
  // not only by the ids that came back. CLEANUP_SINCE sweeps an earlier aborted run.
  const since = process.env.CLEANUP_SINCE ?? new Date().toISOString();
  const threads = new Set<string>();
  try {
    await run(ask, threads);
  } finally {
    await cleanUp(ask.env, threads, since);
  }
}

async function run(ask: { name: string; env: Record<string, string> }, threads: Set<string>) {
  const askRows: Array<{ question: string; rows: Row[] }> = [];
  const planRows: Array<{ request: string; rows: Row[] }> = [];

  // Wake the index first so the first model does not pay the cold start.
  await callAsk(ask.name, { question: 'warm up' }).then((r) => r.threadId && threads.add(r.threadId)).catch(() => undefined);

  for (const question of QUESTIONS) {
    const rows: Row[] = [];
    for (const config of CONFIGS) {
      const t0 = Date.now();
      try {
        const r = await callAsk(ask.name, { question, model: config.model, effort: config.effort });
        if (r.threadId) threads.add(r.threadId);
        const ms = Date.now() - t0;
        const input = r.inputTokens ?? 0;
        const output = r.outputTokens ?? 0;
        rows.push({
          config,
          ok: true,
          ms,
          input,
          output,
          usd: cost(config, input, output),
          summary: `${r.answered ? 'answered' : 'not answered'} · ${r.citations?.length ?? 0} citations kept`,
          html: `<p>${esc(r.answer)}</p>`,
        });
      } catch (err) {
        rows.push({ config, ok: false, error: String(err), ms: Date.now() - t0, input: 0, output: 0, usd: 0, summary: 'error', html: '' });
      }
      console.log(`ask  | ${config.label.padEnd(34)} | ${question.slice(0, 50)} | ${rows.at(-1)!.summary}`);
    }
    askRows.push({ question, rows });
  }

  const messagesTable = ask.env.MESSAGES_TABLE;
  for (const request of PLANS) {
    const rows: Row[] = [];
    for (const config of CONFIGS) {
      const t0 = Date.now();
      try {
        const started = await callAsk(ask.name, { question: request, mode: 'plan', model: config.model, effort: config.effort });
        threads.add(started.threadId);
        let message: Record<string, any> | undefined;
        while (Date.now() - t0 < 6 * 60_000) {
          await new Promise((r) => setTimeout(r, 4000));
          message = (
            await ddb.send(new GetCommand({ TableName: messagesTable, Key: { thread_id: started.threadId, created_at: started.messageAt } }))
          ).Item;
          if (message && message.status !== 'working') break;
        }
        const ms = Date.now() - t0;
        if (!message || message.status === 'working') throw new Error('timed out waiting for the plan');
        if (message.status === 'failed') throw new Error(message.error ?? 'plan failed');
        const plan = message.plan ?? {};
        const items = (plan.sections ?? []).reduce((n: number, s: any) => n + s.items.length, 0);
        const input = Number(plan.inputTokens ?? 0);
        const output = Number(plan.outputTokens ?? 0);
        rows.push({
          config,
          ok: true,
          ms,
          input,
          output,
          usd: cost(config, input, output),
          summary: `${message.status} · ${(plan.sections ?? []).length} sections · ${items} tips · ${plan.itemsDropped ?? 0} dropped · ${(plan.gaps ?? []).length} gaps`,
          html:
            `<h4>${esc(plan.title)}</h4><p class="muted">${esc(plan.overview)}</p>` +
            (plan.sections ?? [])
              .map((s: any) => `<h5>${esc(s.heading)}</h5><ul>${s.items.map((i: any) => `<li>${esc(i.text)} <span class="n">(${i.citations.length})</span></li>`).join('')}</ul>`)
              .join('') +
            ((plan.gaps ?? []).length ? `<h5>Not covered</h5><ul>${plan.gaps.map((g: string) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''),
        });
      } catch (err) {
        rows.push({ config, ok: false, error: String(err), ms: Date.now() - t0, input: 0, output: 0, usd: 0, summary: 'error', html: '' });
      }
      console.log(`plan | ${config.label.padEnd(34)} | ${request.slice(0, 50)} | ${rows.at(-1)!.summary}`);
    }
    planRows.push({ request, rows });
  }

  writeFileSync(OUT, report(askRows, planRows));
  console.log(`\nreport: ${OUT}`);
}

/** The comparison's threads must not linger in the owner's Ask tab. */
async function cleanUp(env: Record<string, string>, threads: Set<string>, since: string) {
  const messagesTable = env.MESSAGES_TABLE;
  const threadsTable = env.THREADS_TABLE;
  const titles = new Set(['warm up', ...QUESTIONS, ...PLANS]);
  const owned = await ddb.send(new QueryCommand({ TableName: threadsTable, KeyConditionExpression: 'user_id = :u', ExpressionAttributeValues: { ':u': USER_SUB } }));
  for (const t of owned.Items ?? []) if (t.created_at >= since && titles.has(t.title)) threads.add(t.id);
  for (const id of threads) {
    const msgs = await ddb.send(new QueryCommand({ TableName: messagesTable, KeyConditionExpression: 'thread_id = :t', ExpressionAttributeValues: { ':t': id } }));
    const keys = (msgs.Items ?? []).map((m) => ({ DeleteRequest: { Key: { thread_id: m.thread_id, created_at: m.created_at } } }));
    for (let i = 0; i < keys.length; i += 25) await ddb.send(new BatchWriteCommand({ RequestItems: { [messagesTable]: keys.slice(i, i + 25) } }));
    await ddb.send(new DeleteCommand({ TableName: threadsTable, Key: { user_id: USER_SUB, id } }));
  }
  console.log(`threads cleaned up: ${threads.size}`);
}

function totals(groups: Array<{ rows: Row[] }>) {
  return CONFIGS.map((config, i) => {
    const rows = groups.map((g) => g.rows[i]).filter((r) => r.ok);
    const n = rows.length || 1;
    return {
      config,
      ok: rows.length,
      of: groups.length,
      usd: rows.reduce((s, r) => s + r.usd, 0) / n,
      ms: rows.reduce((s, r) => s + r.ms, 0) / n,
      input: rows.reduce((s, r) => s + r.input, 0) / n,
      output: rows.reduce((s, r) => s + r.output, 0) / n,
    };
  });
}

function report(askRows: Array<{ question: string; rows: Row[] }>, planRows: Array<{ request: string; rows: Row[] }>) {
  const summaryTable = (title: string, groups: Array<{ rows: Row[] }>, per: string) => `
    <h2>${title}</h2>
    <table><tr><th>Model</th><th>Succeeded</th><th>Avg cost ${per}</th><th>Per 1,000</th><th>Avg time</th><th>Avg tokens in / out</th></tr>
    ${totals(groups)
      .map(
        (t) =>
          `<tr><td>${esc(t.config.label)}</td><td>${t.ok}/${t.of}</td><td>$${t.usd.toFixed(5)}</td><td>$${(t.usd * 1000).toFixed(2)}</td><td>${(t.ms / 1000).toFixed(1)}s</td><td>${Math.round(t.input)} / ${Math.round(t.output)}</td></tr>`,
      )
      .join('')}</table>`;
  const block = (heading: string, rows: Row[]) => `
    <h3>${esc(heading)}</h3>
    <div class="grid">${rows
      .map(
        (r) => `<div class="cell"><div class="head">${esc(r.config.label)}</div>
          <div class="meta">${esc(r.summary)} · ${(r.ms / 1000).toFixed(1)}s · ${r.input}/${r.output} tok · $${r.usd.toFixed(5)}</div>
          ${r.ok ? r.html : `<p class="err">${esc(r.error)}</p>`}</div>`,
      )
      .join('')}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Model comparison</title>
  <style>
    :root{--bg:#f6f6f4;--card:#fff;--text:#1b1b1a;--muted:#6b6b66;--border:#e3e3de;--accent:#3b5bdb;--err:#c92a2a}
    @media (prefers-color-scheme:dark){:root{--bg:#121212;--card:#1d1d1c;--text:#ededea;--muted:#9a9a94;--border:#2f2f2d;--accent:#748ffc;--err:#ff8787}}
    body{margin:0;padding:24px 16px;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
    main{max-width:1200px;margin:0 auto} h1{margin:0 0 4px} .muted{color:var(--muted)}
    table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin:8px 0 24px}
    th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);font-size:14px} th{color:var(--muted);font-weight:600}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px;margin-bottom:24px}
    .cell{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px;overflow-wrap:anywhere}
    .head{font-weight:700;color:var(--accent)} .meta{font-size:12px;color:var(--muted);margin:2px 0 8px}
    .err{color:var(--err)} h4{margin:6px 0} h5{margin:10px 0 4px} ul{padding-left:18px;margin:4px 0} .n{color:var(--muted);font-size:12px}
  </style></head><body><main>
  <h1>Answer model comparison</h1>
  <p class="muted">Same library, same retrieval, same prompts and grounding — only the model differs. ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.
  Cost from list prices per 1M tokens (Sonnet 5 $2/$10, GPT-6 Luna and Luna Pro $0.10/$0.50); reasoning tokens are billed as output.
  Plans also run a Haiku expansion pass, the same for every model, not counted here.</p>
  ${summaryTable('Ask — single answers', askRows, 'per answer')}
  ${summaryTable('Plans', planRows, 'per plan')}
  <h2>Answers</h2>${askRows.map((g) => block(g.question, g.rows)).join('')}
  <h2>Plans</h2>${planRows.map((g) => block(g.request, g.rows)).join('')}
  </main></body></html>`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
