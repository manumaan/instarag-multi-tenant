import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/ddb';
import { buildPlan } from './plan';
import { planToText, sourcesFor } from './sources';
import { writeCachedPlan } from '../shared/plan-cache';

const MESSAGES_TABLE = process.env.MESSAGES_TABLE!;

export interface PlanJob {
  /** From the JWT at the request that started this, not from anything the job saw. */
  userId: string;
  threadId: string;
  /** Sort key of the assistant message this job fills in. */
  createdAt: string;
  request: string;
  mediaId?: string;
  /** Where to keep the finished plan for the next identical request (shared/plan-cache.ts). */
  planKey?: string;
}

/**
 * Builds a plan out of the whole library, away from the request that asked for it.
 *
 * It cannot run inline. Measured on a real library: expansion 1.5s, retrieval
 * 1.3s, and then a synthesis that ran past 57s — because a plan worth having is
 * a few thousand output tokens and those are generated at a fixed rate. API
 * Gateway's HTTP API caps an integration at 30 seconds and that cap cannot be
 * raised, so the request returns a thread immediately and this fills the
 * assistant message in when it is done. The UI polls GET /threads/{id}, which
 * already existed.
 */
export async function handler(job: PlanJob): Promise<void> {
  const { threadId, createdAt, request, mediaId, userId, planKey } = job;
  console.log('plan job started', { threadId, createdAt, mediaId });

  try {
    const plan = await buildPlan(request, { userId, mediaId });
    const cited = plan.sections.flatMap((section) => section.items.flatMap((item) => item.citations));
    const sources = await sourcesFor([...new Set(cited.map((c) => c.media_id))]);
    const status = plan.answered ? ('ready' as const) : ('unsupported' as const);
    const content = planToText(plan.title, plan.overview, plan.sections, plan.gaps);
    const stored = {
      title: plan.title,
      overview: plan.overview,
      sections: plan.sections,
      gaps: plan.gaps,
      queries: plan.queries,
      moments: plan.retrieved.length,
      itemsDropped: plan.itemsDropped,
    };

    await ddb.send(
      new UpdateCommand({
        TableName: MESSAGES_TABLE,
        Key: { thread_id: threadId, created_at: createdAt },
        UpdateExpression:
          'SET #status = :status, #content = :content, citations = :citations, #plan = :plan, sources = :sources REMOVE #error',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#content': 'content',
          '#plan': 'plan',
          '#error': 'error',
        },
        ExpressionAttributeValues: {
          ':status': status,
          ':content': content,
          ':citations': cited,
          ':plan': stored,
          ':sources': sources,
        },
        // Never resurrect a message whose thread was deleted while this ran.
        ConditionExpression: 'attribute_exists(thread_id)',
      }),
    );

    // Kept for the next identical request. A failed build is not cached, so
    // asking again retries it.
    if (planKey) await writeCachedPlan(userId, planKey, { status, content, citations: cited, plan: stored, sources });

    console.log('plan job finished', {
      threadId,
      answered: plan.answered,
      items: cited.length,
      itemsDropped: plan.itemsDropped,
      moments: plan.retrieved.length,
      inputTokens: plan.inputTokens,
      outputTokens: plan.outputTokens,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('plan job failed', { threadId, message });
    // The failure belongs on the message, or the UI polls a placeholder forever.
    await ddb.send(
      new UpdateCommand({
        TableName: MESSAGES_TABLE,
        Key: { thread_id: threadId, created_at: createdAt },
        UpdateExpression: 'SET #status = :failed, #error = :error',
        ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
        ExpressionAttributeValues: { ':failed': 'failed', ':error': message.slice(0, 500) },
        ConditionExpression: 'attribute_exists(thread_id)',
      }),
    );
  }
}
