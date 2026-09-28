import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

/** Thrown by handlers to produce a specific status code instead of a 500. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const notFound = (m = 'not found') => new HttpError(404, m);

export function json(status: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function parseJsonBody<T>(event: ApiEvent): T {
  if (!event.body) throw badRequest('request body is required');
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw badRequest('request body must be valid JSON');
  }
}

/**
 * Who is calling, from the Cognito JWT the authorizer already validated.
 *
 * `sub` rather than email: it is the stable identifier, and an email can be
 * changed. This is the only accepted source of a user id — nothing may take one
 * from a path, a query string or a body, because that would let a caller name
 * someone else and read their library.
 */
export function callerId(event: ApiEvent): string {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (typeof sub !== 'string' || !sub) {
    // The route is behind the authorizer, so this means misconfiguration rather
    // than an anonymous caller. Failing closed is the only safe reading.
    throw new HttpError(401, 'no authenticated caller');
  }
  return sub;
}

/** Cognito groups from the same token, for the admin screens. */
export function callerGroups(event: ApiEvent): string[] {
  const groups = event.requestContext?.authorizer?.jwt?.claims?.['cognito:groups'];
  if (Array.isArray(groups)) return groups.map(String);
  // A single group arrives as a bracketed string, e.g. "[admin]".
  if (typeof groups === 'string') return groups.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
  return [];
}

export const isAdmin = (event: ApiEvent) => callerGroups(event).includes('admin');

export function pathParam(event: ApiEvent, name: string): string {
  const value = event.pathParameters?.[name];
  if (!value) throw badRequest(`missing path parameter ${name}`);
  return value;
}

/**
 * Wraps a handler so thrown HttpErrors become their status code and anything
 * else becomes a 500 with the detail in logs only, never in the response.
 */
export function handler<T>(fn: (event: ApiEvent) => Promise<T>) {
  return async (event: ApiEvent): Promise<APIGatewayProxyResultV2> => {
    try {
      return json(200, await fn(event));
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: err.message });
      console.error('unhandled error', { route: event.routeKey, err });
      return json(500, { error: 'internal error' });
    }
  };
}
