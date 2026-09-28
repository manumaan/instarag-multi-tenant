/**
 * Instagram API with Instagram Login.
 *
 * Verified against Meta's reference docs (2026-09-22):
 * - short-lived -> long-lived: GET https://graph.instagram.com/access_token
 *   with grant_type=ig_exchange_token, client_secret, access_token. One hour
 *   becomes 60 days.
 * - refresh: GET https://graph.instagram.com/refresh_access_token with
 *   grant_type=ig_refresh_token and access_token. The token must be at least
 *   24 hours old and not yet expired; a refresh gives another 60 days and needs
 *   the instagram_business_basic permission.
 * - media_url is omitted for media flagged for copyright.
 *
 * The authorize and code-exchange endpoints are NOT hardcoded: Meta's reachable
 * docs describe them only as the dashboard-generated "embed URL", so they are
 * configuration. The App Dashboard's value is authoritative.
 */

const GRAPH_HOST = process.env.IG_GRAPH_HOST ?? 'https://graph.instagram.com';
export const AUTHORIZE_URL = process.env.IG_AUTHORIZE_URL ?? 'https://www.instagram.com/oauth/authorize';
export const TOKEN_URL = process.env.IG_TOKEN_URL ?? 'https://api.instagram.com/oauth/access_token';

/** Only what this app needs: read the connected account's own media. */
export const DEFAULT_SCOPES = ['instagram_business_basic'];

export interface ShortLivedToken {
  access_token: string;
  user_id?: string | number;
  permissions?: string;
}

export interface LongLivedToken {
  access_token: string;
  /** Seconds until expiry, ~60 days. */
  expires_in: number;
  token_type?: string;
}

export interface IgChild {
  id: string;
  media_type?: 'IMAGE' | 'VIDEO';
  media_url?: string;
}

export interface IgMedia {
  id: string;
  caption?: string;
  media_type?: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM';
  media_product_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
  username?: string;
  /** Present for CAROUSEL_ALBUM: the slides, in order. */
  children?: { data?: IgChild[] };
}

/** Scopes go in one comma-separated parameter. */
export function buildAuthorizeUrl(options: {
  appId: string;
  redirectUri: string;
  state: string;
  scopes?: string[];
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', options.appId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (options.scopes ?? DEFAULT_SCOPES).join(','));
  url.searchParams.set('state', options.state);
  return url.toString();
}

async function readJson(response: Response, what: string): Promise<unknown> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${what}: ${response.status} returned non-JSON`);
  }
  if (!response.ok) {
    const message =
      (body as { error_message?: string; error?: { message?: string } })?.error_message ??
      (body as { error?: { message?: string } })?.error?.message ??
      `${response.status}`;
    throw new Error(`${what}: ${message}`);
  }
  return body;
}

/** The code is single-use and tied to the exact redirect_uri that produced it. */
export async function exchangeCodeForToken(options: {
  appId: string;
  appSecret: string;
  redirectUri: string;
  code: string;
}): Promise<ShortLivedToken> {
  const form = new URLSearchParams({
    client_id: options.appId,
    client_secret: options.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: options.redirectUri,
    code: options.code,
  });
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  return (await readJson(response, 'code exchange failed')) as ShortLivedToken;
}

export async function exchangeForLongLivedToken(options: {
  appSecret: string;
  shortLivedToken: string;
}): Promise<LongLivedToken> {
  const url = new URL(`${GRAPH_HOST}/access_token`);
  url.searchParams.set('grant_type', 'ig_exchange_token');
  url.searchParams.set('client_secret', options.appSecret);
  url.searchParams.set('access_token', options.shortLivedToken);
  return (await readJson(await fetch(url), 'long-lived token exchange failed')) as LongLivedToken;
}

export async function refreshLongLivedToken(token: string): Promise<LongLivedToken> {
  const url = new URL(`${GRAPH_HOST}/refresh_access_token`);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', token);
  return (await readJson(await fetch(url), 'token refresh failed')) as LongLivedToken;
}

export async function getProfile(token: string): Promise<{ id: string; username?: string }> {
  const url = new URL(`${GRAPH_HOST}/me`);
  url.searchParams.set('fields', 'id,username');
  url.searchParams.set('access_token', token);
  return (await readJson(await fetch(url), 'profile lookup failed')) as { id: string; username?: string };
}

const MEDIA_FIELDS = [
  'id',
  'caption',
  'media_type',
  'media_product_type',
  'media_url',
  'thumbnail_url',
  'permalink',
  'timestamp',
  'username',
  // A carousel's slides come back only if asked for; without this the images
  // are invisible and the post looks unusable.
  'children{id,media_type,media_url}',
].join(',');

/** One page of the connected account's own media, newest first. */
export async function listMedia(token: string, limit = 25): Promise<IgMedia[]> {
  const url = new URL(`${GRAPH_HOST}/me/media`);
  url.searchParams.set('fields', MEDIA_FIELDS);
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
  url.searchParams.set('access_token', token);
  const body = (await readJson(await fetch(url), 'media listing failed')) as { data?: IgMedia[] };
  return body.data ?? [];
}

/** True when the token is old enough to refresh and close enough to expiry to bother. */
export function shouldRefresh(
  obtainedAt: string,
  expiresAt: string,
  now = new Date(),
  renewWithinDays = 10,
): boolean {
  const obtained = new Date(obtainedAt).getTime();
  const expires = new Date(expiresAt).getTime();
  if (Number.isNaN(obtained) || Number.isNaN(expires)) return false;

  const ageHours = (now.getTime() - obtained) / 3_600_000;
  const daysLeft = (expires - now.getTime()) / 86_400_000;
  // Meta requires at least 24 hours of age, and a refresh is pointless once
  // the token has already expired.
  return ageHours >= 24 && daysLeft > 0 && daysLeft <= renewWithinDays;
}

/**
 * Reels reach us as VIDEO with a media_url; a carousel as CAROUSEL_ALBUM whose
 * children carry the urls. Copyright-flagged media comes back without a
 * media_url, and there is nothing to ingest in that case.
 */
export function isIngestable(media: IgMedia): boolean {
  if (media.media_type === 'VIDEO') return Boolean(media.media_url);
  if (media.media_type === 'CAROUSEL_ALBUM') return carouselSlides(media).length > 0;
  return false;
}

/** A carousel's image slides, in order, skipping any without a url. */
export function carouselSlides(media: IgMedia): IgChild[] {
  return (media.children?.data ?? []).filter(
    (child) => Boolean(child.media_url) && child.media_type !== 'VIDEO',
  );
}
