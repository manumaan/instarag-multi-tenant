import { refreshLongLivedToken, shouldRefresh } from './instagram';
import { allConnections, writeConnection, type Connection } from './store';

export interface AccountRefresh {
  user_id: string;
  refreshed: boolean;
  reason?: string;
  daysLeft?: number;
}

export interface RefreshResult {
  swept: number;
  refreshed: number;
  failed: number;
  accounts: AccountRefresh[];
}

/**
 * Scheduled token refresh, for every connected account.
 *
 * A long-lived token lasts 60 days and can be refreshed once it is 24 hours
 * old, so this runs daily and acts only inside the renewal window. Letting one
 * lapse means that person has to re-authorise by hand, which is the failure
 * this exists to prevent.
 *
 * There is no caller here — the schedule is the caller — so this is the one
 * place that reads across users. Everything it touches is keyed by the user it
 * came from, so a token refreshed for one account is written back to that
 * account and nowhere else.
 */
export async function handler(): Promise<RefreshResult> {
  const connections = await allConnections();
  if (connections.length === 0) {
    console.log('nothing connected');
    return { swept: 0, refreshed: 0, failed: 0, accounts: [] };
  }

  const accounts: AccountRefresh[] = [];
  let failed = 0;

  /*
   * Serially, and one account's failure does not end the sweep: a token Meta
   * refuses to refresh is exactly the token that will lapse, and stopping there
   * would take everyone after it down with it.
   */
  for (const connection of connections) {
    try {
      accounts.push(await renew(connection));
    } catch (err) {
      failed += 1;
      const reason = err instanceof Error ? err.message : String(err);
      console.error('could not refresh a token', { userId: connection.user_id, reason });
      accounts.push({ user_id: connection.user_id, refreshed: false, reason });
    }
  }

  const refreshed = accounts.filter((a) => a.refreshed).length;
  console.log('refresh sweep', { swept: connections.length, refreshed, failed });
  return { swept: connections.length, refreshed, failed, accounts };
}

async function renew(connection: Connection): Promise<AccountRefresh> {
  const daysLeft = Math.round((new Date(connection.expires_at).getTime() - Date.now()) / 86_400_000);

  if (!shouldRefresh(connection.obtained_at, connection.expires_at)) {
    return {
      user_id: connection.user_id,
      refreshed: false,
      reason: 'outside the renewal window',
      daysLeft,
    };
  }

  const refreshed = await refreshLongLivedToken(connection.access_token);
  const now = new Date();
  await writeConnection({
    ...connection,
    access_token: refreshed.access_token,
    obtained_at: now.toISOString(),
    expires_at: new Date(now.getTime() + refreshed.expires_in * 1000).toISOString(),
  });

  const newDaysLeft = Math.round(refreshed.expires_in / 86400);
  console.log('token refreshed', {
    userId: connection.user_id,
    previousDaysLeft: daysLeft,
    newDaysLeft,
  });
  return { user_id: connection.user_id, refreshed: true, daysLeft: newDaysLeft };
}
