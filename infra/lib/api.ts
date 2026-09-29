import { Construct } from 'constructs';
import { Duration } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'node:path';
import type { Auth } from './auth';
import { Storage } from './storage';
import type { Search } from './search';
import type { Connected } from './connected';

export interface ApiProps {
  readonly storage: Storage;
  readonly auth: Auth;
  readonly webOrigins: string[];
  readonly search: Search;
  /** Connected mode's handlers, mounted on this API. */
  readonly connected: Connected;
  /** Model that answers questions; same one that analyses frames. */
  readonly analysisModel: string;
  /** Cheap model for the query-expansion pass in front of a plan. */
  readonly expansionModel: string;
  /** Model for Ask, plans and Lens. */
  readonly answerModel: string;
  readonly claudeKey: secretsmanager.Secret;
  readonly embeddingModel: string;
}

const LAMBDA_DIR = path.join(__dirname, '..', 'lambda', 'media');
const SEARCH_LAMBDA_DIR = path.join(__dirname, '..', 'lambda', 'search');

/**
 * HTTP API for drop-in mode (Phase 1).
 *
 * Every route sits behind the Cognito user pool JWT authorizer, and each
 * handler gets its own role with only the actions that route needs.
 */
export class Api extends Construct {
  readonly httpApi: apigw.HttpApi;
  /** Holds the Brave Search API key. Created empty; MJ sets the value. */
  readonly webSearchSecret: secretsmanager.Secret;
  /** Exposed so the stack can point them at the ingest pipeline. */
  readonly completeUploadFunction: NodejsFunction;
  readonly createFromUrlFunction: NodejsFunction;
  readonly retryMediaFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { storage, auth } = props;

    const authorizer = new HttpUserPoolAuthorizer('UserPoolAuthorizer', auth.userPool, {
      userPoolClients: [auth.userPoolClient],
    });

    this.httpApi = new apigw.HttpApi(this, 'HttpApi', {
      description: 'Reel Lens API',
      corsPreflight: {
        allowOrigins: props.webOrigins,
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.DELETE,
          apigw.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
      defaultAuthorizer: authorizer,
    });

    // Cheap insurance against a runaway client: the single user needs nothing near this.
    const stage = this.httpApi.defaultStage!.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 20, throttlingBurstLimit: 40 };

    const commonEnv = {
      MEDIA_BUCKET: storage.mediaBucket.bucketName,
      MEDIA_TABLE: storage.mediaTable.tableName,
      FRAMES_TABLE: storage.framesTable.tableName,
      SAVES_TABLE: storage.savesTable.tableName,
      USAGE_TABLE: storage.usageTable.tableName,
      INVITES_TABLE: storage.invitesTable.tableName,
      JOBS_TABLE: storage.jobsTable.tableName,
      TRANSCRIPT_SEGMENTS_TABLE: storage.transcriptSegmentsTable.tableName,
    };

    const makeFn = (name: string, file: string, overrides: { timeout?: Duration } = {}) =>
      new NodejsFunction(this, name, {
        entry: path.join(LAMBDA_DIR, file),
        handler: 'main',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: overrides.timeout ?? Duration.seconds(15),
        environment: commonEnv,
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.TWO_WEEKS }),
        bundling: {
          minify: true,
          sourceMap: true,
          // CJS, not ESM: the bundled AWS SDK is CommonJS, and esbuild's ESM
          // output turns its internal require('node:https') into a shim that
          // throws "Dynamic require ... is not supported" at cold start.
          format: OutputFormat.CJS,
          target: 'node22',
          // Bundle the SDK rather than trusting whatever version the runtime ships,
          // and because s3-request-presigner is not part of the runtime's SDK.
          externalModules: [],
        },
      });

    const mediaObjects = storage.mediaBucket.arnForObjects('media/*');
    const allow = (fn: NodejsFunction, actions: string[], resources: string[]) =>
      fn.addToRolePolicy(new iam.PolicyStatement({ actions, resources }));

    const createUpload = makeFn('CreateUpload', 'create-upload.ts');
    allow(createUpload, ['dynamodb:UpdateItem'], [storage.usageTable.tableArn]);
    // saves: writes a save when the record is created.
    allow(createUpload, ['dynamodb:PutItem'], [storage.savesTable.tableArn]);
    allow(createUpload, ['s3:PutObject'], [mediaObjects]);
    allow(createUpload, ['dynamodb:PutItem'], [storage.mediaTable.tableArn]);

    const completeUpload = makeFn('CompleteUpload', 'complete-upload.ts');
    allow(completeUpload, ['dynamodb:UpdateItem'], [storage.usageTable.tableArn]);
    // "did this caller start this upload" — the save written when it was created.
    allow(completeUpload, ['dynamodb:GetItem'], [storage.savesTable.tableArn]);
    allow(completeUpload, ['s3:GetObject'], [mediaObjects]); // HeadObject is authorised as GetObject
    allow(completeUpload, ['dynamodb:GetItem', 'dynamodb:UpdateItem'], [storage.mediaTable.tableArn]);
    // A carousel's completion registers its uploaded slides as frames.
    allow(completeUpload, ['dynamodb:BatchWriteItem'], [storage.framesTable.tableArn]);
    allow(completeUpload, ['s3:ListBucket'], [storage.mediaBucket.bucketArn]);

    this.completeUploadFunction = completeUpload;

    const createFromUrl = makeFn('CreateFromUrl', 'create-from-url.ts');
    allow(createFromUrl, ['dynamodb:UpdateItem'], [storage.usageTable.tableArn]);
    // saves: writes a save, and reuses content anyone already ingested.
    allow(createFromUrl, ['dynamodb:PutItem'], [storage.savesTable.tableArn]);
    // Re-pasting a reel we already hold must not spend Instagram's anonymous
    // rate-limit budget on a second download. The shortcode is the key, so the
    // dedupe is a GetItem — this used to grant Query, left over from when it
    // was a lookup by permalink, and every paste failed AccessDenied.
    allow(createFromUrl, ['dynamodb:GetItem', 'dynamodb:PutItem'], [storage.mediaTable.tableArn]);
    this.createFromUrlFunction = createFromUrl;

    const listMedia = makeFn('ListMedia', 'list-media.ts');
    // saves: the library *is* this query.
    allow(listMedia, ['dynamodb:Query'], [storage.savesTable.tableArn, `${storage.savesTable.tableArn}/index/*`]);
    // Presigning the grid's thumbnails needs read access to the frames.
    allow(listMedia, ['s3:GetObject'], [storage.mediaBucket.arnForObjects('media/*')]);
    allow(
      listMedia,
      ['dynamodb:Query'],
      [storage.savesTable.tableArn, `${storage.savesTable.tableArn}/index/${Storage.SAVES_BY_SAVED_AT}`],
    );

    const getMedia = makeFn('GetMedia', 'get-media.ts');
    // saves: holding it is the authorisation.
    allow(getMedia, ['dynamodb:GetItem'], [storage.savesTable.tableArn]);
    allow(getMedia, ['dynamodb:GetItem'], [storage.mediaTable.tableArn]);
    allow(getMedia, ['dynamodb:Query'], [
      storage.framesTable.tableArn,
      storage.transcriptSegmentsTable.tableArn,
    ]);
    allow(getMedia, ['s3:GetObject'], [mediaObjects]);

    // Longer than the rest: it also clears the vector index, and the first
    // call after the collection has scaled to zero waits for it to warm up.
    const deleteMedia = makeFn('DeleteMedia', 'delete-media.ts', { timeout: Duration.seconds(60) });
    allow(deleteMedia, ['dynamodb:UpdateItem'], [storage.usageTable.tableArn]);
    // saves: unsave, then ask who is left.
    allow(deleteMedia, ['dynamodb:GetItem', 'dynamodb:DeleteItem', 'dynamodb:Query'], [storage.savesTable.tableArn, `${storage.savesTable.tableArn}/index/*`]);
    allow(deleteMedia, ['dynamodb:GetItem', 'dynamodb:DeleteItem'], [storage.mediaTable.tableArn]);
    allow(deleteMedia, ['dynamodb:Query', 'dynamodb:BatchWriteItem'], [storage.framesTable.tableArn]);
    allow(deleteMedia, ['s3:DeleteObject'], [mediaObjects]);
    allow(deleteMedia, ['dynamodb:DeleteItem'], [storage.captionFactsTable.tableArn]);
    allow(deleteMedia, ['dynamodb:Query', 'dynamodb:BatchWriteItem'], [
      storage.transcriptSegmentsTable.tableArn,
    ]);
    // Deleting a reel has to remove it from the index too, or Ask keeps citing it.
    deleteMedia.addEnvironment('SEARCH_ENDPOINT', props.search.endpoint);
    deleteMedia.addEnvironment('SEARCH_INDEX', 'frames');
    deleteMedia.addEnvironment('CAPTION_FACTS_TABLE', storage.captionFactsTable.tableName);
    props.search.grantWrite(deleteMedia);
    deleteMedia.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [storage.mediaBucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': ['media/*'] } },
      }),
    );

    // Ask: retrieval over the frame index, then a grounded answer.
    const askEnv = {
      ...commonEnv,
      THREADS_TABLE: storage.threadsTable.tableName,
      MESSAGES_TABLE: storage.messagesTable.tableName,
      SAVES_TABLE: storage.savesTable.tableName,
      USAGE_TABLE: storage.usageTable.tableName,
      SEARCH_ENDPOINT: props.search.endpoint,
      SEARCH_INDEX: 'frames',
      ANSWER_MODEL_ID: props.answerModel,
      CLAUDE_KEY_SECRET_ARN: props.claudeKey.secretArn,
    };
    /*
     * Bedrock is embeddings only now. Every text and vision call goes to the
     * Anthropic API with a key from Secrets Manager, so the only model left
     * here is Titan Multimodal, which has no Anthropic equivalent.
     */
    const bedrockModelArns = (p: { embeddingModel: string }) => [
      `arn:aws:bedrock:*::foundation-model/${p.embeddingModel}`,
    ];

    const makeSearchFn = (name: string, file: string, exportName = 'main') =>
      new NodejsFunction(this, name, {
        entry: path.join(SEARCH_LAMBDA_DIR, file),
        handler: exportName,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: Duration.seconds(60),
        environment: askEnv,
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.TWO_WEEKS }),
        bundling: { minify: true, sourceMap: true, format: OutputFormat.CJS, target: 'node22', externalModules: [] },
      });

    /*
     * Building a plan out of the whole library takes about a minute — measured:
     * expansion 1.5s, retrieval 1.3s, then a synthesis of several thousand
     * output tokens. An HTTP API integration is cut off at 30 seconds and that
     * ceiling cannot be raised, so the work happens here, off the request, and
     * the answer lands on the thread's assistant message.
     */
    const planWorker = makeSearchFn('PlanWorker', 'plan-worker.ts', 'handler');
    allow(planWorker, ['dynamodb:UpdateItem'], [storage.usageTable.tableArn]);
    planWorker.addEnvironment('EXPANSION_MODEL_ID', props.expansionModel);
    props.claudeKey.grantRead(planWorker);
    allow(planWorker, ['dynamodb:Query'], [storage.savesTable.tableArn]);
    (planWorker.node.defaultChild as lambda.CfnFunction).timeout = 300;
    allow(planWorker, ['dynamodb:UpdateItem'], [storage.messagesTable.tableArn]);
    allow(planWorker, ['dynamodb:BatchGetItem'], [storage.mediaTable.tableArn]);
    allow(planWorker, ['bedrock:InvokeModel'], bedrockModelArns(props));
    props.search.grantRead(planWorker);

    const ask = makeSearchFn('Ask', 'ask.ts');
    allow(ask, ['dynamodb:UpdateItem'], [storage.usageTable.tableArn]);
    ask.addEnvironment('EXPANSION_MODEL_ID', props.expansionModel);
    props.claudeKey.grantRead(ask);
    // The boundary: Ask can only match what this table says the caller holds.
    allow(ask, ['dynamodb:Query'], [storage.savesTable.tableArn]);
    ask.addEnvironment('PLAN_WORKER_ARN', planWorker.functionArn);
    planWorker.grantInvoke(ask);
    // GetItem as well: a continued thread is checked against its owner before
    // a turn is appended to it.
    allow(ask, ['dynamodb:PutItem', 'dynamodb:GetItem'], [storage.threadsTable.tableArn]);
    allow(ask, ['dynamodb:PutItem', 'dynamodb:Query'], [storage.messagesTable.tableArn]);
    // A plan cites a dozen clips; the ids have to become names the reader knows.
    allow(ask, ['dynamodb:BatchGetItem'], [storage.mediaTable.tableArn]);
    allow(ask, ['bedrock:InvokeModel'], bedrockModelArns(props));
    props.search.grantRead(ask);

    // Lens: find similar. Its own presigned-upload route, because a query
    // screenshot is transient and must not become a media record.
    const lensUpload = makeSearchFn('LensUpload', 'lens.ts', 'upload');
    allow(lensUpload, ['s3:PutObject'], [storage.mediaBucket.arnForObjects('lens/*')]);

    /**
     * The key is never in code, env vars or the template: CDK creates the
     * secret with a generated placeholder and the real value is put in out of
     * band, so nothing here can leak it.
     */
    this.webSearchSecret = new secretsmanager.Secret(this, 'WebSearchApiKey', {
      description: 'Brave Search API key for Lens web search. Set with: aws secretsmanager put-secret-value',
    });

    const lensSimilar = makeSearchFn('LensSimilar', 'lens.ts', 'similar');
    // Query for the scope filter, GetItem for "may this caller search from this frame".
    allow(lensSimilar, ['dynamodb:Query', 'dynamodb:GetItem'], [storage.savesTable.tableArn]);
    allow(lensSimilar, ['s3:GetObject'], [
      storage.mediaBucket.arnForObjects('lens/*'),
      storage.mediaBucket.arnForObjects('media/*'),
    ]);
    allow(lensSimilar, ['dynamodb:BatchGetItem'], [storage.framesTable.tableArn]);
    allow(lensSimilar, ['bedrock:InvokeModel'], [
      `arn:aws:bedrock:*::foundation-model/${props.embeddingModel}`,
    ]);
    props.search.grantRead(lensSimilar);

    const lensWeb = makeSearchFn('LensWeb', 'web-lens.ts');
    allow(lensWeb, ['dynamodb:UpdateItem'], [storage.usageTable.tableArn]);
    lensWeb.addEnvironment('SEARCH_SECRET_ARN', this.webSearchSecret.secretArn);
    this.webSearchSecret.grantRead(lensWeb);
    props.claudeKey.grantRead(lensWeb);
    allow(lensWeb, ['s3:GetObject'], [
      storage.mediaBucket.arnForObjects('lens/*'),
      storage.mediaBucket.arnForObjects('media/*'),
    ]);
    allow(lensWeb, ['dynamodb:Query'], [storage.framesTable.tableArn]);
    // "May this caller search from this frame" — the same check find-similar makes.
    allow(lensWeb, ['dynamodb:GetItem'], [storage.savesTable.tableArn]);
    // No Bedrock grant: Lens web reads entities off a frame and summarises the
    // search results, both on the Anthropic API, and it embeds nothing.

    /*
     * Admin. Signup is closed, so these routes are the only way an account comes
     * into existence — which is why the group claim is re-checked inside every
     * handler and not only at the door.
     */
    const adminDir = path.join(__dirname, '..', 'lambda', 'admin');
    const makeAdminFn = (name: string, exportName: string) =>
      new NodejsFunction(this, name, {
        entry: path.join(adminDir, 'invites.ts'),
        handler: exportName,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout: Duration.seconds(30),
        environment: {
          INVITES_TABLE: storage.invitesTable.tableName,
          USAGE_TABLE: storage.usageTable.tableName,
          USER_POOL_ID: props.auth.userPool.userPoolId,
        },
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.TWO_WEEKS }),
        bundling: { minify: true, sourceMap: true, format: OutputFormat.CJS, target: 'node22', externalModules: [] },
      });

    const inviteCreate = makeAdminFn('AdminInviteCreate', 'create');
    const inviteList = makeAdminFn('AdminInviteList', 'list');
    const inviteRevoke = makeAdminFn('AdminInviteRevoke', 'revoke');
    const adminUsage = makeAdminFn('AdminUsage', 'usage');

    // Named actions on this pool only — never a wildcard on cognito-idp, which
    // would include changing passwords and reading every user's attributes.
    inviteCreate.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminCreateUser'],
        resources: [props.auth.userPool.userPoolArn],
      }),
    );
    inviteList.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminGetUser'],
        resources: [props.auth.userPool.userPoolArn],
      }),
    );
    inviteRevoke.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminDeleteUser'],
        resources: [props.auth.userPool.userPoolArn],
      }),
    );
    allow(inviteCreate, ['dynamodb:PutItem'], [storage.invitesTable.tableArn]);
    allow(inviteList, ['dynamodb:Scan'], [storage.invitesTable.tableArn]);
    allow(inviteRevoke, ['dynamodb:DeleteItem'], [storage.invitesTable.tableArn]);
    allow(adminUsage, ['dynamodb:Scan'], [storage.usageTable.tableArn]);

    const listThreads = makeSearchFn('ListThreads', 'list-threads.ts');
    allow(listThreads, ['dynamodb:Query'], [`${storage.threadsTable.tableArn}/index/${Storage.THREADS_BY_CREATED_AT}`]);

    const getThread = makeSearchFn('GetThread', 'get-thread.ts');
    allow(getThread, ['dynamodb:Query'], [storage.messagesTable.tableArn]);
    // The ownership check, which is the only thing between a guessed thread id
    // and someone else's conversation.
    allow(getThread, ['dynamodb:GetItem'], [storage.threadsTable.tableArn]);

    // Retrying is a real re-run: it clears whatever a half-finished pipeline
    // left behind, so it needs the same reach as delete plus the pipeline.
    const retryMedia = makeFn('RetryMedia', 'retry-media.ts', { timeout: Duration.seconds(60) });
    allow(retryMedia, ['dynamodb:UpdateItem'], [storage.usageTable.tableArn]);
    // saves: you can only retry what you hold.
    allow(retryMedia, ['dynamodb:GetItem'], [storage.savesTable.tableArn]);
    this.retryMediaFunction = retryMedia;
    retryMedia.addEnvironment('CAPTION_FACTS_TABLE', storage.captionFactsTable.tableName);
    // Clearing stale index documents needs the collection endpoint; without it
    // the OpenSearch client fails with "Missing node(s) option".
    retryMedia.addEnvironment('SEARCH_ENDPOINT', props.search.endpoint);
    retryMedia.addEnvironment('SEARCH_INDEX', 'frames');
    allow(retryMedia, ['dynamodb:GetItem', 'dynamodb:UpdateItem'], [storage.mediaTable.tableArn]);
    allow(retryMedia, ['dynamodb:Query', 'dynamodb:BatchWriteItem'], [
      storage.framesTable.tableArn,
      storage.transcriptSegmentsTable.tableArn,
    ]);
    // A carousel's slide rows are reset rather than deleted — they carry the
    // s3_key of each slide, which nothing else can reproduce.
    allow(retryMedia, ['dynamodb:UpdateItem'], [storage.framesTable.tableArn]);
    allow(retryMedia, ['dynamodb:DeleteItem'], [storage.captionFactsTable.tableArn]);
    allow(retryMedia, ['s3:DeleteObject'], [storage.mediaBucket.arnForObjects('media/*')]);
    retryMedia.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [storage.mediaBucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': ['media/*'] } },
      }),
    );
    props.search.grantWrite(retryMedia);

    const routes: Array<[apigw.HttpMethod, string, NodejsFunction]> = [
      [apigw.HttpMethod.POST, '/uploads', createUpload],
      [apigw.HttpMethod.POST, '/media/{id}/complete', completeUpload],
      [apigw.HttpMethod.POST, '/media/url', createFromUrl],
      [apigw.HttpMethod.GET, '/media', listMedia],
      [apigw.HttpMethod.GET, '/media/{id}', getMedia],
      [apigw.HttpMethod.DELETE, '/media/{id}', deleteMedia],
      [apigw.HttpMethod.POST, '/media/{id}/retry', retryMedia],
      [apigw.HttpMethod.POST, '/ask', ask],
      // Focusing the question box hits this, so the collection is awake by the
      // time there is a question to run.
      [apigw.HttpMethod.POST, '/ask/warm', ask],
      [apigw.HttpMethod.POST, '/admin/invites', inviteCreate],
      [apigw.HttpMethod.GET, '/admin/invites', inviteList],
      [apigw.HttpMethod.DELETE, '/admin/invites/{email}', inviteRevoke],
      [apigw.HttpMethod.GET, '/admin/usage', adminUsage],
      [apigw.HttpMethod.GET, '/threads', listThreads],
      [apigw.HttpMethod.GET, '/threads/{id}', getThread],
      [apigw.HttpMethod.POST, '/lens/uploads', lensUpload],
      [apigw.HttpMethod.POST, '/lens/similar', lensSimilar],
      [apigw.HttpMethod.POST, '/lens/web', lensWeb],
      // Connected mode. The OAuth code is posted here by our own page rather
      // than landing on an unauthenticated callback, so it never leaves an
      // authenticated request.
      [apigw.HttpMethod.POST, '/connect/instagram/start', props.connected.startFunction],
      [apigw.HttpMethod.POST, '/connect/instagram/exchange', props.connected.exchangeFunction],
      [apigw.HttpMethod.GET, '/connect/instagram', props.connected.statusFunction],
      [apigw.HttpMethod.DELETE, '/connect/instagram', props.connected.disconnectFunction],
      [apigw.HttpMethod.POST, '/connect/instagram/sync', props.connected.syncFunction],
    ];

    for (const [method, routePath, fn] of routes) {
      this.httpApi.addRoutes({
        path: routePath,
        methods: [method],
        integration: new HttpLambdaIntegration(`${fn.node.id}Integration`, fn),
      });
    }
  }
}
