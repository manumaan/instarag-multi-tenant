/**
 * Deployment identifiers, inlined at bundle time from mobile/.env.local.
 *
 * Written by scripts/write-mobile-env.sh from the stack outputs. None of these
 * are secrets — they are the same values the web bundle ships.
 */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';
export const WS_URL = process.env.EXPO_PUBLIC_WS_URL ?? '';
export const USER_POOL_CLIENT_ID = process.env.EXPO_PUBLIC_USER_POOL_CLIENT_ID ?? '';
export const COGNITO_DOMAIN = process.env.EXPO_PUBLIC_COGNITO_DOMAIN ?? '';

/** Must match `scheme` in app.json and Auth.MOBILE_SCHEME in infra/lib/auth.ts. */
export const SCHEME = 'reellens';

export const configured = Boolean(API_URL && USER_POOL_CLIENT_ID && COGNITO_DOMAIN);
