import { Construct } from 'constructs';
import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as path from 'node:path';
import type { Storage } from './storage';

export interface ConnectedProps {
  readonly storage: Storage;
  /** Where Meta sends the browser back. Must match the app's redirect URI exactly. */
  readonly redirectUri: string;
  /** Instagram app id. Not a secret, unlike the app secret. */
  readonly appId: string;
  /** Keep the token table and its key when the stack goes. */
  readonly retainData: boolean;
}

const LAMBDA_DIR = path.join(__dirname, '..', 'lambda', 'connect');

/**
 * Connected mode: Instagram API with Instagram Login.
 *
 * Covers the connected account's *own* media. It is not a way to reach other
 * people's reels — that is what drop-in mode is for — and it involves no
 * Instagram password, cookies or session.
 *
 * The long-lived token is held in DynamoDB encrypted with a customer-managed
 * KMS key, and refreshed on a schedule because it lasts 60 days and a lapse
 * means re-authorising by hand.
 */
export class Connected extends Construct {
  readonly table: dynamodb.Table;
  readonly appSecret: secretsmanager.Secret;
  readonly key: kms.Key;
  readonly startFunction: NodejsFunction;
  readonly exchangeFunction: NodejsFunction;
  readonly statusFunction: NodejsFunction;
  readonly disconnectFunction: NodejsFunction;
  readonly syncFunction: NodejsFunction;
  readonly refreshFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: ConnectedProps) {
    super(scope, id);
    const { storage } = props;
    const removalPolicy = props.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // A customer-managed key, not the AWS-owned default: this table holds a
    // credential for someone's Instagram account.
    this.key = new kms.Key(this, 'TokenKey', {
      description: 'Reel Lens Instagram token encryption',
      enableKeyRotation: true,
      // Destroying the key destroys the token with it, unrecoverably: the
      // ciphertext in the table is worthless without it.
      removalPolicy,
    });

    /*
     * PK user_id, SK kind: one connection row per person (`kind: 'connection'`)
     * plus their in-flight OAuth state rows (`kind: 'state#<state>'`).
     *
     * The user is in the key rather than in a field, which is what makes a state
     * impossible to consume across accounts — the lookup happens inside the
     * caller's own partition, so there is no check to forget.
     */
    this.table = new dynamodb.Table(this, 'ConnectionTable', {
      partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'kind', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: this.key,
      // OAuth state rows clean themselves up.
      timeToLiveAttribute: 'expires_at_epoch',
      // Losing this table means re-authorising Instagram by hand, which is the
      // very failure the refresh schedule exists to prevent.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.retainData },
      removalPolicy,
    });

    this.appSecret = new secretsmanager.Secret(this, 'AppSecret', {
      description: 'Instagram app secret. Set with: aws secretsmanager put-secret-value',
      encryptionKey: this.key,
    });

    const commonEnv = {
      IG_CONNECTION_TABLE: this.table.tableName,
      IG_APP_SECRET_ARN: this.appSecret.secretArn,
      IG_APP_ID: props.appId,
      IG_REDIRECT_URI: props.redirectUri,
      MEDIA_BUCKET: storage.mediaBucket.bucketName,
      MEDIA_TABLE: storage.mediaTable.tableName,
      SAVES_TABLE: storage.savesTable.tableName,
      USAGE_TABLE: storage.usageTable.tableName,
      FRAMES_TABLE: storage.framesTable.tableName,
      JOBS_TABLE: storage.jobsTable.tableName,
    };

    const makeFn = (name: string, file: string, exportName: string, timeout = Duration.seconds(30)) => {
      const fn = new NodejsFunction(this, name, {
        entry: path.join(LAMBDA_DIR, file),
        handler: exportName,
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 512,
        timeout,
        environment: commonEnv,
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.TWO_WEEKS }),
        bundling: { minify: true, sourceMap: true, format: OutputFormat.CJS, target: 'node22', externalModules: [] },
      });
      this.appSecret.grantRead(fn);
      this.key.grantEncryptDecrypt(fn);
      return fn;
    };

    this.startFunction = makeFn('Start', 'handlers.ts', 'start');
    this.table.grantWriteData(this.startFunction);

    this.exchangeFunction = makeFn('Exchange', 'handlers.ts', 'exchange');
    this.table.grantReadWriteData(this.exchangeFunction);

    this.statusFunction = makeFn('Status', 'handlers.ts', 'status');
    this.table.grantReadData(this.statusFunction);

    this.disconnectFunction = makeFn('Disconnect', 'handlers.ts', 'disconnect');
    this.table.grantWriteData(this.disconnectFunction);

    // Downloads each new reel into the media store, so it needs longer.
    this.syncFunction = makeFn('Sync', 'handlers.ts', 'sync', Duration.minutes(5));
    this.table.grantReadWriteData(this.syncFunction);
    this.syncFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [storage.mediaBucket.arnForObjects('media/*')],
      }),
    );
    this.syncFunction.addToRolePolicy(
      new iam.PolicyStatement({
        // GetItem because a post the account already holds — from a pasted link
        // or from someone else's sync — is saved rather than fetched again.
        // BatchGetItem reads the ig_media_id of what this caller already has.
        actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:BatchGetItem'],
        resources: [storage.mediaTable.tableArn],
      }),
    );
    // A sync creates saves, reads this caller's library, and is charged for it.
    this.syncFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:Query'],
        resources: [storage.savesTable.tableArn],
      }),
    );
    this.syncFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [storage.usageTable.tableArn],
      }),
    );
    // A carousel's slides are written straight in as frames.
    this.syncFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:BatchWriteItem'],
        resources: [storage.framesTable.tableArn],
      }),
    );

    this.refreshFunction = makeFn('Refresh', 'refresh.ts', 'handler');
    this.table.grantReadWriteData(this.refreshFunction);

    // Daily, because the token can be refreshed once it is 24 hours old and
    // lasts 60 days; this only acts inside the renewal window.
    new events.Rule(this, 'RefreshSchedule', {
      description: 'Refresh the Instagram long-lived token before it lapses',
      schedule: events.Schedule.rate(Duration.days(1)),
      targets: [new targets.LambdaFunction(this.refreshFunction)],
    });

    new CfnOutput(this, 'AppSecretArn', { value: this.appSecret.secretArn });
    new CfnOutput(this, 'RedirectUri', { value: props.redirectUri });
    new CfnOutput(this, 'TokenKeyArn', { value: this.key.keyArn });
    Stack.of(this);
  }
}
