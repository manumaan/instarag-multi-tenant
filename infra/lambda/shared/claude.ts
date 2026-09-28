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
