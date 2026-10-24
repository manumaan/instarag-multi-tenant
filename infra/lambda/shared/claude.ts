import Anthropic from '@anthropic-ai/sdk';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const secrets = new SecretsManagerClient({});
const KEY_SECRET_ARN = process.env.CLAUDE_KEY_SECRET_ARN!;
const OPENROUTER_KEY_SECRET_ARN = process.env.OPENROUTER_KEY_SECRET_ARN;

/** OpenRouter's Anthropic Messages-compatible endpoint (the SDK appends /v1/messages). */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

/**
 * Which service a model id is served by.
 *
 * Generation started on Bedrock, moved to the Anthropic API (this account is
 * still not entitled to the current models on Bedrock: a 1-token invoke of
 * Sonnet 5 and Opus 5 answers AccessDeniedException), and can now go through
 * OpenRouter, which reaches the same Claude models and others — OpenAI's
 * Luna — under one key.
 *
 * The id decides: OpenRouter ids carry a vendor prefix (`anthropic/claude-opus-5`,
 * `openai/gpt-6-luna`), the Anthropic API's do not (`claude-opus-5`). So a
 * deploy switches provider by switching model ids, and both can run side by
 * side — which is how models are compared before one is chosen.
 *
 * OpenRouter is reached through the same Anthropic SDK: it serves an
 * Anthropic Messages-compatible endpoint that accepts `thinking`,
 * `output_config` (effort, JSON-schema format) and base64 images for any model
 * it routes, per its docs (api-reference/anthropic-messages). Its key goes in
 * as a bearer token (`authToken`) with no `x-api-key`, as its Anthropic SDK
 * guide specifies. So every call site stays as written.
 *
 * Embeddings do not move: Titan Multimodal is a Bedrock model, and `embed.ts`
 * keeps its Bedrock client.
 */
export const viaOpenRouter = (model: string) => model.includes('/');

/*
 * One client per provider per container, and the promise is cached, not the
 * value: two concurrent invocations of a cold handler would otherwise each
 * fetch the secret. A failed fetch is evicted rather than cached, or the
 * container would serve the same error until it is recycled.
 */
const clients = new Map<'anthropic' | 'openrouter', Promise<Anthropic>>();

async function readKey(secretArn: string | undefined, name: string): Promise<string> {
  if (!secretArn) throw new Error(`${name} is not configured for this function`);
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  const key = secret.SecretString?.trim();
  if (!key) {
    throw new Error(
      `the ${name} secret is empty — set it with: aws secretsmanager put-secret-value ` +
        `--secret-id ${secretArn.split(':').pop()?.replace(/-[A-Za-z0-9]{6}$/, '')} --secret-string <key>`,
    );
  }
  return key;
}

/** The client that serves this model id. */
export function clientFor(model: string): Promise<Anthropic> {
  const provider = viaOpenRouter(model) ? 'openrouter' : 'anthropic';
  let client = clients.get(provider);
  if (!client) {
    client =
      provider === 'openrouter'
        ? readKey(OPENROUTER_KEY_SECRET_ARN, 'OpenRouter API key').then(
            (authToken) =>
              new Anthropic({
                baseURL: OPENROUTER_BASE_URL,
                authToken,
                apiKey: null,
                // Optional attribution headers OpenRouter shows on its dashboard.
                defaultHeaders: { 'X-Title': 'Reel Lens' },
              }),
          )
        : readKey(KEY_SECRET_ARN, 'Claude API key').then((apiKey) => new Anthropic({ apiKey }));
    clients.set(provider, client);
  }
  return client.catch((err) => {
    clients.delete(provider);
    throw err;
  });
}

/** The Anthropic API client. Prefer clientFor(model), which also covers OpenRouter. */
export function claude(): Promise<Anthropic> {
  return clientFor('claude');
}

/** Status codes that say "not now" rather than "not this request". */
const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/**
 * Renames a failure the API will probably not repeat to `ModelUnavailable`,
 * the name the pipeline retries with backoff; anything else passes through.
 *
 * The SDK already retries twice within a second or two, which a real incident
 * outlasts: on 2026-09-29 an Anthropic incident answered every real key with
 * "503 credential validation failed" for well over ten minutes, and a reel
 * that hit it failed outright. Its error surfaced as a bare `Error`, and
 * retrying on that name would also re-run permanent failures — a refusal, an
 * unparsable answer — each one another full vision pass. So only this name is
 * retried, and only for this.
 */
export function classifyModelError(err: unknown): unknown {
  const transient =
    err instanceof Anthropic.APIConnectionError ||
    (err instanceof Anthropic.APIError && err.status !== undefined && TRANSIENT_STATUS.has(err.status));
  if (!transient) return err;
  const renamed = new Error((err as Error).message);
  renamed.name = 'ModelUnavailable';
  return renamed;
}
