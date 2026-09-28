import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/ddb';

const secrets = new SecretsManagerClient({});

export const CONNECTIONS_TABLE = process.env.IG_CONNECTION_TABLE!;

/*
 * PK user_id, SK kind. One row per person's Instagram connection
 * (`kind: 'connection'`), plus the short-lived OAuth state rows
 * (`kind: 'state#<state>'`) belonging to whoever began that flow.
 *
 * Putting the user in the *key* rather than in a field is what makes a state
 * impossible to consume across accounts: `consumeState` looks it up under the
 * caller's own partition, so a state started by one person simply is not there
 * for another. That is stronger than checking a user_id field and remembering
 * to keep the check.
 */
export const CONNECTION_KIND = 'connection';
const stateKind = (state: string) => `state#${state}`;

export interface Connection {
  user_id: string;
  kind: string;
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

export async function readConnection(userId: string): Promise<Connection | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: CONNECTIONS_TABLE,
      Key: { user_id: userId, kind: CONNECTION_KIND },
    }),
  );
  return result.Item as Connection | undefined;
}

export async function writeConnection(connection: Connection): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: { ...connection, kind: CONNECTION_KIND },
    }),
  );
}

export async function clearConnection(userId: string): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName: CONNECTIONS_TABLE,
      Key: { user_id: userId, kind: CONNECTION_KIND },
    }),
  );
}

/**
 * Every connected account, for the scheduled refresh — which has no caller of
 * its own and must renew on everyone's behalf.
 *
 * A Scan with a filter rather than an index: one row per connected person, swept
 * once a day, and a GSI existing only for that would be infrastructure for its
 * own sake.
 */
export async function allConnections(): Promise<Connection[]> {
  const rows: Connection[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: CONNECTIONS_TABLE,
        FilterExpression: '#kind = :kind',
        ExpressionAttributeNames: { '#kind': 'kind' },
        ExpressionAttributeValues: { ':kind': CONNECTION_KIND },
        ExclusiveStartKey: cursor,
      }),
    );
    rows.push(...((page.Items ?? []) as Connection[]));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return rows;
}

/** Single-use, short-lived CSRF state, in the starting user's own partition. */
export async function putState(userId: string, state: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        user_id: userId,
        kind: stateKind(state),
        created_at: new Date().toISOString(),
        // Ten minutes is ample for a consent screen, and the row is deleted on use.
        expires_at_epoch: Math.floor(Date.now() / 1000) + 600,
      },
    }),
  );
}

/**
 * Consumes the state. A replayed callback finds nothing and is rejected, and so
 * does a callback presented by anyone but the person who started the flow —
 * their partition simply has no such row.
 */
export async function consumeState(userId: string, state: string): Promise<boolean> {
  const key = { user_id: userId, kind: stateKind(state) };
  const found = await ddb.send(new GetCommand({ TableName: CONNECTIONS_TABLE, Key: key }));
  if (!found.Item) return false;
  await ddb.send(new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: key }));
  const expires = Number(found.Item.expires_at_epoch ?? 0);
  return expires === 0 || expires > Math.floor(Date.now() / 1000);
}
