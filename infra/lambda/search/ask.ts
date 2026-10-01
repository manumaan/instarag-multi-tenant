import { randomUUID } from 'node:crypto';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { claude } from '../shared/claude';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { ddb } from '../shared/ddb';
import { badRequest, callerId, handler, parseJsonBody } from '../shared/http';
import { retrieve, warmIndex, type Hit } from './retrieve';
import { requireThread } from '../shared/threads';
import { sourcesFor } from './sources';
import { recordUsage } from '../shared/usage';
import { planCacheKey, readCachedPlan } from '../shared/plan-cache';

const THREADS_TABLE = process.env.THREADS_TABLE!;
const MESSAGES_TABLE = process.env.MESSAGES_TABLE!;
const PLAN_WORKER_ARN = process.env.PLAN_WORKER_ARN!;

const lambda = new LambdaClient({});
const MODEL_ID = process.env.ANSWER_MODEL_ID!;


const CitationSchema = z.object({
  media_id: z.string(),
  ts_ms: z.number(),
});

const AnswerSchema = z.object({
  answered: z
    .boolean()
    .describe('false when the provided frames do not contain enough to answer'),
  answer: z.string().describe('the answer, or a plain statement of what is missing when answered is false'),
  citations: z
    .array(CitationSchema)
    .describe('the frames the answer rests on; empty only when answered is false'),
});

interface AskBody {
  question?: string;
  mediaId?: string;
  threadId?: string;
  /**
   * 'answer' pins one fact and cites it. 'plan' builds something out of the
   * whole library — "a travel plan for Istanbul with all the tips" — which
   * needs far more of the index and a different shape of reply.
   */
  mode?: 'answer' | 'plan';
}

/** POST /ask — RAG over the frame index, answering only from retrieved frames. */
export const main = handler(async (event) => {
  // Same function on purpose: this warms the container that will serve the
  // question as well as the index it will search.
  if (event.routeKey?.endsWith('/ask/warm')) return warmIndex();

  const body = parseJsonBody<AskBody>(event);
  const question = body.question?.trim();
  if (!question) throw badRequest('question is required');
  if (question.length > 1000) throw badRequest('question is too long');

  const userId = callerId(event);
  if (body.mode === 'plan') return planAnswer(question, body, userId);

  const hits = await retrieve(question, { userId, mediaId: body.mediaId });

  if (hits.length === 0) {
    return {
      threadId: body.threadId ?? null,
      answered: false,
      answer:
        body.mediaId
          ? 'Nothing has been indexed for this reel yet, so there is nothing to answer from.'
          : 'Your library has nothing indexed yet, so there is nothing to answer from.',
      citations: [],
    };
  }

  const response = await (await claude()).messages.parse({
    model: MODEL_ID,
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: zodOutputFormat(AnswerSchema) },
    system: [
      'You answer questions about Instagram reels using only the moments provided.',
      'Each moment carries its media_id and ts_ms. A frame moment says what is visible and any',
      'text read off it verbatim; a speech moment is what was said aloud at that point.',
      '',
      'Rules:',
      '- Answer only from the frames given. Never use outside knowledge about a place or brand.',
      '- Cite the frames your answer rests on, by media_id and ts_ms.',
      '- A name is only established if it appears in a frame\'s text or was spoken. If you are',
      '  reasoning from appearance rather than text or speech, say so in the answer.',
      '- If the frames do not support an answer, set answered to false and say what is missing.',
      '  That is a correct outcome, not a failure.',
    ].join('\n'),
    messages: [{ role: 'user', content: `${formatContext(hits)}\n\nQuestion: ${question}` }],
  });

  recordUsage('ask', MODEL_ID, response.usage, userId);

  const parsed = response.parsed_output;
  if (!parsed) throw new Error(`model returned no parsable answer (stop_reason ${response.stop_reason})`);

  // A citation must point at a moment we actually retrieved, or it is not a
  // citation. Keyed on media_id + ts_ms only: hitKey also carries the kind,
  // which a citation does not name, and matching on it silently dropped every
  // citation the model produced.
  const retrieved = new Set(hits.map((hit) => `${hit.mediaId}:${hit.tsMs}`));
  const citations = parsed.citations.filter((c) => retrieved.has(`${c.media_id}:${c.ts_ms}`));

  const threadId = await continueOrStart(userId, body.threadId);
  await persist(userId, threadId, body.mediaId, question, parsed.answer, citations);

  return {
    threadId,
    mode: 'answer' as const,
    answered: parsed.answered && citations.length > 0,
    answer: parsed.answer,
    citations,
    sources: await sourcesFor([...new Set(citations.map((c) => c.media_id))]),
    retrieved: hits.map((hit) => ({ media_id: hit.mediaId, ts_ms: hit.tsMs })),
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
});

/**
 * A new thread, or a continuation of one the caller owns.
 *
 * A thread id is minted here and handed to the browser, which posts it back on
 * the next turn — so an id arriving in a request is the one thing about a
 * thread that a caller chooses. Without the check, posting somebody else's id
 * would append turns to their conversation: the messages table is keyed by
 * thread alone and cannot tell whose hand is on it.
 */
async function continueOrStart(userId: string, threadId: string | undefined): Promise<string> {
  if (!threadId) return randomUUID();
  await requireThread(userId, threadId);
  return threadId;
}

function formatContext(hits: Hit[]): string {
  return hits
    .map((hit) =>
      [
        `--- ${hit.kind} media_id=${hit.mediaId} ts_ms=${hit.tsMs}`,
        hit.speech && `said aloud: ${hit.speech}`,
        hit.description && `visible: ${hit.description}`,
        hit.ocrText && `text in frame (verbatim): ${hit.ocrText}`,
        hit.places && `places named in this reel: ${hit.places}`,
        hit.caption && `reel caption: ${hit.caption}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}

async function persist(
  userId: string,
  threadId: string,
  mediaId: string | undefined,
  question: string,
  answer: string,
  citations: Array<{ media_id: string; ts_ms: number }>,
) {
  const now = new Date().toISOString();
  await startThread(userId, threadId, mediaId, question, now);
  await ddb.send(
    new PutCommand({
      TableName: MESSAGES_TABLE,
      Item: { thread_id: threadId, created_at: now, role: 'user', content: question },
    }),
  );
  await ddb.send(
    new PutCommand({
      TableName: MESSAGES_TABLE,
      // Microsecond suffix keeps the answer after its question in sort order.
      Item: {
        thread_id: threadId,
        created_at: `${now}#a`,
        role: 'assistant',
        content: answer,
        citations,
      },
    }),
  );
}

/** Creates the thread row the first time a thread is written to. */
async function startThread(
  userId: string,
  threadId: string,
  mediaId: string | undefined,
  question: string,
  now: string,
) {
  const existing = await ddb.send(
    new QueryCommand({
      TableName: MESSAGES_TABLE,
      KeyConditionExpression: 'thread_id = :t',
      ExpressionAttributeValues: { ':t': threadId },
      Limit: 1,
    }),
  );
  if ((existing.Count ?? 0) > 0) return;
  await ddb.send(
    new PutCommand({
      TableName: THREADS_TABLE,
      Item: {
        user_id: userId,
        id: threadId,
        scope: mediaId ? 'media' : 'library',
        media_id: mediaId,
        title: question.slice(0, 120),
        created_at: now,
      },
    }),
  );
}

/**
 * The whole-library path: "create a travel plan for Istanbul with all the tips".
 *
 * It answers with a thread rather than a plan, because building one takes a
 * minute or so and an HTTP API integration is cut off at thirty seconds. The
 * assistant message is written as `working` and a worker fills it in; the UI
 * polls GET /threads/{id} until its status changes.
 */
async function planAnswer(request: string, body: AskBody, userId: string) {
  const threadId = await continueOrStart(userId, body.threadId);
  const now = new Date().toISOString();
  // Microsecond suffix keeps the answer after its question in sort order.
  const assistantAt = `${now}#a`;

  /*
   * The same person asking the same thing of the same library gets the plan
   * already built for it: no minute-long build, no model spend. It lands on
   * the thread already finished, so the clients' polling needs no change.
   * See shared/plan-cache.ts for what the key covers and why.
   */
  const planKey = await planCacheKey(userId, request, body.mediaId);
  const cached = await readCachedPlan(userId, planKey);
  if (cached) {
    await startTurn(userId, threadId, body.mediaId, request, now, assistantAt, { ...cached, plan_key: planKey, cached: true });
    return { threadId, mode: 'plan' as const, status: cached.status, messageAt: assistantAt, cached: true };
  }

  await startTurn(userId, threadId, body.mediaId, request, now, assistantAt, { plan_key: planKey });

  await lambda.send(
    new InvokeCommand({
      FunctionName: PLAN_WORKER_ARN,
      // Fire and forget: the answer arrives on the message, not on this response.
      InvocationType: 'Event',
      /*
       * The worker has no token of its own, so the caller rides in the payload.
       * That is safe because this value came from the JWT one line above and
       * the invoke is server-to-server — but it means the worker must treat it
       * as given, never as something to re-derive from the request.
       */
      Payload: Buffer.from(
        JSON.stringify({ threadId, createdAt: assistantAt, request, mediaId: body.mediaId, userId, planKey }),
      ),
    }),
  );

  return { threadId, mode: 'plan' as const, status: 'working' as const, messageAt: assistantAt };
}

/** Writes the question and a placeholder for the answer still being built. */
async function startTurn(
  userId: string,
  threadId: string,
  mediaId: string | undefined,
  question: string,
  now: string,
  assistantAt: string,
  /** A cached plan to write as already answered, or just the cache key for the worker's result. */
  answer: Record<string, unknown>,
) {
  await startThread(userId, threadId, mediaId, question, now);
  await ddb.send(
    new PutCommand({
      TableName: MESSAGES_TABLE,
      Item: { thread_id: threadId, created_at: now, role: 'user', content: question, mode: 'plan' },
    }),
  );
  await ddb.send(
    new PutCommand({
      TableName: MESSAGES_TABLE,
      Item: {
        thread_id: threadId,
        created_at: assistantAt,
        role: 'assistant',
        mode: 'plan',
        status: 'working',
        content: '',
        citations: [],
        // A cached plan overrides the placeholder fields above.
        ...answer,
      },
    }),
  );
}
