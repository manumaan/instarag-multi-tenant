import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';

export interface ObservabilityProps {
  readonly stateMachine: sfn.StateMachine;
  /** The pipeline's own handlers. These fail where nobody is watching. */
  readonly pipelineFunctions: lambda.IFunction[];
  /** Where alarms go. Empty means the topic is created but nothing subscribes. */
  readonly alarmEmail?: string;
  /** Monthly spend that should raise an alarm, in USD. */
  readonly monthlyBudget: number;
  /** Bedrock input tokens in an hour that would mean something is looping. */
  readonly hourlyTokenBudget: number;
}

/**
 * Alarms, because until now there were none.
 *
 * The pipeline is asynchronous: a reel that fails does so out of sight, and a
 * pipeline broken for *everything* is just as quiet. That happened in this
 * project — an unguarded Choice on `$.kind` failed every reel while the
 * carousel path it was added for kept working, and the only thing that noticed
 * was a smoke test run by hand.
 *
 * Every metric here was checked against `cloudwatch list-metrics` on the live
 * account rather than taken from docs, because an alarm on a misspelled metric
 * name sits in INSUFFICIENT_DATA forever and reads as silence.
 */
export class Observability extends Construct {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);

    this.topic = new sns.Topic(this, 'Alarms', { displayName: 'Reel Lens alarms' });
    if (props.alarmEmail) {
      this.topic.addSubscription(new subscriptions.EmailSubscription(props.alarmEmail));
    }

    const notify = (alarm: cloudwatch.Alarm) => {
      alarm.addAlarmAction(new actions.SnsAction(this.topic));
      return alarm;
    };

    // A failed execution is a reel the user cannot use. One is enough to know.
    notify(
      new cloudwatch.Alarm(this, 'PipelineFailures', {
        alarmDescription: 'A reel failed somewhere in the ingest pipeline.',
        metric: props.stateMachine.metricFailed({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    // Distinct from a failure: a timeout usually means a stage is wedged rather
    // than broken, and the two have different fixes.
    notify(
      new cloudwatch.Alarm(this, 'PipelineTimeouts', {
        alarmDescription: 'An ingest execution hit its timeout instead of finishing.',
        metric: props.stateMachine.metricTimedOut({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    /*
     * Summed across the pipeline's handlers rather than one alarm each: which
     * one threw matters when reading the logs, not when deciding to look. Metric
     * math takes at most 10 inputs, which the pipeline stays well inside.
     */
    const errorMetrics = Object.fromEntries(
      props.pipelineFunctions.map((fn, index) => [
        `e${index}`,
        fn.metricErrors({ period: Duration.minutes(5) }),
      ]),
    );
    notify(
      new cloudwatch.Alarm(this, 'PipelineLambdaErrors', {
        alarmDescription: 'A pipeline handler threw. The reel may still be mid-retry.',
        metric: new cloudwatch.MathExpression({
          expression: Object.keys(errorMetrics).join(' + '),
          usingMetrics: errorMetrics,
          label: 'Pipeline handler errors',
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    // Embeddings only, since generation left Bedrock: a burst here means Titan
    // is refusing, which stops anything new becoming searchable.
    notify(
      new cloudwatch.Alarm(this, 'BedrockClientErrors', {
        alarmDescription: 'Bedrock is rejecting embedding calls: throttling or a bad model id.',
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Bedrock',
          metricName: 'InvocationClientErrors',
          statistic: 'Sum',
          period: Duration.minutes(15),
        }),
        threshold: 3,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    /*
     * The spend guard, and the only one that sees the models at all.
     *
     * It used to watch AWS/Bedrock InputTokenCount. Moving generation to the
     * Anthropic API blinded that: Bedrock now serves embeddings only, and the
     * AWS billing alarm below will never see Anthropic charges, because they
     * bill to a different account. So the handlers publish their own token
     * counts (lambda/shared/usage.ts, Embedded Metric Format) and this watches
     * those. A reel is around 10k input tokens, so the default catches a loop
     * re-analysing the library rather than ordinary use.
     */
    notify(
      new cloudwatch.Alarm(this, 'ModelTokenBurn', {
        alarmDescription: 'Unusual model input-token volume: something may be looping.',
        metric: new cloudwatch.Metric({
          namespace: 'ReelLens',
          metricName: 'TokensIn',
          statistic: 'Sum',
          period: Duration.hours(1),
        }),
        threshold: props.hourlyTokenBudget,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    /*
     * The vector index outcost the model on the busiest measured day — $1.83 of
     * OCU against $1.28 of Bedrock — and the whole reason for choosing a NEXTGEN
     * collection group was that it scales to zero when idle. This alarm is that
     * assumption, checked: OCU held above zero for three straight hours means it
     * stopped scaling down, which is the expensive failure.
     *
     * A Metrics Insights query rather than a dimensioned metric, deliberately.
     * OCU is reported per CollectionGroupId, and this account already has three
     * of them from redeploys — an alarm pinned to one would quietly stop
     * matching the day the group is recreated.
     *
     * Three hours, in half-hour steps, because that is the ceiling: CloudWatch
     * refuses a Metrics Insights alarm whose window exceeds it outright —
     * "MetricsInsights monitors cannot be checked across more than 3 hours".
     * Still far longer than the ten idle minutes after which the collection is
     * supposed to have scaled down.
     */
    notify(
      new cloudwatch.Alarm(this, 'SearchOcuNotScalingDown', {
        alarmDescription: 'OpenSearch Serverless has not scaled to zero while idle.',
        metric: new cloudwatch.MathExpression({
          expression: 'SELECT MAX(SearchOCU) FROM "AWS/AOSS"',
          label: 'Search OCU',
          period: Duration.minutes(30),
        }),
        threshold: 0,
        evaluationPeriods: 6,
        datapointsToAlarm: 6,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    /*
     * Instagram's anonymous rate limit, which is the constraint most likely to
     * decide whether pasted links survive more than one user. It has never
     * fired: twenty-odd links over six days, none refused. This says when that
     * stops being true, rather than leaving it to be noticed.
     *
     * One in an hour is worth knowing — it means the ceiling has been reached
     * at this volume, which is the signal, not the incident.
     */
    notify(
      new cloudwatch.Alarm(this, 'InstagramRateLimited', {
        alarmDescription: 'Instagram refused an anonymous download. It clears, but the ceiling was hit.',
        metric: new cloudwatch.Metric({
          namespace: 'ReelLens',
          metricName: 'DownloadsRateLimited',
          statistic: 'Sum',
          period: Duration.hours(1),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );

    /*
     * Kept despite reading 0 today: it is the only alarm that covers every
     * service at once, and it starts telling the truth the moment the account's
     * credits run out. Six-hour period because that is how often billing
     * publishes.
     */
    notify(
      new cloudwatch.Alarm(this, 'MonthlySpend', {
        alarmDescription: `Estimated charges passed $${props.monthlyBudget} this month.`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Billing',
          metricName: 'EstimatedCharges',
          dimensionsMap: { Currency: 'USD' },
          statistic: 'Maximum',
          period: Duration.hours(6),
        }),
        threshold: props.monthlyBudget,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
  }
}
