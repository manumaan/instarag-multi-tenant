/**
 * Brave Web Search.
 *
 * Endpoint, header and response shape verified against Brave's own docs:
 * GET https://api.search.brave.com/res/v1/web/search with X-Subscription-Token,
 * results at `web.results[]` carrying title, url and description.
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const secrets = new SecretsManagerClient({});

const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export interface WebResult {
  title: string;
  url: string;
  description: string;
}

interface BraveResponse {
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
}

export class SearchNotConfigured extends Error {
  constructor() {
    super('web search is not configured: no Brave API key has been set');
    this.name = 'SearchNotConfigured';
  }
}

/** Brave caps `count` at 20. */
export function buildSearchUrl(query: string, count: number): string {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(Math.max(count, 1), 20)));
  url.searchParams.set('safesearch', 'moderate');
  return url.toString();
}

/** Drops results missing a url or title: they cannot be cited or followed. */
export function parseResults(body: unknown): WebResult[] {
  const results = (body as BraveResponse)?.web?.results ?? [];
  return results
    .map((result) => ({
      title: (result.title ?? '').trim(),
      url: (result.url ?? '').trim(),
      description: (result.description ?? '').trim(),
    }))
    .filter((result) => result.url && result.title);
}

export async function searchWeb(query: string, apiKey: string, count = 8): Promise<WebResult[]> {
  if (!apiKey) throw new SearchNotConfigured();

  const response = await fetch(buildSearchUrl(query, count), {
    headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' },
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error('Brave rejected the API key');
  }
  if (response.status === 429) {
    throw new Error('Brave rate limit reached; try again shortly');
  }
  if (!response.ok) {
    throw new Error(`Brave search failed: ${response.status}`);
  }
  return parseResults(await response.json());
}

/**
 * Cached across invocations, because the key changes rarely and the call is not
 * free — but with a TTL, and never when empty. Caching an empty key would stick
 * for the container's whole life and keep reporting "not configured" after the
 * key had actually been set.
 */
let cached: { key: string; at: number } | undefined;
const KEY_TTL_MS = 5 * 60 * 1000;

/** The Brave key from SEARCH_SECRET_ARN, or '' when none has been set. */
export async function loadApiKey(): Promise<string> {
  if (cached && Date.now() - cached.at < KEY_TTL_MS) return cached.key;

  let key = '';
  try {
    const secret = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.SEARCH_SECRET_ARN! }));
    const raw = (secret.SecretString ?? '').trim();
    // The secret may hold a bare key or a JSON object with an apiKey field.
    key = raw.startsWith('{') ? String(JSON.parse(raw).apiKey ?? '') : raw;
  } catch (err) {
    console.warn('could not read the search key', { err: err instanceof Error ? err.message : err });
  }

  if (key) cached = { key, at: Date.now() };
  return key;
}
