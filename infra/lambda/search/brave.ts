/**
 * Brave Web Search.
 *
 * Endpoint, header and response shape verified against Brave's own docs:
 * GET https://api.search.brave.com/res/v1/web/search with X-Subscription-Token,
 * results at `web.results[]` carrying title, url and description.
 */

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
