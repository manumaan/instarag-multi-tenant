export const METRICS_NAMESPACE = 'ReelLens';

/**
 * Download outcomes, as CloudWatch metrics.
 *
 * The question these answer is whether Instagram's anonymous rate limit is a
 * real constraint or a theoretical one. Today it is theoretical: twenty-odd
 * pasted links over six days, all of them fine, and no rate-limit error in ten
 * days of logs. That changes with more people pasting from the same egress
 * range, and this turns "it will probably break at some point" into a number
 * that says when.
 *
 * Embedded Metric Format, matching `lambda/shared/usage.ts`: a log line, so no
 * API call and no latency on a download someone is waiting for. The two files
 * cannot share code — infra/extract is built from its own directory — so the
 * namespace is repeated here rather than imported.
 *
 * Two metrics, not three: a count and a rate-limited count give the failure
 * *rate*, which is the thing worth alarming on. Bytes and the permalink ride
 * along as log properties, where they cost nothing and are still queryable —
 * per-user totals belong in a ledger, not in a metric.
 */
export function recordDownload(outcome: 'ok' | 'rate_limited' | 'failed', detail: {
  mediaId: string;
  bytes?: number;
  kind?: string;
}): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: METRICS_NAMESPACE,
            Dimensions: [[]],
            Metrics: [
              { Name: 'Downloads', Unit: 'Count' },
              { Name: 'DownloadsRateLimited', Unit: 'Count' },
              { Name: 'DownloadBytes', Unit: 'Bytes' },
            ],
          },
        ],
      },
      Downloads: 1,
      DownloadsRateLimited: outcome === 'rate_limited' ? 1 : 0,
      DownloadBytes: detail.bytes ?? 0,
      outcome,
      mediaId: detail.mediaId,
      kind: detail.kind,
    }),
  );
}
