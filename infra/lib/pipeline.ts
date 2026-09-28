import { Construct } from 'constructs';
import { Duration, Size } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as path from 'node:path';
import { Storage } from './storage';
import { Search } from './search';

/**
 * Bedrock serves current Claude models through cross-region inference profiles,
 * so the id carries a `us.` prefix and the underlying foundation model needs
 * permission in every region the profile can route to.
 */

export interface PipelineProps {
  readonly storage: Storage;
  /** Vector index the embedding stage writes to. */
  readonly search: Search;
  /** Bedrock model for the vision pass. Override with -c analysisModel=... */
  readonly analysisModel: string;
  readonly claudeKey: secretsmanager.Secret;
  /** Keyframe cap, which is the main cost lever on the analysis call. */
  readonly maxFrames: number;
  /** Titan Multimodal Embeddings model for the index stage. */
  readonly embeddingModel: string;
}

/**
 * Ingest pipeline: keyframe extraction driven by Step Functions.
 *
 * The state machine owns every status transition on the media record, so the
 * Library always reflects where an item actually is. Phase 3 inserts the Claude
 * analysis pass between extraction and `ready`.
 *
 * Execution input: `{ mediaId, source, jobExpiresAt }`. `source: 'url'` adds a
 * download leg ahead of extraction; jobExpiresAt is the epoch second the job row
 * should expire (the TTL on the jobs table), as a string.
 */
export class Pipeline extends Construct {
  readonly extractFunction: lambda.DockerImageFunction;
  readonly downloadFunction: lambda.DockerImageFunction;
  readonly thumbnailFunction: lambda.DockerImageFunction;
  readonly analyseFunction: NodejsFunction;
  readonly storeTranscriptFunction: NodejsFunction;
  readonly indexFunction: NodejsFunction;
  readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: PipelineProps) {
    super(scope, id);
    const { storage } = props;

    // One image, two handlers: extraction and reel download both want ffmpeg.
    const image = path.join(__dirname, '..', 'extract');

    this.extractFunction = new lambda.DockerImageFunction(this, 'ExtractFrames', {
      code: lambda.DockerImageCode.fromImageAsset(image, {
        platform: Platform.LINUX_ARM64,
      }),
      architecture: lambda.Architecture.ARM_64,
      // ffmpeg is CPU-bound and Lambda scales vCPU with memory, so this is the
      // cheapest setting per reel rather than the most generous.
      memorySize: 3008,
      timeout: Duration.minutes(5),
      // A 500 MB upload plus its decoded frames needs more than the default 512 MB.
      ephemeralStorageSize: Size.mebibytes(2048),
      environment: {
        MEDIA_BUCKET: storage.mediaBucket.bucketName,
        MEDIA_TABLE: storage.mediaTable.tableName,
        FRAMES_TABLE: storage.framesTable.tableName,
        MAX_FRAMES: String(props.maxFrames),
      },
      logGroup: new logs.LogGroup(this, 'ExtractFramesLogs', { retention: logs.RetentionDays.TWO_WEEKS }),
    });

    this.extractFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [storage.mediaBucket.arnForObjects('media/*')],
      }),
    );
    this.extractFunction.addToRolePolicy(
      new iam.PolicyStatement({
        // UpdateItem as well as GetItem: extraction records the cover frame's
        // key on the record for the library grid.
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [storage.mediaTable.tableArn],
      }),
    );
    this.extractFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:BatchWriteItem'], resources: [storage.framesTable.tableArn] }),
    );

    // Fetches the video behind a public reel permalink. Same image, different CMD.
    this.downloadFunction = new lambda.DockerImageFunction(this, 'DownloadReel', {
      code: lambda.DockerImageCode.fromImageAsset(image, {
        platform: Platform.LINUX_ARM64,
        cmd: ['download.handler'],
      }),
      architecture: lambda.Architecture.ARM_64,
      // Network-bound rather than CPU-bound, so less memory than extraction.
      memorySize: 2048,
      timeout: Duration.minutes(5),
      ephemeralStorageSize: Size.mebibytes(2048),
      environment: {
        MEDIA_BUCKET: storage.mediaBucket.bucketName,
        MEDIA_TABLE: storage.mediaTable.tableName,
        FRAMES_TABLE: storage.framesTable.tableName,
      },
      logGroup: new logs.LogGroup(this, 'DownloadReelLogs', { retention: logs.RetentionDays.TWO_WEEKS }),
    });
    this.downloadFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [storage.mediaBucket.arnForObjects('media/*')],
      }),
    );
    this.downloadFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [storage.mediaTable.tableArn],
      }),
    );
    // An image post's slides are registered as frames here, the same way the
    // extractor registers keyframes: for a carousel there is no extraction step.
    this.downloadFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:BatchWriteItem'],
        resources: [storage.framesTable.tableArn],
      }),
    );

    /*
     * Third handler from the same image. Extraction and download write the
     * grid's thumbnail inline, so this exists for items ingested before
     * thumbnails did: re-running extraction on them would rewrite their frame
     * rows and discard the analysis sitting on those rows.
     */
    this.thumbnailFunction = new lambda.DockerImageFunction(this, 'Thumbnail', {
      code: lambda.DockerImageCode.fromImageAsset(image, {
        platform: Platform.LINUX_ARM64,
        cmd: ['thumbnail.handler'],
      }),
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(2),
      environment: {
        MEDIA_BUCKET: storage.mediaBucket.bucketName,
        MEDIA_TABLE: storage.mediaTable.tableName,
      },
      logGroup: new logs.LogGroup(this, 'ThumbnailLogs', { retention: logs.RetentionDays.TWO_WEEKS }),
    });
    this.thumbnailFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [storage.mediaBucket.arnForObjects('media/*')],
      }),
    );
    this.thumbnailFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [storage.mediaTable.tableArn],
      }),
    );

    // Vision pass: one Bedrock call carrying every keyframe of the reel.
    this.analyseFunction = new NodejsFunction(this, 'AnalyseReel', {
      entry: path.join(__dirname, '..', 'lambda', 'analyse', 'index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // Holds ~20 base64 frames in memory; the work is waiting on Bedrock.
      memorySize: 1024,
      timeout: Duration.minutes(5),
      environment: {
        MEDIA_BUCKET: storage.mediaBucket.bucketName,
        MEDIA_TABLE: storage.mediaTable.tableName,
        FRAMES_TABLE: storage.framesTable.tableName,
        CAPTION_FACTS_TABLE: storage.captionFactsTable.tableName,
        ANALYSIS_MODEL_ID: props.analysisModel,
        CLAUDE_KEY_SECRET_ARN: props.claudeKey.secretArn,
      },
      logGroup: new logs.LogGroup(this, 'AnalyseReelLogs', { retention: logs.RetentionDays.TWO_WEEKS }),
      bundling: { minify: true, sourceMap: true, format: OutputFormat.CJS, target: 'node22', externalModules: [] },
    });

    // The vision pass calls the Anthropic API, so it needs the key rather than
    // Bedrock. Nothing in this handler touches a Bedrock model any more.
    props.claudeKey.grantRead(this.analyseFunction);
    this.analyseFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [storage.mediaBucket.arnForObjects('media/*')],
      }),
    );
    this.analyseFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [storage.mediaTable.tableArn],
      }),
    );
    this.analyseFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:UpdateItem'],
        resources: [storage.framesTable.tableArn],
      }),
    );
    this.analyseFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [storage.captionFactsTable.tableArn],
      }),
    );

    // Reads Amazon Transcribe's output into citable segments.
    this.storeTranscriptFunction = new NodejsFunction(this, 'StoreTranscriptFn', {
      entry: path.join(__dirname, '..', 'lambda', 'transcript', 'store.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.minutes(2),
      environment: {
        MEDIA_BUCKET: storage.mediaBucket.bucketName,
        MEDIA_TABLE: storage.mediaTable.tableName,
        FRAMES_TABLE: storage.framesTable.tableName,
        JOBS_TABLE: storage.jobsTable.tableName,
        TRANSCRIPT_SEGMENTS_TABLE: storage.transcriptSegmentsTable.tableName,
      },
      logGroup: new logs.LogGroup(this, 'StoreTranscriptFnLogs', { retention: logs.RetentionDays.TWO_WEEKS }),
      bundling: { minify: true, sourceMap: true, format: OutputFormat.CJS, target: 'node22', externalModules: [] },
    });
    this.storeTranscriptFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [storage.mediaBucket.arnForObjects('media/*')],
      }),
    );
    this.storeTranscriptFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:UpdateItem'], resources: [storage.mediaTable.tableArn] }),
    );
    this.storeTranscriptFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem'],
        resources: [storage.transcriptSegmentsTable.tableArn],
      }),
    );

    // Embedding + indexing: one document per keyframe in the vector index.
    this.indexFunction = new NodejsFunction(this, 'IndexFrames', {
      entry: path.join(__dirname, '..', 'lambda', 'search', 'index-frames.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(5),
      environment: {
        MEDIA_BUCKET: storage.mediaBucket.bucketName,
        MEDIA_TABLE: storage.mediaTable.tableName,
        FRAMES_TABLE: storage.framesTable.tableName,
        JOBS_TABLE: storage.jobsTable.tableName,
        CAPTION_FACTS_TABLE: storage.captionFactsTable.tableName,
        TRANSCRIPT_SEGMENTS_TABLE: storage.transcriptSegmentsTable.tableName,
        SEARCH_ENDPOINT: props.search.endpoint,
        SEARCH_INDEX: Search.INDEX_NAME,
      },
      logGroup: new logs.LogGroup(this, 'IndexFramesLogs', { retention: logs.RetentionDays.TWO_WEEKS }),
      bundling: { minify: true, sourceMap: true, format: OutputFormat.CJS, target: 'node22', externalModules: [] },
    });
    this.indexFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [storage.mediaBucket.arnForObjects('media/*')],
      }),
    );
    this.indexFunction.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [storage.mediaTable.tableArn, storage.captionFactsTable.tableArn] }),
    );
    this.indexFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query'],
        resources: [storage.framesTable.tableArn, storage.transcriptSegmentsTable.tableArn],
      }),
    );
    this.indexFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [`arn:aws:bedrock:*::foundation-model/${props.embeddingModel}`],
      }),
    );
    props.search.grantWrite(this.indexFunction);

    const setMediaStatus = (stateId: string, status: string, extra?: Record<string, string>) =>
      new tasks.DynamoUpdateItem(this, stateId, {
        table: storage.mediaTable,
        key: { id: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.mediaId')) },
        updateExpression: `SET #status = :status${extra ? Object.keys(extra).map((k) => `, #${k} = :${k}`).join('') : ''}`,
        expressionAttributeNames: {
          '#status': 'status',
          ...Object.fromEntries(Object.keys(extra ?? {}).map((k) => [`#${k}`, k])),
        },
        expressionAttributeValues: {
          ':status': tasks.DynamoAttributeValue.fromString(status),
          ...Object.fromEntries(
            Object.entries(extra ?? {}).map(([k, v]) => [
              `:${k}`,
              tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt(v)),
            ]),
          ),
        },
        // Never recreate a record the user deleted mid-pipeline: UpdateItem
        // would otherwise write a zombie row straight back into the library.
        conditionExpression: 'attribute_exists(id)',
        resultPath: sfn.JsonPath.DISCARD,
      });

    const startJob = new tasks.DynamoPutItem(this, 'StartJob', {
      table: storage.jobsTable,
      item: {
        id: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.Execution.Name')),
        media_id: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.mediaId')),
        stage: tasks.DynamoAttributeValue.fromString('extract'),
        status: tasks.DynamoAttributeValue.fromString('running'),
        started_at: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.Execution.StartTime')),
        // Supplied by the caller: Step Functions has no intrinsic for "now".
        // numberFromString, not fromNumber: a JSONPath number renders as a JSON
        // number and DynamoDB requires the 'N' field to be a string.
        expires_at: tasks.DynamoAttributeValue.numberFromString(sfn.JsonPath.stringAt('$.jobExpiresAt')),
      },
      resultPath: sfn.JsonPath.DISCARD,
    });

    const finishJob = (stateId: string, status: string) =>
      new tasks.DynamoUpdateItem(this, stateId, {
        table: storage.jobsTable,
        key: { id: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.Execution.Name')) },
        updateExpression: 'SET #status = :status, finished_at = :now',
        expressionAttributeNames: { '#status': 'status' },
        expressionAttributeValues: {
          ':status': tasks.DynamoAttributeValue.fromString(status),
          ':now': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.State.EnteredTime')),
        },
        resultPath: sfn.JsonPath.DISCARD,
      });

    const downloadReel = new tasks.LambdaInvoke(this, 'Download', {
      lambdaFunction: this.downloadFunction,
      payload: sfn.TaskInput.fromObject({ mediaId: sfn.JsonPath.stringAt('$.mediaId') }),
      payloadResponseOnly: true,
      resultPath: '$.download',
      taskTimeout: sfn.Timeout.duration(Duration.minutes(5)),
    });
    downloadReel.addRetry({
      // A login wall will not clear on a retry; only transient faults are retried.
      errors: ['DownloadFailed', 'Lambda.ServiceException', 'Lambda.SdkClientException', 'Lambda.TooManyRequestsException'],
      interval: Duration.seconds(5),
      maxAttempts: 2,
      backoffRate: 2,
    });

    const extract = new tasks.LambdaInvoke(this, 'Extract', {
      lambdaFunction: this.extractFunction,
      payload: sfn.TaskInput.fromObject({ mediaId: sfn.JsonPath.stringAt('$.mediaId') }),
      payloadResponseOnly: true,
      resultPath: '$.extract',
      taskTimeout: sfn.Timeout.duration(Duration.minutes(5)),
    });
    extract.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.SdkClientException', 'Lambda.TooManyRequestsException'],
      interval: Duration.seconds(2),
      maxAttempts: 3,
      backoffRate: 2,
    });

    // Anything that escapes the retries leaves a visible failure on the record
    // rather than an item stuck on `extracting` forever.
    const markFailed = new tasks.DynamoUpdateItem(this, 'MarkFailed', {
      table: storage.mediaTable,
      key: { id: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.mediaId')) },
      updateExpression: 'SET #status = :status, #error = :error',
      expressionAttributeNames: { '#status': 'status', '#error': 'error' },
      expressionAttributeValues: {
        ':status': tasks.DynamoAttributeValue.fromString('failed'),
        ':error': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.error.Cause')),
      },
      conditionExpression: 'attribute_exists(id)',
      resultPath: sfn.JsonPath.DISCARD,
    });

    const onFailure = markFailed.next(finishJob('FailJob', 'failed')).next(new sfn.Fail(this, 'Failed'));

    const markExtracting = setMediaStatus('MarkExtracting', 'extracting');
    const markReady = setMediaStatus('MarkReady', 'ready');

    const analyse = new tasks.LambdaInvoke(this, 'Analyse', {
      lambdaFunction: this.analyseFunction,
      payload: sfn.TaskInput.fromObject({ mediaId: sfn.JsonPath.stringAt('$.mediaId') }),
      payloadResponseOnly: true,
      resultPath: '$.analysis',
      taskTimeout: sfn.Timeout.duration(Duration.minutes(5)),
    });
    analyse.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.SdkClientException', 'Lambda.TooManyRequestsException', 'ThrottlingException'],
      interval: Duration.seconds(5),
      maxAttempts: 3,
      backoffRate: 2,
    });

    const indexFrames = new tasks.LambdaInvoke(this, 'Index', {
      lambdaFunction: this.indexFunction,
      payload: sfn.TaskInput.fromObject({ mediaId: sfn.JsonPath.stringAt('$.mediaId') }),
      payloadResponseOnly: true,
      resultPath: '$.index',
      taskTimeout: sfn.Timeout.duration(Duration.minutes(5)),
    });
    indexFrames.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.SdkClientException', 'Lambda.TooManyRequestsException', 'ThrottlingException'],
      interval: Duration.seconds(5),
      maxAttempts: 3,
      backoffRate: 2,
    });

    /**
     * Transcription runs as an Amazon Transcribe batch job. Step Functions
     * starts it and polls, so nothing holds a Lambda open while it waits, and
     * the reel does not reach `ready` until its speech is searchable.
     */
    const transcriptKey = sfn.JsonPath.format(
      'media/{}/transcript.json',
      sfn.JsonPath.stringAt('$.mediaId'),
    );

    const startTranscribe = new tasks.CallAwsService(this, 'StartTranscribe', {
      service: 'transcribe',
      action: 'startTranscriptionJob',
      parameters: {
        // The execution name is unique, which keeps the job name unique on retry.
        TranscriptionJobName: sfn.JsonPath.format(
          '{}-{}',
          sfn.JsonPath.stringAt('$.mediaId'),
          sfn.JsonPath.stringAt('$$.Execution.Name'),
        ),
        Media: {
          MediaFileUri: sfn.JsonPath.format(
            's3://{}/{}',
            storage.mediaBucket.bucketName,
            sfn.JsonPath.stringAt('$.extract.audioS3Key'),
          ),
        },
        OutputBucketName: storage.mediaBucket.bucketName,
        OutputKey: transcriptKey,
        // Reels are not reliably in one language, so let Transcribe decide.
        IdentifyLanguage: true,
      },
      iamResources: ['*'],
      iamAction: 'transcribe:StartTranscriptionJob',
      resultPath: '$.transcribe',
    });

    const waitForTranscribe = new sfn.Wait(this, 'WaitForTranscribe', {
      // 5s, not 10: the whole wait used to sit on the critical path, and even
      // now it is only worth what the analysis call does not already cover.
      time: sfn.WaitTime.duration(Duration.seconds(5)),
    });

    const checkTranscribe = new tasks.CallAwsService(this, 'CheckTranscribe', {
      service: 'transcribe',
      action: 'getTranscriptionJob',
      parameters: {
        TranscriptionJobName: sfn.JsonPath.stringAt('$.transcribe.TranscriptionJob.TranscriptionJobName'),
      },
      iamResources: ['*'],
      iamAction: 'transcribe:GetTranscriptionJob',
      resultPath: '$.transcribe',
    });

    const storeTranscript = new tasks.LambdaInvoke(this, 'StoreTranscript', {
      lambdaFunction: this.storeTranscriptFunction,
      payload: sfn.TaskInput.fromObject({
        mediaId: sfn.JsonPath.stringAt('$.mediaId'),
        transcriptKey,
      }),
      payloadResponseOnly: true,
      resultPath: '$.transcript',
      taskTimeout: sfn.Timeout.duration(Duration.minutes(2)),
    });

    // Everything from indexing onwards is shared by all branches.
    const indexOnwards = setMediaStatus('MarkIndexing', 'indexing')
      .next(indexFrames)
      .next(markReady)
      .next(finishJob('FinishJob', 'succeeded'))
      .next(new sfn.Succeed(this, 'Done'));

    // Poll the Transcribe job. A failed transcription still leaves a usable
    // reel — the frames are analysed — so the branch succeeds either way
    // rather than failing the whole item.
    const transcribeOutcome = new sfn.Choice(this, 'TranscribeDone')
      .when(
        sfn.Condition.stringEquals('$.transcribe.TranscriptionJob.TranscriptionJobStatus', 'COMPLETED'),
        storeTranscript,
      )
      .when(
        sfn.Condition.stringEquals('$.transcribe.TranscriptionJob.TranscriptionJobStatus', 'FAILED'),
        new sfn.Pass(this, 'TranscriptionUnavailable', {
          comment: 'Transcribe could not process the audio; the frames are still analysed',
        }),
      )
      .otherwise(waitForTranscribe);

    const transcribeBranch = startTranscribe.next(waitForTranscribe).next(checkTranscribe).next(transcribeOutcome);

    /**
     * Analysis and transcription run side by side: they read the same reel but
     * write different fields, and neither needs the other's output. In series
     * they cost the sum (~25s of a 75s pipeline); in parallel the transcription
     * poll hides behind the vision call almost entirely.
     */
    // The same Lambda, a distinct state: a definition cannot visit one state
    // from two different paths.
    const analyseCarousel = new tasks.LambdaInvoke(this, 'AnalyseCarousel', {
      lambdaFunction: this.analyseFunction,
      payload: sfn.TaskInput.fromObject({ mediaId: sfn.JsonPath.stringAt('$.mediaId') }),
      payloadResponseOnly: true,
      resultPath: '$.analysis',
      taskTimeout: sfn.Timeout.duration(Duration.minutes(5)),
    });
    analyseCarousel.addRetry({
      errors: ['Lambda.ServiceException', 'Lambda.SdkClientException', 'Lambda.TooManyRequestsException', 'ThrottlingException'],
      interval: Duration.seconds(5),
      maxAttempts: 3,
      backoffRate: 2,
    });

    const analyseAndTranscribe = new sfn.Parallel(this, 'AnalyseAndTranscribe', {
      // The branches persist their own results; the next state needs the
      // original input, not an array of branch outputs.
      resultPath: sfn.JsonPath.DISCARD,
    })
      .branch(analyse)
      .branch(
        // Screenshots and silent clips have nothing to transcribe.
        new sfn.Choice(this, 'HasAudio')
          .when(sfn.Condition.booleanEquals('$.extract.hasAudio', true), transcribeBranch)
          .otherwise(new sfn.Pass(this, 'NoAudio')),
      );

    const extractOnwards = markExtracting
      .next(extract)
      // One status for the pair, because in parallel there is no meaningful
      // order between "analysing" and "transcribing".
      .next(setMediaStatus('MarkAnalysing', 'analysing'))
      .next(analyseAndTranscribe)
      .next(indexOnwards);

    /**
     * A carousel's slides were registered as frames at upload time, so there is
     * nothing to download, no video to extract from and no audio to transcribe.
     * It joins the pipeline at the vision pass.
     */
    const analyseOnwards = setMediaStatus('MarkAnalysingSlides', 'analysing')
      .next(analyseCarousel)
      .next(indexOnwards);

    /*
     * A pasted permalink has to be fetched first; an upload is already in S3.
     *
     * Both conditions are guarded with isPresent because a Choice whose path is
     * absent does not fall through to the next condition — it fails the whole
     * execution with States.Runtime "references an invalid value". An upload
     * carries no `kind`, so the unguarded version broke every reel while the
     * carousel path it was added for still worked.
     */
    const isCarousel = sfn.Condition.and(
      sfn.Condition.isPresent('$.kind'),
      sfn.Condition.stringEquals('$.kind', 'carousel'),
    );
    const isUrl = sfn.Condition.and(
      sfn.Condition.isPresent('$.source'),
      sfn.Condition.stringEquals('$.source', 'url'),
    );
    /*
     * A pasted permalink can turn out to be either. Only the metadata pass knows
     * which, so the branch happens on what Download reported rather than on the
     * url: a reel has a video to extract from, an image post has slides that are
     * frames already and joins at the vision pass.
     */
    const afterDownload = new sfn.Choice(this, 'DownloadedSlides')
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent('$.download.kind'),
          sfn.Condition.stringEquals('$.download.kind', 'carousel'),
        ),
        analyseOnwards,
      )
      .otherwise(extractOnwards);

    const needsDownload = new sfn.Choice(this, 'NeedsDownload')
      .when(isCarousel, analyseOnwards)
      .when(isUrl, setMediaStatus('MarkDownloading', 'downloading').next(downloadReel).next(afterDownload))
      .otherwise(extractOnwards);

    const definition = startJob.next(needsDownload);

    // Every state catches, not just extraction: a failure anywhere has to land
    // on `failed` with a reason, or the Library shows `queued` forever.
    for (const state of [
      startJob,
      markExtracting,
      downloadReel,
      extract,
      analyseAndTranscribe,
      analyseCarousel,
      indexFrames,
      markReady,
    ]) {
      state.addCatch(onFailure, { resultPath: '$.error' });
    }

    const stateMachine = new sfn.StateMachine(this, 'IngestPipeline', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.minutes(15),
      logs: {
        destination: new logs.LogGroup(this, 'IngestPipelineLogs', { retention: logs.RetentionDays.TWO_WEEKS }),
        level: sfn.LogLevel.ERROR,
      },
    });
    this.stateMachine = stateMachine;

    // Transcribe reads the audio and writes its output using the *caller's*
    // permissions, and the caller here is the state machine itself. Without
    // this the job fails with "The specified S3 bucket can't be accessed".
    stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject'],
        resources: [storage.mediaBucket.arnForObjects('media/*')],
      }),
    );
  }
}
