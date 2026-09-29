#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { ReelLensStack } from '../lib/reel-lens-stack';

const app = new App();

/** Origins allowed to call the API and hold Hosted UI redirects. Override with -c webOrigins=... */
const webOrigins = (app.node.tryGetContext('webOrigins') ?? 'http://localhost:3000')
  .split(',')
  .map((o: string) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

/**
 * Data survives `cdk destroy`, and gets PITR and S3 versioning, when true.
 *
 * Defaults to **on**, and off has to be asked for: the default was false while
 * this was a skeleton, and it stayed false once the library held reels that
 * exist nowhere else. A throwaway stack is the unusual case now, so it is the
 * one that names itself — `-c retainData=false`.
 */
const retainData = app.node.tryGetContext('retainData') !== 'false';

const retentionDaysRaw = app.node.tryGetContext('retentionDays');
const retentionDays = retentionDaysRaw ? Number(retentionDaysRaw) : undefined;

/**
 * Vision model for the analysis pass, on the **Anthropic API** rather than
 * Bedrock: this account is still not entitled to Sonnet 5 or Opus 5 there — a
 * 1-token invoke of either answers AccessDeniedException — while both are
 * available directly. Opus 5 here because this pass reads signage and writes
 * places evidence into the index permanently, so a misread is not recoverable.
 */
const analysisModel = app.node.tryGetContext('analysisModel') ?? 'claude-opus-5';

/** Ask, plans and Lens. Sonnet 5 is faster than Opus and cheaper per token. */
const answerModel = app.node.tryGetContext('answerModel') ?? 'claude-sonnet-5';

/**
 * The cheap pass in front of a plan: one request becomes several searches.
 * Haiku 4.5, per the architecture table's split between vision/Q&A and
 * classification.
 */
const expansionModel = app.node.tryGetContext('expansionModel') ?? 'claude-haiku-4-5';

/** Keyframe cap. The main cost lever: every frame is an image in the reel's one call. */
const maxFrames = Number(app.node.tryGetContext('maxFrames') ?? 20);

/** Titan Multimodal Embeddings: one vector covers a frame's image and its text. */
const embeddingModel = app.node.tryGetContext('embeddingModel') ?? 'amazon.titan-embed-image-v1';

/**
 * OCU ceiling for the vector index. The collection is NEXTGEN and scales to
 * zero, so this caps the worst case rather than setting a floor.
 */
const maxOcu = Number(app.node.tryGetContext('maxOcu') ?? 2);

/**
 * Instagram app id for connected mode, from the Meta App Dashboard. Not a
 * secret — the app *secret* goes into Secrets Manager. Empty until the Meta
 * app exists, which leaves the connect endpoints reporting "not configured".
 */
const instagramAppId = app.node.tryGetContext('instagramAppId') ?? '';

/**
 * Where alarms are emailed. Deliberately not defaulted: an address baked into
 * the repo is both a privacy leak and wrong for anyone else deploying this.
 * Without it the topic still exists, so subscribing later is one CLI call.
 */
const alarmEmail = app.node.tryGetContext('alarmEmail') || undefined;

/** Monthly spend that should raise an alarm. Idle is about $2. */
const monthlyBudget = Number(app.node.tryGetContext('monthlyBudget') ?? 20);

/**
 * Bedrock input tokens in one hour that would mean something is looping. A reel
 * is roughly 10k, so this is about fifty reels an hour — far above real use,
 * far below a runaway.
 */
const hourlyTokenBudget = Number(app.node.tryGetContext('hourlyTokenBudget') ?? 500_000);

/**
 * The stack's own name, and **not** `ReelLens`.
 *
 * This repo deploys beside the single-user MVP, which owns that name in account
 * 250037328911: deploying as `ReelLens` would not create a second stack, it
 * would update the live one and take its tables with it. Override with
 * `-c stackName=` when deploying somewhere the collision cannot happen.
 */
const stackName = app.node.tryGetContext('stackName') ?? 'ReelLensMultiTenant';

/**
 * Anthropic API key, set by hand after the first deploy:
 *   aws secretsmanager put-secret-value --secret-id <name> --secret-string <key>
 * A name rather than a generated id because a person types it. Distinct from
 * the MVP's `instarag-claude-key`, which a same-account deploy would collide
 * with, and which would also merge the two deployments' spend.
 */
const claudeSecretName = app.node.tryGetContext('claudeSecretName') ?? 'instarag-claude-key-mt';

new ReelLensStack(app, stackName, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  webOrigins,
  retainData,
  retentionDays,
  analysisModel,
  answerModel,
  expansionModel,
  maxFrames,
  embeddingModel,
  maxOcu,
  instagramAppId,
  alarmEmail,
  monthlyBudget,
  hourlyTokenBudget,
  claudeSecretName,
  description: 'Reel Lens - Instagram reel/post analysis',
});
