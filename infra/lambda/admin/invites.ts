import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { DeleteCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLES } from '../shared/ddb';
import { HttpError, badRequest, callerId, handler, isAdmin, pathParam, parseJsonBody } from '../shared/http';

const cognito = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID!;

/** Invites expire so a forgotten one cannot be accepted a year later. */
const INVITE_TTL_DAYS = 14;

/**
 * Signup is closed, so an account exists only because someone with the admin
 * group created it. That makes this the whole front door, and the reason every
 * handler here re-checks the claim server-side: a client that hides the screen
 * is a convenience, not a control.
 */
function requireAdmin(event: Parameters<typeof callerId>[0]): string {
  if (!isAdmin(event)) {
    // Not found rather than forbidden: an admin surface should not confirm it
    // exists to someone who may not use it.
    throw new HttpError(404, 'not found');
  }
  return callerId(event);
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

/** POST /admin/invites — create the account and let Cognito send the email. */
export const create = handler(async (event) => {
  const invitedBy = requireAdmin(event);
  const { email, name } = parseJsonBody<{ email?: string; name?: string }>(event);
  const address = email?.trim().toLowerCase();
  if (!address || !EMAIL.test(address)) throw badRequest('a valid email address is required');
  // Optional: it is only the greeting in the invite email. Cognito caps a
  // standard attribute at 2048 characters; a name needs nowhere near that.
  const displayName = name?.trim().slice(0, 100) || undefined;

  /*
   * Cognito is the source of truth for whether an account exists, so it is
   * created first. The invite row is a record of who invited whom and when —
   * useful, but not the thing that grants access.
   */
  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: address,
        UserAttributes: [
          { Name: 'email', Value: address },
          // Pre-verified: the invite email proves the address, and leaving it
          // unverified would block the password reset flow they may need.
          { Name: 'email_verified', Value: 'true' },
          // A standard attribute, so it needs no schema change on the pool.
          // The invite-message trigger reads it to greet them by name.
          ...(displayName ? [{ Name: 'name', Value: displayName }] : []),
        ],
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'UsernameExistsException') {
      throw badRequest('that address already has an account or a pending invite');
    }
    throw err;
  }

  const now = new Date();
  const invite = {
    email: address,
    ...(displayName ? { name: displayName } : {}),
    invited_by: invitedBy,
    created_at: now.toISOString(),
    expires_at: Math.floor(now.getTime() / 1000) + INVITE_TTL_DAYS * 86400,
  };
  await ddb.send(new PutCommand({ TableName: TABLES.invites, Item: invite }));

  return { invite: { ...invite, status: 'FORCE_CHANGE_PASSWORD' } };
});

/** GET /admin/invites — who has been invited, and whether they arrived. */
export const list = handler(async (event) => {
  requireAdmin(event);

  // A Scan, deliberately: this table holds one row per person ever invited to a
  // single-tenant-per-person app, and a GSI to order a list that short would be
  // infrastructure for its own sake.
  const rows = await ddb.send(new ScanCommand({ TableName: TABLES.invites }));

  const invites: Array<Record<string, unknown>> = await Promise.all(
    (rows.Items ?? []).map(async (row) => {
      const email = String(row.email);
      // Status lives in Cognito, not here: a row saying "pending" after someone
      // signed in would be a second source of truth going stale.
      let status = 'UNKNOWN';
      try {
        const user = await cognito.send(
          new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: email }),
        );
        status = user.UserStatus ?? 'UNKNOWN';
      } catch (err) {
        if ((err as { name?: string }).name === 'UserNotFoundException') status = 'REVOKED';
        else throw err;
      }
      return { ...row, status };
    }),
  );

  invites.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { invites };
});

/**
 * DELETE /admin/invites/{email} — withdraw an invite that was never accepted.
 *
 * Only an unaccepted one. Someone who has signed in has a library, threads and
 * a usage history, and deleting their account from a screen called "invites"
 * would be a destructive act wearing an administrative label. Removing a member
 * is a different operation and should look like one.
 */
export const revoke = handler(async (event) => {
  requireAdmin(event);
  const email = pathParam(event, 'email').toLowerCase();

  let status: string | undefined;
  try {
    const user = await cognito.send(
      new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: email }),
    );
    status = user.UserStatus;
  } catch (err) {
    if ((err as { name?: string }).name !== 'UserNotFoundException') throw err;
  }

  if (status && status !== 'FORCE_CHANGE_PASSWORD') {
    throw badRequest(
      `${email} has already signed in, so this would delete a member rather than withdraw an invite`,
    );
  }

  if (status) {
    await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: email }));
  }
  await ddb.send(new DeleteCommand({ TableName: TABLES.invites, Key: { email } }));

  return { revoked: email };
});

/** GET /admin/usage — what each account has cost, this month. */
export const usage = handler(async (event) => {
  requireAdmin(event);
  const period = `usage#${new Date().toISOString().slice(0, 7)}`;

  // The ledger is keyed by user, so reading it by period is a scan. Fine at this
  // size, and the alternative is an index existing only for one admin screen.
  const rows = await ddb.send(
    new ScanCommand({
      TableName: TABLES.usage,
      FilterExpression: '#p = :period',
      ExpressionAttributeNames: { '#p': 'period' },
      ExpressionAttributeValues: { ':period': period },
    }),
  );

  return { period, accounts: rows.Items ?? [] };
});
