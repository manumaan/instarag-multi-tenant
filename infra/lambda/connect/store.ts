import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/ddb';

const secrets = new SecretsManagerClient({});

export const CONNECTIONS_TABLE = process.env.IG_CONNECTION_TABLE!;
/** Single-user app: one connection row, keyed by a constant. */
export const CONNECTION_ID = 'instagram';

export interface Connection {
  id: string;
  ig_user_id: string;
  username?: string;
  access_token: string;
  obtained_at: string;
  expires_at: string;
  scopes: string;
  last_sync_at?: string;
}

let cachedSecret: { value: string; at: number } | undefined;
const SECRET_TTL_MS = 5 * 60 * 1000;

/**
 * The app secret never appears in code, env vars or the template. Empty is
 * never cached, so setting it does not require a redeploy.
 */
export async function loadAppSecret(): Promise<string> {
  if (cachedSecret && Date.now() - cachedSecret.at < SECRET_TTL_MS) return cachedSecret.value;

  let value = '';
  try {
    const secret = await secrets.send(
      new GetSecretValueCommand({ SecretId: process.env.IG_APP_SECRET_ARN! }),
    );
    const raw = (secret.SecretString ?? '').trim();
    value = raw.startsWith('{') ? String(JSON.parse(raw).appSecret ?? '') : raw;
  } catch (err) {
    console.warn('could not read the Instagram app secret', {
      err: err instanceof Error ? err.message : err,
    });
  }
  if (value) cachedSecret = { value, at: Date.now() };
  return value;
}

export async function readConnection(): Promise<Connection | undefined> {
  const result = await ddb.send(
    new GetCommand({ TableName: CONNECTIONS_TABLE, Key: { id: CONNECTION_ID } }),
  );
  return result.Item as Connection | undefined;
}

export async function writeConnection(connection: Connection): Promise<void> {
  await ddb.send(new PutCommand({ TableName: CONNECTIONS_TABLE, Item: connection }));
}

export async function clearConnection(): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: { id: CONNECTION_ID } }));
}

/** Single-use, short-lived CSRF state for the OAuth round trip. */
export async function putState(state: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        id: `state#${state}`,
        created_at: new Date().toISOString(),
        // Ten minutes is ample for a consent screen, and the row is deleted on use.
        expires_at_epoch: Math.floor(Date.now() / 1000) + 600,
      },
    }),
  );
}

/** Consumes the state: a replayed callback finds nothing and is rejected. */
export async function consumeState(state: string): Promise<boolean> {
  const key = `state#${state}`;
  const found = await ddb.send(new GetCommand({ TableName: CONNECTIONS_TABLE, Key: { id: key } }));
  if (!found.Item) return false;
  await ddb.send(new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: { id: key } }));
  const expires = Number(found.Item.expires_at_epoch ?? 0);
  return expires === 0 || expires > Math.floor(Date.now() / 1000);
}
