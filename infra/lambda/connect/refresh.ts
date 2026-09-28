import { refreshLongLivedToken, shouldRefresh } from './instagram';
import { readConnection, writeConnection } from './store';

export interface RefreshResult {
  connected: boolean;
  refreshed: boolean;
  reason?: string;
  daysLeft?: number;
}

/**
 * Scheduled token refresh.
 *
 * A long-lived token lasts 60 days and can be refreshed once it is 24 hours
 * old, so this runs daily and acts only inside the renewal window. Letting one
 * lapse means the user has to re-authorise by hand, which is the failure this
 * exists to prevent.
 */
export async function handler(): Promise<RefreshResult> {
  const connection = await readConnection();
  if (!connection) return { connected: false, refreshed: false, reason: 'nothing connected' };

  const daysLeft = Math.round((new Date(connection.expires_at).getTime() - Date.now()) / 86_400_000);

  if (!shouldRefresh(connection.obtained_at, connection.expires_at)) {
    console.log('no refresh needed', { daysLeft, obtainedAt: connection.obtained_at });
    return { connected: true, refreshed: false, reason: 'outside the renewal window', daysLeft };
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
  console.log('token refreshed', { previousDaysLeft: daysLeft, newDaysLeft });
  return { connected: true, refreshed: true, daysLeft: newDaysLeft };
}
