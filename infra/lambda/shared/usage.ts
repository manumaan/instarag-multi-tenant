/** What a model call cost, as reported by the API. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

import { addUsage } from './ledger';

export const USAGE_NAMESPACE = 'ReelLens';

/**
 * Publishes model spend as a CloudWatch metric.
 *
 * Phase 7's spend guards watched `AWS/Bedrock`, and moving generation to the
 * Anthropic API blinded them: the Bedrock metrics now see embeddings only, and
 * the AWS billing alarm will never see Anthropic charges at all, because those
 * bill to a different account entirely. Without this there is no signal
 * anywhere in AWS that the models are running away.
 *
 * Embedded Metric Format rather than PutMetricData: it is a log line, so it
 * costs no API call and adds no latency to a request someone is waiting on.
 *
 * **Deliberately undimensioned.** Every distinct dimension combination is a
 * separate custom metric at $0.30/month, and four operations x two metrics
 * would have added $2.40 to a stack that costs about $2 a month to sit idle.
 * The operation and model ride along as log properties instead: they cost
 * nothing, they are queryable in Logs Insights when a spike needs explaining,
 * and the alarm only ever needed the total.
 */
export function recordUsage(operation: string, model: string, usage: Usage, userId?: string): void {
  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: USAGE_NAMESPACE,
          Dimensions: [[]],
          Metrics: [
            { Name: 'TokensIn', Unit: 'Count' },
            { Name: 'TokensOut', Unit: 'Count' },
          ],
        },
      ],
    },
    TokensIn: usage.input_tokens,
    TokensOut: usage.output_tokens,
    operation,
    model,
  };
  console.log(JSON.stringify(emf));

  /*
   * The metric is the alarm; the ledger is the per-person record. Both, because
   * they answer different questions: one says "is something looping right now",
   * the other "what has this account cost", and neither substitutes.
   *
   * Not awaited: a token count must never be what delays an answer. A lost
   * write is a slightly low counter, which the metric still catches.
   */
  void addUsage(userId, {
    tokens_in: usage.input_tokens,
    tokens_out: usage.output_tokens,
    ...(operation === 'analyse' ? { analyses: 1 } : {}),
    ...(operation === 'plan' ? { plans: 1 } : {}),
  });
}
