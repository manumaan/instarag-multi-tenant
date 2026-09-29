import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Storage } from './storage';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Auth } from './auth';
import { Api } from './api';
import { Pipeline } from './pipeline';
import { Realtime } from './realtime';
import { Search } from './search';
import { Hosting } from './hosting';
import { Connected } from './connected';
import { Observability } from './observability';

export interface ReelLensStackProps extends StackProps {
  readonly webOrigins: string[];
  readonly retainData: boolean;
  readonly retentionDays?: number;
  readonly analysisModel: string;
  /** Model for Ask, plans and Lens. Cheaper and faster than the vision model. */
  readonly answerModel: string;
  /** Cheap model for the query-expansion pass in front of a plan. */
  readonly expansionModel: string;
  readonly maxFrames: number;
  readonly embeddingModel: string;
  readonly maxOcu: number;
  /** Instagram app id for connected mode. Empty until MJ creates the Meta app. */
  readonly instagramAppId: string;
  /** Where alarms are emailed. Left unset, the topic exists with no subscriber. */
  readonly alarmEmail?: string;
  /** Monthly spend, in USD, that should raise an alarm. */
  readonly monthlyBudget: number;
  /** Bedrock input tokens per hour that would mean something is looping. */
  readonly hourlyTokenBudget: number;
  /** Secrets Manager name for the Anthropic API key. Set by hand, so it is a name. */
  readonly claudeSecretName: string;
}

/**
 * Media store, tables, sign-in, the drop-in mode API, the reel download and
 * keyframe extraction pipeline, and the WebSocket progress channel.
 * Claude analysis (Phase 3) and the vector index (Phase 4) land later.
 */
export class ReelLensStack extends Stack {
  constructor(scope: Construct, id: string, props: ReelLensStackProps) {
    super(scope, id, props);

    // Hosting comes first: Cognito's callback URLs and the API's CORS list
    // both need the CloudFront domain, and nothing flows the other way, so
    // there is no cycle.
    const hosting = new Hosting(this, 'Hosting');
    /*
     * The distribution's own origin is appended here rather than passed in:
     * it does not exist until this stack does, so `-c webOrigins=` is for the
     * *other* origins (localhost, a custom domain).
     *
     * Deduplicated because passing the CloudFront URL anyway is the obvious
     * thing to try, and S3 rejects a CORS rule with a repeated origin —
     * "array items are not unique", at changeset validation, after the assets
     * have been built and published.
     */
    const webOrigins = [...new Set([...props.webOrigins, hosting.origin])];

    const storage = new Storage(this, 'Storage', {
      webOrigins,
      retainData: props.retainData,
      retentionDays: props.retentionDays,
    });

    /*
     * The Claude API key, not Bedrock: this account is still not entitled to
     * Sonnet 5 or Opus 5 there — a 1-token invoke of either answers
     * AccessDeniedException — while both are available on the direct API.
     * Embeddings stay on Bedrock, since Titan is a Bedrock model.
     *
     * Named rather than generated, because it is set by hand:
     *   aws secretsmanager put-secret-value --secret-id <claudeSecretName> --secret-string <key>
     *
     * A *fixed* name would collide with the single-user MVP's secret in this
     * account, so it is configuration. Its own key rather than the MVP's, so
     * the two deployments' spend is attributable separately on Anthropic's side.
     */
    const claudeKey = new secretsmanager.Secret(this, 'ClaudeApiKey', {
      secretName: props.claudeSecretName,
      description: 'Anthropic API key for the vision, Ask, plan and Lens passes.',
    });

    const auth = new Auth(this, 'Auth', { webOrigins });

    const search = new Search(this, 'Search', { maxOcu: props.maxOcu });

    // Meta redirects the browser to our own page, which then posts the code to
    // the API behind the app's own auth.
    const connected = new Connected(this, 'Connected', {
      storage,
      retainData: props.retainData,
      appId: props.instagramAppId,
      redirectUri: `${hosting.origin}/connect/callback/`,
    });

    const api = new Api(this, 'Api', {
      storage,
      auth,
      webOrigins,
      search,
      connected,
      analysisModel: props.analysisModel,
      answerModel: props.answerModel,
      expansionModel: props.expansionModel,
      embeddingModel: props.embeddingModel,
      claudeKey,
    });

    const pipeline = new Pipeline(this, 'Pipeline', {
      storage,
      search,
      analysisModel: props.analysisModel,
      maxFrames: props.maxFrames,
      embeddingModel: props.embeddingModel,
      claudeKey,
    });
    const realtime = new Realtime(this, 'Realtime', { storage, auth });

    // The pipeline's own handlers: these run asynchronously, so a throw here is
    // invisible unless something is watching for it.
    const observability = new Observability(this, 'Observability', {
      stateMachine: pipeline.stateMachine,
      pipelineFunctions: [
        pipeline.downloadFunction,
        pipeline.extractFunction,
        pipeline.analyseFunction,
        pipeline.storeTranscriptFunction,
        pipeline.indexFunction,
      ],
      alarmEmail: props.alarmEmail,
      monthlyBudget: props.monthlyBudget,
      hourlyTokenBudget: props.hourlyTokenBudget,
    });

    // Every ingest route kicks off the pipeline: a completed upload and an API
    // sync go straight to extraction, a pasted permalink is downloaded first.
    for (const fn of [
      api.completeUploadFunction,
      api.createFromUrlFunction,
      api.retryMediaFunction,
      connected.syncFunction,
    ]) {
      pipeline.stateMachine.grantStartExecution(fn);
      fn.addEnvironment('STATE_MACHINE_ARN', pipeline.stateMachine.stateMachineArn);
    }

    // Connected sync ingests the account's own posts for whoever connected it,
    // so it both reads their saves (to skip what they already hold) and writes
    // new ones.
    storage.savesTable.grantReadWriteData(connected.syncFunction);
    storage.usageTable.grantWriteData(connected.syncFunction);

    // An uploaded carousel is the one ingest path with no ffmpeg behind it, so
    // it asks the thumbnailer directly rather than getting one on the way past.
    pipeline.thumbnailFunction.grantInvoke(api.completeUploadFunction);
    api.completeUploadFunction.addEnvironment(
      'THUMBNAIL_FUNCTION_ARN',
      pipeline.thumbnailFunction.functionArn,
    );

    new CfnOutput(this, 'ApiUrl', { value: api.httpApi.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: auth.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'HostedUiDomain', { value: `${auth.domain.domainName}.auth.${this.region}.amazoncognito.com` });
    new CfnOutput(this, 'MediaBucketName', { value: storage.mediaBucket.bucketName });
    new CfnOutput(this, 'MediaTableName', { value: storage.mediaTable.tableName });
    new CfnOutput(this, 'WsUrl', { value: realtime.url });
    new CfnOutput(this, 'StateMachineArn', { value: pipeline.stateMachine.stateMachineArn });
    new CfnOutput(this, 'AnalysisModel', { value: props.analysisModel });
    new CfnOutput(this, 'WebSearchSecretArn', { value: api.webSearchSecret.secretArn });
    new CfnOutput(this, 'SiteBucketName', { value: hosting.bucket.bucketName });
    new CfnOutput(this, 'AlarmTopicArn', { value: observability.topic.topicArn });
  }
}
