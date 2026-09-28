import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ReelLensStack } from '../lib/reel-lens-stack';


/**
 * The state machine definition as a graph.
 *
 * Asserting on substring positions in the serialized definition looked fine
 * until a state called MarkAnalysingSlides appeared, which contains
 * MarkAnalysing: the old check then compared the wrong pair. Parsing gives
 * real reachability instead. Tokens become a placeholder so the JSON parses.
 */
function stateMachineGraph(template: Template): Record<string, Record<string, unknown>> {
  const machine = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0];
  const definition = machine.Properties.DefinitionString;
  const parts: unknown[] = definition['Fn::Join'] ? definition['Fn::Join'][1] : [definition];
  const flattened = parts.map((part) => (typeof part === 'string' ? part : 'TOKEN')).join('');
  return JSON.parse(flattened).States as Record<string, Record<string, unknown>>;
}

/** Every state reachable from `from`, following Next, Choices, Default and branches. */
function reachableFrom(states: Record<string, Record<string, unknown>>, from: string): Set<string> {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (seen.has(name) || !states[name]) continue;
    seen.add(name);
    const state = states[name];
    const next: string[] = [];
    if (typeof state.Next === 'string') next.push(state.Next);
    if (typeof state.Default === 'string') next.push(state.Default);
    for (const choice of (state.Choices ?? []) as Array<{ Next?: string }>) {
      if (choice.Next) next.push(choice.Next);
    }
    for (const branch of (state.Branches ?? []) as Array<{ StartAt?: string; States?: Record<string, Record<string, unknown>> }>) {
      if (branch.StartAt) seen.add(branch.StartAt);
      for (const inner of Object.keys(branch.States ?? {})) seen.add(inner);
    }
    queue.push(...next);
  }
  return seen;
}

function synth(overrides: { retainData?: boolean } = {}) {
  const app = new App();
  const stack = new ReelLensStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    webOrigins: ['http://localhost:3000'],
    // Defaults to what is actually deployed, so the rest of the suite exercises
    // the real configuration rather than a throwaway one.
    retainData: overrides.retainData ?? true,
    analysisModel: 'claude-opus-5',
    answerModel: 'claude-sonnet-5',
    expansionModel: 'claude-haiku-4-5',
    maxFrames: 20,
    embeddingModel: 'amazon.titan-embed-image-v1',
    maxOcu: 2,
    instagramAppId: '1234567890',
    monthlyBudget: 20,
    hourlyTokenBudget: 500_000,
  });
  return Template.fromStack(stack);
}

test('every API route is authorised by the user pool', () => {
  const template = synth();
  const routes = Object.entries(template.findResources('AWS::ApiGatewayV2::Route')).filter(
    ([, route]) => !String(route.Properties.RouteKey).startsWith('$'),
  );
  assert.equal(routes.length, 19);
  for (const [name, route] of routes) {
    assert.equal(route.Properties.AuthorizationType, 'JWT', `${name} must require a JWT`);
  }
});

test('the user pool refuses self-signup and hands out no client secret', () => {
  const template = synth();
  template.hasResourceProperties('AWS::Cognito::UserPool', {
    AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
  });
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    GenerateSecret: false,
    AllowedOAuthFlows: ['code'],
  });
});

test('the media bucket is private, encrypted and TLS-only', () => {
  const template = synth();
  template.hasResourceProperties('AWS::S3::Bucket', {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    BucketEncryption: Match.objectLike({ ServerSideEncryptionConfiguration: Match.anyValue() }),
  });
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } }),
      ]),
    }),
  });
});

test('no handler policy grants a wildcard action or an unscoped table', () => {
  const template = synth();
  for (const [name, policy] of Object.entries(template.findResources('AWS::IAM::Policy'))) {
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      const actions: string[] = [statement.Action].flat();
      for (const action of actions) {
        assert.ok(
          !/^(\*|s3:\*|dynamodb:\*)$/.test(action),
          `${name} grants overly broad action ${action}`,
        );
      }
      // dynamodb:ListStreams is the one action IAM cannot scope to a resource;
      // everything else must name its table, index or stream.
      const unscoped = actions.filter((a) => a.startsWith('dynamodb:') && a !== 'dynamodb:ListStreams');
      assert.ok(
        !(statement.Resource === '*' && unscoped.length > 0),
        `${name} grants ${unscoped.join(', ')} on *`,
      );
    }
  }
});

test('handlers only see table and bucket names, never credentials', () => {
  const template = synth();
  for (const [name, fn] of Object.entries(template.findResources('AWS::Lambda::Function'))) {
    // CDK's own custom-resource providers (bucket deployment, auto-delete) set
    // their own env vars; this check is about the handlers we write.
    if (name.startsWith('Custom')) continue;
    const env = fn.Properties.Environment?.Variables ?? {};
    for (const key of Object.keys(env)) {
      assert.ok(
        // Resource identifiers only — never a secret, key or token.
        /^(MEDIA_BUCKET|MEDIA_TABLE|FRAMES_TABLE|JOBS_TABLE|CONNECTIONS_TABLE|CAPTION_FACTS_TABLE|TRANSCRIPT_SEGMENTS_TABLE|STATE_MACHINE_ARN|USER_POOL_ID|USER_POOL_CLIENT_ID|WS_MANAGEMENT_ENDPOINT|SCENE_THRESHOLD|MAX_FRAMES|PHASH_THRESHOLD|MAX_DOWNLOAD_BYTES|YT_DLP_PATH|HOME|XDG_CACHE_HOME|ANALYSIS_MODEL_ID|ANSWER_MODEL_ID|EXPANSION_MODEL_ID|PLAN_WORKER_ARN|THUMBNAIL_FUNCTION_ARN|CLAUDE_KEY_SECRET_ARN|SEARCH_SECRET_ARN|IG_CONNECTION_TABLE|IG_APP_SECRET_ARN|IG_APP_ID|IG_REDIRECT_URI|IG_GRAPH_HOST|IG_AUTHORIZE_URL|IG_TOKEN_URL|ANALYSIS_EFFORT|ANALYSIS_MAX_TOKENS|THREADS_TABLE|SAVES_TABLE|USAGE_TABLE|MESSAGES_TABLE|SEARCH_ENDPOINT|SEARCH_INDEX|EMBEDDING_MODEL_ID|EMBEDDING_DIMENSION|AWS_NODEJS_CONNECTION_REUSE_ENABLED)$/.test(
          key,
        ),
        `${name} has unexpected env var ${key}`,
      );
    }
  }
});

test('extraction and download are containers with room for a 500 MB reel', () => {
  const template = synth();
  const functions = Object.values(template.findResources('AWS::Lambda::Function')).filter(
    (fn) => fn.Properties.PackageType === 'Image',
  );
  assert.equal(functions.length, 3, 'extraction, download and the thumbnailer');

  const cmd = (fn: Record<string, any>) => fn.Properties.ImageConfig?.Command?.[0] ?? 'index.handler';
  // The two that move whole reels around. The thumbnailer is deliberately not
  // one of them: it copies a single small image and needs neither the storage
  // nor the five minutes.
  const heavy = functions.filter((fn) => cmd(fn) !== 'thumbnail.handler');
  assert.equal(heavy.length, 2);
  for (const fn of heavy) {
    assert.deepEqual(fn.Properties.Architectures, ['arm64']);
    assert.equal(fn.Properties.EphemeralStorage.Size, 2048);
    assert.ok(fn.Properties.Timeout >= 300, `timeout ${fn.Properties.Timeout}s is too short`);
  }

  // All three come from the same image asset; only the CMD differs.
  const images = new Set(functions.map((fn) => JSON.stringify(fn.Properties.Code.ImageUri)));
  assert.equal(images.size, 1, 'one image asset, three handlers');
  assert.deepEqual(functions.map(cmd).sort(), ['download.handler', 'index.handler', 'thumbnail.handler']);
});

test('a pasted permalink is downloaded before extraction, an upload is not', () => {
  const template = synth();
  const machine = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0];
  const definition = JSON.stringify(machine.Properties.DefinitionString);
  for (const state of ['NeedsDownload', 'MarkDownloading', 'Download']) {
    assert.ok(definition.includes(state), `definition is missing ${state}`);
  }
  // The branch keys off the execution input's source field.
  assert.ok(definition.includes('$.source'), 'download branch must test $.source');
  assert.ok(definition.includes('url'), 'download branch must match source url');
});

test('the pipeline is a state machine that cannot leave an item mid-flight', () => {
  const template = synth();
  template.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  const machine = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0];
  const definition = JSON.stringify(machine.Properties.DefinitionString);
  for (const state of ['StartJob', 'MarkExtracting', 'Extract', 'MarkReady', 'MarkFailed', 'FailJob']) {
    assert.ok(definition.includes(state), `definition is missing ${state}`);
  }
  assert.ok(definition.includes('Catch'), 'extraction failures must be caught and recorded');
});

test('only the ingest handlers may start the pipeline, and only that one', () => {
  const template = synth();
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>,
  );
  // Three ingest routes start the pipeline: completed upload, pasted permalink,
  // and a connected-mode sync.
  const starts = statements.filter((s) => [s.Action].flat().includes('states:StartExecution'));
  assert.equal(
    starts.length,
    4,
    'only the ingest handlers and retry may start the pipeline',
  );
  for (const statement of starts) {
    assert.ok(
      !JSON.stringify(statement.Resource).includes('"*"'),
      'StartExecution must name the state machine',
    );
  }
});

test('the media table streams changes to a broadcaster', () => {
  const template = synth();
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
  });
  template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
});

test('the websocket connect route is authorised, disconnect is not', () => {
  const template = synth();
  const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route')).map((r) => r.Properties);
  const connect = routes.find((r) => r.RouteKey === '$connect');
  const disconnect = routes.find((r) => r.RouteKey === '$disconnect');
  assert.ok(connect, '$connect route exists');
  assert.equal(connect.AuthorizationType, 'CUSTOM');
  assert.ok(disconnect, '$disconnect route exists');
  template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
    AuthorizerType: 'REQUEST',
    IdentitySource: ['route.request.querystring.token'],
  });
});

test('the analysis pass runs between extraction and ready', () => {
  const states = stateMachineGraph(synth());
  assert.ok(states.MarkAnalysing, 'definition is missing MarkAnalysing');
  assert.ok(states.MarkIndexing, 'definition is missing MarkIndexing');

  // Analysis needs the frames extraction produced, so it has to be downstream
  // of Extract and upstream of indexing.
  const afterExtract = reachableFrom(states, 'Extract');
  assert.ok(afterExtract.has('MarkAnalysing'), 'analysis must follow extraction');
  assert.ok(afterExtract.has('MarkIndexing'), 'indexing must follow analysis');
  assert.ok(
    !reachableFrom(states, 'MarkIndexing').has('Extract'),
    'extraction must not run after indexing',
  );
});

test('a carousel skips download, extraction and transcription', () => {
  const states = stateMachineGraph(synth());
  const fromCarousel = reachableFrom(states, 'MarkAnalysingSlides');

  // Slides are already frames: there is nothing to fetch, no video to extract
  // from and no audio to transcribe.
  for (const skipped of ['Download', 'Extract', 'StartTranscribe']) {
    assert.ok(!fromCarousel.has(skipped), `a carousel must not reach ${skipped}`);
  }
  // It must still be analysed and indexed, or its slides are never searchable.
  assert.ok(fromCarousel.has('AnalyseCarousel'), 'a carousel must still be analysed');
  assert.ok(fromCarousel.has('MarkIndexing'), 'a carousel must still be indexed');

  // And the branch has to actually be wired to the entry choice.
  const choices = (states.NeedsDownload.Choices ?? []) as Array<{ Next?: string; Variable?: string }>;
  assert.ok(
    choices.some((choice) => choice.Next === 'MarkAnalysingSlides'),
    'nothing routes a carousel to the slide path',
  );
});

test('every choice tolerates an absent field', () => {
  const states = stateMachineGraph(synth());
  const choiceStates = Object.entries(states).filter(([, state]) => state.Type === 'Choice');
  assert.ok(choiceStates.length >= 2, 'expected the entry choice and the post-download choice');
  const choices = choiceStates.flatMap(([, state]) => (state.Choices ?? []) as Array<Record<string, unknown>>);

  // Step Functions does not treat a missing path as "condition false": it fails
  // the execution with States.Runtime. `kind` is absent on every upload and
  // `source` on anything that forgets it, so each comparison must be paired
  // with an IsPresent on the same variable. Getting this wrong broke every reel
  // while the carousel path the condition was added for kept working, which is
  // why it is asserted rather than left to review.
  const comparisons = (choice: Record<string, unknown>): Array<Record<string, unknown>> =>
    Array.isArray(choice.And) ? (choice.And as Array<Record<string, unknown>>) : [choice];

  for (const choice of choices) {
    const parts = comparisons(choice);
    const compared = parts.filter((part) => 'StringEquals' in part).map((part) => part.Variable);
    const guarded = parts.filter((part) => part.IsPresent === true).map((part) => part.Variable);
    for (const variable of compared) {
      assert.ok(
        guarded.includes(variable),
        `${variable} is compared without an IsPresent guard, so an input lacking it fails the execution`,
      );
    }
  }

  // And the guards must be on the paths that are actually optional.
  const allGuards = choices.flatMap((choice) =>
    comparisons(choice).filter((part) => part.IsPresent === true).map((part) => part.Variable),
  );
  assert.ok(allGuards.includes('$.kind'), '$.kind must be guarded: uploads do not set it');
});

test('a pasted link reaches either the reel path or the slide path', () => {
  const states = stateMachineGraph(synth());

  // Which one a permalink is cannot be known before the metadata pass, so the
  // branch has to sit after Download rather than at the entry choice.
  const afterDownload = reachableFrom(states, 'Download');
  assert.ok(afterDownload.has('Extract'), 'a downloaded reel must still reach extraction');
  assert.ok(
    afterDownload.has('AnalyseCarousel'),
    'a downloaded image post must reach the slide analysis, not extraction',
  );
  assert.ok(
    !reachableFrom(states, 'MarkAnalysingSlides').has('Extract'),
    'slides must not fall through into extraction: there is no video to extract',
  );
});

test('Bedrock access is invoke-only and limited to named models', () => {
  const template = synth();
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>,
  );
  const invokes = statements.filter((s) => [s.Action].flat().some((a) => String(a).startsWith('bedrock:')));
  // Bedrock is embeddings only: every text and vision call goes to the
  // Anthropic API. Exactly four callers still need Titan to turn something into
  // a vector — indexing, Ask, the plan worker and Lens find-similar.
  assert.equal(invokes.length, 4, 'only the embedding callers may still reach Bedrock');
  const embeddingOnly = invokes.every((statement) =>
    [statement.Resource].flat().every((arn) => String(arn).includes('titan')),
  );
  assert.ok(embeddingOnly, 'a generation model is still reachable on Bedrock');
  for (const statement of invokes) {
    assert.deepEqual(
      [statement.Action].flat(),
      ['bedrock:InvokeModel'],
      'invoke only, no training or model management',
    );
    const resources = JSON.stringify(statement.Resource);
    assert.ok(!resources.includes('"*"'), 'must not grant every model');
    assert.ok(
      /claude-sonnet-5|titan-embed/.test(resources),
      `unexpected model granted: ${resources}`,
    );
  }
});

test('the frame cap reaching the extractor is the one we configured', () => {
  const template = synth();
  const extract = Object.values(template.findResources('AWS::Lambda::Function')).find(
    (fn) => fn.Properties.PackageType === 'Image' && !fn.Properties.ImageConfig?.Command,
  );
  assert.equal(extract?.Properties.Environment.Variables.MAX_FRAMES, '20');
});

test('the vector index scales to zero rather than billing an idle floor', () => {
  const template = synth();
  // NEXTGEN is the whole point: a CLASSIC collection bills a 2-OCU minimum
  // (~$350/month) even when idle. NEXTGEN has no minimum and scales to zero.
  // It also rejects StandbyReplicas: DISABLED, so that is not the lever here.
  template.hasResourceProperties('AWS::OpenSearchServerless::CollectionGroup', {
    Generation: 'NEXTGEN',
  });
  template.hasResourceProperties('AWS::OpenSearchServerless::Collection', {
    Type: 'VECTORSEARCH',
  });
  const group = Object.values(template.findResources('AWS::OpenSearchServerless::CollectionGroup'))[0];
  assert.ok(group.Properties.CapacityLimits.MaxSearchCapacityInOcu <= 2, 'OCU ceiling must stay small');
});

test('the frames index is a knn index matching the embedding dimension', () => {
  const template = synth();
  const index = Object.values(template.findResources('AWS::OpenSearchServerless::Index'))[0];
  assert.equal(index.Properties.IndexName, 'frames');
  assert.equal(index.Properties.Settings.Index.Knn, true);
  const embedding = index.Properties.Mappings.Properties.embedding;
  assert.equal(embedding.Type, 'knn_vector');
  assert.equal(embedding.Dimension, 1024, 'must match Titan Multimodal output length');
  // ocr_text must be a searchable text field: exact signage matching depends on it.
  assert.equal(index.Properties.Mappings.Properties.ocr_text.Type, 'text');
});

test('indexing writes and Ask only reads', () => {
  const template = synth();
  const policy = Object.values(template.findResources('AWS::OpenSearchServerless::AccessPolicy'))[0];
  // Role ARNs are tokens, so the document renders as an Fn::Join rather than
  // a plain string: flatten the literal parts and assert on those.
  const flattened = JSON.stringify(policy.Properties.Policy);

  const writeGrants = flattened.split('aoss:WriteDocument').length - 1;
  assert.equal(writeGrants, 1, 'exactly one stanza may grant writes');
  assert.ok(
    flattened.includes('aoss:DescribeIndex\\",\\"aoss:ReadDocument\\"]'),
    'the reader stanza must be read-only',
  );
  assert.ok(flattened.includes('IndexFrames'), 'the index stage must be the writer');
  assert.ok(flattened.includes('Ask'), 'Ask must be granted read access');
});

test('the index stage runs after analysis and before ready', () => {
  const template = synth();
  const machine = Object.values(template.findResources('AWS::StepFunctions::StateMachine'))[0];
  const definition = JSON.stringify(machine.Properties.DefinitionString);
  assert.ok(definition.includes('MarkIndexing'), 'definition is missing MarkIndexing');
  assert.ok(
    definition.indexOf('Analyse') < definition.indexOf('MarkIndexing'),
    'indexing must follow analysis so descriptions are embedded',
  );
});

test('Lens query uploads are separate from media and expire', () => {
  const template = synth();
  // A query screenshot must not be able to land in the media prefix.
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
    (policy) => policy.Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>,
  );
  const lensPuts = statements.filter(
    (s) => [s.Action].flat().includes('s3:PutObject') && JSON.stringify(s.Resource).includes('lens/*'),
  );
  assert.equal(lensPuts.length, 1, 'exactly one role may write lens uploads');
  assert.ok(
    !JSON.stringify(lensPuts[0].Resource).includes('media/*'),
    'the lens upload role must not be able to write into media/',
  );

  template.hasResourceProperties('AWS::S3::Bucket', {
    LifecycleConfiguration: {
      Rules: Match.arrayWith([
        Match.objectLike({ Id: 'lens-queries', Prefix: 'lens/', ExpirationInDays: 1 }),
      ]),
    },
  });
});

test('every secret lives in Secrets Manager, with no value in the template', () => {
  const template = synth();
  // Brave's search key, Instagram's app secret, and the Claude API key.
  template.resourceCountIs('AWS::SecretsManager::Secret', 3);
  for (const secret of Object.values(template.findResources('AWS::SecretsManager::Secret'))) {
    // CDK generates a placeholder; the real value is put in out of band.
    assert.ok(!('SecretString' in secret.Properties), 'a secret value must never be in the template');
  }
});

test('no handler takes the search key through its environment', () => {
  const template = synth();
  for (const [name, fn] of Object.entries(template.findResources('AWS::Lambda::Function'))) {
    const env = fn.Properties.Environment?.Variables ?? {};
    for (const [key, value] of Object.entries(env)) {
      const rendered = JSON.stringify(value);
      assert.ok(
        !/BRAVE|SEARCH_API_KEY|SUBSCRIPTION_TOKEN/i.test(key),
        `${name} carries what looks like a key in ${key}`,
      );
      // The ARN is fine; the value must not be resolved into the env.
      if (key === 'SEARCH_SECRET_ARN') {
        assert.ok(rendered.includes('Ref') || rendered.includes('secret'), `${name} SEARCH_SECRET_ARN looks wrong`);
      }
    }
  }
});

test('the site bucket is private and only reachable through CloudFront', () => {
  const template = synth();
  template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  const buckets = Object.values(template.findResources('AWS::S3::Bucket'));
  for (const bucket of buckets) {
    assert.deepEqual(
      bucket.Properties.PublicAccessBlockConfiguration,
      {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      'no bucket may be public, including the site bucket',
    );
  }
  // Origin Access Control, not a public bucket or a legacy OAI.
  template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0];
  const config = distribution.Properties.DistributionConfig;
  assert.equal(config.DefaultCacheBehavior.ViewerProtocolPolicy, 'redirect-to-https');
  assert.equal(config.DefaultRootObject, 'index.html');
});

test('sign-in and the API both accept the CloudFront origin', () => {
  const template = synth();
  const client = Object.values(template.findResources('AWS::Cognito::UserPoolClient'))[0];
  const callbacks = JSON.stringify(client.Properties.CallbackURLs);
  // The distribution domain is a token, so it renders as a Join/GetAtt.
  assert.ok(
    callbacks.includes('DomainName') || callbacks.includes('Fn::Join'),
    'the CloudFront domain must be a Hosted UI callback, or sign-in breaks on the deployed site',
  );

  const api = Object.values(template.findResources('AWS::ApiGatewayV2::Api'))[0];
  const cors = JSON.stringify(api.Properties.CorsConfiguration ?? {});
  assert.ok(
    cors.includes('DomainName') || cors.includes('Fn::Join'),
    'the API must allow the CloudFront origin, or every request from the deployed site is blocked',
  );
});

test('directory paths are rewritten to index.html, or every page but / 404s', () => {
  const template = synth();
  template.resourceCountIs('AWS::CloudFront::Function', 1);
  const fn = Object.values(template.findResources('AWS::CloudFront::Function'))[0];
  const code = fn.Properties.FunctionCode as string;
  assert.match(code, /index\.html/, 'the function must rewrite to index.html');

  const distribution = Object.values(template.findResources('AWS::CloudFront::Distribution'))[0];
  const associations = distribution.Properties.DistributionConfig.DefaultCacheBehavior.FunctionAssociations;
  assert.equal(associations.length, 1, 'the rewrite must actually be attached to the behaviour');
  assert.equal(associations[0].EventType, 'viewer-request');
});

test('the Instagram token is held under a customer-managed key', () => {
  const template = synth();
  // Not the AWS-owned default: this table holds a credential for someone's
  // Instagram account.
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
  });
  const keys = Object.values(template.findResources('AWS::KMS::Key'));
  assert.equal(keys.length, 1, 'one customer-managed key');
  assert.equal(keys[0].Properties.EnableKeyRotation, true);
});

test('the Claude API key has the name it is set by', () => {
  const template = synth();
  const named = Object.values(template.findResources('AWS::SecretsManager::Secret')).filter(
    (secret) => secret.Properties.Name === 'instarag-claude-key',
  );
  // Set out of band by `put-secret-value --secret-id instarag-claude-key`, so a
  // generated name would break the one documented way to populate it.
  assert.equal(named.length, 1, 'the Claude key must keep its fixed name');
  assert.ok(!('SecretString' in named[0].Properties));
});

test('the Instagram app secret is in Secrets Manager with no value in the template', () => {
  const template = synth();
  const secrets = Object.values(template.findResources('AWS::SecretsManager::Secret'));
  // Brave's key, Instagram's, and Claude's.
  assert.equal(secrets.length, 3);
  for (const secret of secrets) {
    assert.ok(!('SecretString' in secret.Properties), 'no secret value may appear in the template');
  }
});

test('the token is refreshed on a schedule, because a lapse needs manual re-auth', () => {
  const template = synth();
  template.resourceCountIs('AWS::Events::Rule', 1);
  const rule = Object.values(template.findResources('AWS::Events::Rule'))[0];
  assert.equal(rule.Properties.ScheduleExpression, 'rate(1 day)');
  assert.equal(rule.Properties.State, 'ENABLED');
});

test('connected mode cannot reach other accounts: only own-media scope is requested', () => {
  // The scope is asserted in instagram.test.ts; here we check no handler is
  // handed an Instagram password or cookie by configuration.
  const template = synth();
  for (const [name, fn] of Object.entries(template.findResources('AWS::Lambda::Function'))) {
    if (name.startsWith('Custom')) continue;
    for (const key of Object.keys(fn.Properties.Environment?.Variables ?? {})) {
      assert.ok(
        !/COOKIE|IG_PASSWORD|IG_USERNAME|SESSION_ID/i.test(key),
        `${name} carries what looks like an Instagram credential in ${key}`,
      );
    }
  }
});

test('a re-pasted reel is deduplicated by its key, for everyone', () => {
  const template = synth();
  const media = Object.values(template.findResources('AWS::DynamoDB::Table')).find((t) =>
    JSON.stringify(t.Properties.KeySchema) === JSON.stringify([{ AttributeName: 'id', KeyType: 'HASH' }]),
  );

  /*
   * This used to assert a byPermalink GSI. The intent is unchanged — a re-paste
   * must not cost another anonymous download — but the mechanism is better: the
   * Instagram shortcode *is* the media id, so the check is a GetItem and no
   * index is needed. It is also now global rather than per-library: if anyone
   * has ingested the reel, nobody downloads it again.
   */
  assert.ok(media, 'no content table');
  assert.ok(
    !media!.Properties.GlobalSecondaryIndexes,
    'content needs no secondary index: the shortcode is the key, and recency lives on saves',
  );

  const ingest = readFileSync(
    path.join(__dirname, '..', 'lambda/media/create-from-url.ts'),
    'utf8',
  );
  assert.match(ingest, /const mediaId = parsed\.shortcode/, 'the shortcode must be the id');
  assert.match(
    ingest,
    /existing\.status !== 'failed'[\s\S]{0,200}saveMedia/,
    'content anyone already holds must be saved, not re-fetched',
  );
});

test('retry can clear a half-finished run and start the pipeline again', () => {
  const template = synth();
  const routes = Object.values(template.findResources('AWS::ApiGatewayV2::Route')).map(
    (r) => r.Properties.RouteKey,
  );
  assert.ok(
    routes.includes('POST /media/{id}/retry'),
    'a failed reel needs a way back through the pipeline',
  );

  // It must be able to remove index documents, or a retried reel would end up
  // cited twice: once from the old run and once from the new.
  const policy = Object.values(template.findResources('AWS::OpenSearchServerless::AccessPolicy'))[0];
  const flattened = JSON.stringify(policy.Properties.Policy);
  assert.ok(flattened.includes('RetryMedia'), 'retry needs write access to clear stale documents');
});

test('every handler that purges the index has the collection endpoint', () => {
  const template = synth();
  // Retry and delete both clear stale documents. A handler granted
  // aoss:APIAccessAll but given no SEARCH_ENDPOINT fails at runtime with
  // "Missing node(s) option" — which is how this was found.
  const functions = Object.entries(template.findResources('AWS::Lambda::Function'));
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));

  const rolesWithAoss = new Set(
    policies
      .filter((policy) =>
        (policy.Properties.PolicyDocument.Statement as Array<{ Action: string | string[] }>).some((s) =>
          [s.Action].flat().includes('aoss:APIAccessAll'),
        ),
      )
      .flatMap((policy) => (policy.Properties.Roles ?? []).map((r: unknown) => JSON.stringify(r))),
  );

  for (const [name, fn] of functions) {
    const role = JSON.stringify(fn.Properties.Role);
    const roleRef = role.replace(/\{"Fn::GetAtt":\["(.+?)","Arn"\]\}/, '{"Ref":"$1"}');
    if (!rolesWithAoss.has(roleRef)) continue;
    assert.ok(
      fn.Properties.Environment?.Variables?.SEARCH_ENDPOINT,
      `${name} can call the index but has no SEARCH_ENDPOINT`,
    );
  }
});

/**
 * The ephemeral ones: live WebSocket connection ids, swept by TTL. Nothing here
 * outlives a page refresh, so there is nothing to recover.
 */
const EPHEMERAL_TABLES = ['StorageConnectionsTable'];

test('every table holding anything worth keeping has PITR and is retained', () => {
  const template = synth();
  const tables = Object.entries(template.findResources('AWS::DynamoDB::Table')).filter(
    ([logicalId]) => !EPHEMERAL_TABLES.some((name) => logicalId.startsWith(name)),
  );

  // Ten: media, caption facts, transcript segments, threads, messages, frames,
  // jobs, the Instagram token table, saves, and usage. An eleventh appearing
  // here without PITR is the case this test exists for.
  //
  // `usage` earns it for the same reason as saves: it is the basis of a quota
  // and of any bill, and it cannot be reconstructed after the fact — the
  // CloudWatch metrics beside it are aggregates with a retention window, not a
  // per-person record.
  //
  // `saves` earns it more than any of the others: content can be re-fetched and
  // re-analysed, but nothing anywhere else records that a person's library was
  // theirs. Losing it loses every library while leaving every reel intact.
  assert.equal(tables.length, 10, 'a table was added or removed; decide whether it needs PITR');

  for (const [logicalId, table] of tables) {
    assert.equal(
      table.Properties.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled,
      true,
      `${logicalId} has no point-in-time recovery: a bad write or a stray purge would be final`,
    );
    // RETAIN and PITR answer different questions, so both are asserted.
    assert.equal(table.DeletionPolicy, 'Retain', `${logicalId} would be deleted with the stack`);
    assert.equal(table.UpdateReplacePolicy, 'Retain', `${logicalId} would be dropped on replacement`);
  }
});

test('the media bucket keeps versions, and sweeps the ones it no longer needs', () => {
  const template = synth();
  const [bucket] = Object.values(template.findResources('AWS::S3::Bucket')).filter(
    (b) => b.Properties.VersioningConfiguration,
  );
  assert.ok(bucket, 'no bucket is versioned: an overwritten upload has no other copy');
  assert.equal(bucket.Properties.VersioningConfiguration.Status, 'Enabled');
  assert.equal(bucket.DeletionPolicy, 'Retain');

  const rules = bucket.Properties.LifecycleConfiguration.Rules as Array<Record<string, unknown>>;
  // Versioning without these grows forever: every delete leaves the old version
  // and a marker behind.
  assert.ok(
    rules.some((rule) => (rule.NoncurrentVersionExpiration as { NoncurrentDays?: number })?.NoncurrentDays),
    'old versions are never expired',
  );
  assert.ok(rules.some((rule) => rule.ExpiredObjectDeleteMarker === true), 'delete markers accumulate');
});

test('the token key is retained, because destroying it destroys the token', () => {
  const template = synth();
  const keys = Object.values(template.findResources('AWS::KMS::Key'));
  assert.equal(keys.length, 1);
  assert.equal(keys[0].DeletionPolicy, 'Retain');
});

test('retainData=false still gives a throwaway stack', () => {
  // The escape hatch has to keep working: a scratch stack should take its data
  // with it rather than leaving tables behind to bill for.
  const template = synth({ retainData: false });
  for (const [, table] of Object.entries(template.findResources('AWS::DynamoDB::Table'))) {
    assert.equal(table.DeletionPolicy, 'Delete');
    assert.notEqual(table.Properties.PointInTimeRecoverySpecification?.PointInTimeRecoveryEnabled, true);
  }
  const buckets = Object.values(template.findResources('AWS::S3::Bucket'));
  assert.ok(!buckets.some((b) => b.Properties.VersioningConfiguration), 'no versioning without retainData');
});

test('every alarm notifies, and the pipeline ones exist', () => {
  const template = synth();
  const alarms = Object.entries(template.findResources('AWS::CloudWatch::Alarm'));
  assert.ok(alarms.length >= 7, `expected the pipeline, Bedrock, OCU and spend alarms, found ${alarms.length}`);

  for (const [logicalId, alarm] of alarms) {
    // An alarm with no action is decoration: it goes red where nobody looks.
    assert.ok(
      (alarm.Properties.AlarmActions ?? []).length > 0,
      `${logicalId} has no action, so nothing is told when it fires`,
    );
    assert.ok(alarm.Properties.AlarmDescription, `${logicalId} has no description`);
  }

  // The two silent failures that motivated this: an execution that fails, and a
  // pipeline handler that throws where no user is waiting on a response.
  const metrics = alarms.map(([, a]) => a.Properties.MetricName ?? 'expression');
  assert.ok(metrics.includes('ExecutionsFailed'), 'nothing watches for a failed ingest');
  assert.ok(
    alarms.some(([, a]) => (a.Properties.Metrics ?? []).length >= 5),
    'no summed alarm over the pipeline handlers',
  );
});

test('the OCU alarm is not pinned to a collection group id', () => {
  const template = synth();
  const [ocu] = Object.values(template.findResources('AWS::CloudWatch::Alarm')).filter((alarm) =>
    JSON.stringify(alarm.Properties).includes('SearchOCU'),
  );
  assert.ok(ocu, 'nothing watches whether the index scales back down');

  // OCU is reported per CollectionGroupId, and redeploys create new ones. An
  // alarm naming one would stop matching without ever going red.
  const body = JSON.stringify(ocu.Properties);
  assert.ok(!body.includes('CollectionGroupId'), 'the OCU alarm is pinned to a group id');
  assert.match(body, /SELECT .*SearchOCU.*FROM/, 'expected a Metrics Insights query');
});

test('no email address is baked into the template', () => {
  // The alarm address is context-only: a real address in the repo is both a
  // privacy leak and wrong for anyone else deploying this.
  const template = synth();
  const subscriptions = template.findResources('AWS::SNS::Subscription');
  assert.equal(Object.keys(subscriptions).length, 0);
  // Email-shaped, not merely containing '@': the WebSocket management ARN has
  // an @connections path in it, which is not an address.
  const emailShaped = /[\w.+-]+@[\w-]+\.[\w.]{2,}/;
  assert.ok(
    !emailShaped.test(JSON.stringify(template.toJSON())),
    'an address reached the template',
  );
});

test('the library grid is served a thumbnail, not the analysis frame', () => {
  const template = synth();
  const images = Object.values(template.findResources('AWS::Lambda::Function')).filter(
    (fn) => fn.Properties.PackageType === 'Image',
  );
  // Extraction, download, and the thumbnail backfill, all from one image.
  assert.equal(images.length, 3);

  const thumbnailer = images.find((fn) => JSON.stringify(fn.Properties.ImageConfig ?? {}).includes('thumbnail'));
  assert.ok(thumbnailer, 'no handler can write a thumbnail');
  // It only moves one small image between S3 and DynamoDB; it needs neither the
  // memory extraction runs at nor its five minutes.
  assert.ok(thumbnailer.Properties.Timeout <= 120);
});

test('the spend alarm watches the models, not just what is left on Bedrock', () => {
  const template = synth();
  const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));

  // Generation runs on the Anthropic API, so AWS/Bedrock sees embeddings only
  // and AWS/Billing never sees those charges at all. An alarm on either would
  // be watching a quiet corner while the models ran away.
  const onModelTokens = alarms.filter(
    (a) => a.Properties.Namespace === 'ReelLens' && a.Properties.MetricName === 'TokensIn',
  );
  assert.equal(onModelTokens.length, 1, 'nothing watches what the models actually spend');
  assert.ok((onModelTokens[0].Properties.AlarmActions ?? []).length > 0);

  // One metric, undimensioned, on purpose: each dimension combination is a
  // separate custom metric at $0.30/month against a stack that idles at ~$2.
  assert.ok(!onModelTokens[0].Properties.Dimensions?.length, 'the spend metric must stay undimensioned');
});
