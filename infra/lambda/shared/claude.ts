import Anthropic from '@anthropic-ai/sdk';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const secrets = new SecretsManagerClient({});
const KEY_SECRET_ARN = process.env.CLAUDE_KEY_SECRET_ARN!;

/**
 * The Anthropic API rather than Bedrock, because this account is not entitled
 * to the current models there: a 1-token invoke of Sonnet 5 and Opus 5 on
 * Bedrock still answers AccessDeniedException, while the same models are
 * available directly.
 *
 * Embeddings do not move — Titan Multimodal is a Bedrock model and the
 * Anthropic API has no embeddings endpoint — so `embed.ts` keeps its Bedrock
 * client and this stack now talks to both.
 *
 * The client is built once per container and the promise is cached, not the
 * value: two concurrent invocations of a cold handler would otherwise each
 * fetch the secret.
 */
let clientPromise: Promise<Anthropic> | undefined;

export function claude(): Promise<Anthropic> {
  clientPromise ??= (async () => {
    const secret = await secrets.send(new GetSecretValueCommand({ SecretId: KEY_SECRET_ARN }));
    const apiKey = secret.SecretString?.trim();
    if (!apiKey) {
      throw new Error(
        'the Claude API key secret is empty — set it with: aws secretsmanager put-secret-value ' +
          '--secret-id instarag-claude-key --secret-string <key>',
      );
    }
    return new Anthropic({ apiKey });
  })();

  // A failed fetch must not be cached, or the container serves the same error
  // until it is recycled.
  return clientPromise.catch((err) => {
    clientPromise = undefined;
    throw err;
  });
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
