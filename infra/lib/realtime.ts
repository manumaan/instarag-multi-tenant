import { Construct } from 'constructs';
import { Duration, Stack } from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { WebSocketLambdaAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { WebSocketLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'node:path';
import type { Auth } from './auth';
import type { Storage } from './storage';

export interface RealtimeProps {
  readonly storage: Storage;
  readonly auth: Auth;
}

const LAMBDA_DIR = path.join(__dirname, '..', 'lambda', 'realtime');

/**
 * WebSocket channel for job progress.
 *
 * The browser subscribes once; the media table's stream drives a broadcaster
 * that pushes each status change, so the Library needs no polling.
 */
export class Realtime extends Construct {
  readonly webSocketApi: apigw.WebSocketApi;
  readonly stage: apigw.WebSocketStage;

  constructor(scope: Construct, id: string, props: RealtimeProps) {
    super(scope, id);
    const { storage, auth } = props;

    const makeFn = (name: string, file: string, environment: Record<string, string>) =>
      new NodejsFunction(this, name, {
        entry: path.join(LAMBDA_DIR, file),
        handler: 'main',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: Duration.seconds(15),
        environment,
        logGroup: new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.TWO_WEEKS }),
        bundling: { minify: true, sourceMap: true, format: OutputFormat.CJS, target: 'node22', externalModules: [] },
      });

    const authorizerFn = makeFn('WsAuthorizer', 'authorizer.ts', {
      USER_POOL_ID: auth.userPool.userPoolId,
      USER_POOL_CLIENT_ID: auth.userPoolClient.userPoolClientId,
    });

    const connectFn = makeFn('WsConnect', 'connect.ts', {
      CONNECTIONS_TABLE: storage.connectionsTable.tableName,
    });
    connectFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [storage.connectionsTable.tableArn] }),
    );

    const disconnectFn = makeFn('WsDisconnect', 'disconnect.ts', {
      CONNECTIONS_TABLE: storage.connectionsTable.tableName,
    });
    disconnectFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['dynamodb:DeleteItem'], resources: [storage.connectionsTable.tableArn] }),
    );

    this.webSocketApi = new apigw.WebSocketApi(this, 'WebSocketApi', {
      description: 'Reel Lens job progress',
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration('ConnectIntegration', connectFn),
        // The id token arrives as ?token=… because WebSocket APIs cannot read headers.
        authorizer: new WebSocketLambdaAuthorizer('WsTokenAuthorizer', authorizerFn, {
          identitySource: ['route.request.querystring.token'],
        }),
      },
      disconnectRouteOptions: {
        integration: new WebSocketLambdaIntegration('DisconnectIntegration', disconnectFn),
      },
    });

    this.stage = new apigw.WebSocketStage(this, 'Stage', {
      webSocketApi: this.webSocketApi,
      stageName: 'prod',
      autoDeploy: true,
      throttle: { rateLimit: 20, burstLimit: 40 },
    });

    const broadcastFn = makeFn('WsBroadcast', 'broadcast.ts', {
      CONNECTIONS_TABLE: storage.connectionsTable.tableName,
      WS_MANAGEMENT_ENDPOINT: `https://${this.webSocketApi.apiId}.execute-api.${Stack.of(this).region}.amazonaws.com/${this.stage.stageName}`,
    });
    broadcastFn.addEventSource(
      new DynamoEventSource(storage.mediaTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(1),
        retryAttempts: 3,
      }),
    );
    broadcastFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Scan', 'dynamodb:DeleteItem'],
        resources: [storage.connectionsTable.tableArn],
      }),
    );
    this.webSocketApi.grantManageConnections(broadcastFn);
  }

  /** wss:// URL the browser connects to. */
  get url(): string {
    return this.stage.url;
  }
}
