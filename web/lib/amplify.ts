'use client';

import { Amplify } from 'aws-amplify';

const userPoolId = process.env.NEXT_PUBLIC_USER_POOL_ID;
const userPoolClientId = process.env.NEXT_PUBLIC_USER_POOL_CLIENT_ID;
const cognitoDomain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN;

/** True when the env file has been filled in from the stack outputs. */
export const authConfigured = Boolean(userPoolId && userPoolClientId && cognitoDomain);

let configured = false;

/**
 * Configures Amplify against the deployed user pool.
 *
 * Sign-in is Hosted UI (authorization code + PKCE), so no password ever passes
 * through this app.
 */
export function configureAmplify() {
  if (configured || !authConfigured || typeof window === 'undefined') return;

  const origin = window.location.origin;
  Amplify.configure(
    {
      Auth: {
        Cognito: {
          userPoolId: userPoolId!,
          userPoolClientId: userPoolClientId!,
          loginWith: {
            oauth: {
              domain: cognitoDomain!,
              scopes: ['openid', 'email', 'profile'],
              redirectSignIn: [`${origin}/auth/callback`],
              redirectSignOut: [origin],
              responseType: 'code',
            },
          },
        },
      },
    },
    { ssr: false },
  );
  configured = true;
}
