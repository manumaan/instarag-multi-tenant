import {
  exchangeCodeAsync,
  makeRedirectUri,
  refreshAsync,
  revokeAsync,
  useAuthRequest,
  type AuthRequestPromptOptions,
  type DiscoveryDocument,
} from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Appearance, Platform } from 'react-native';
import { COGNITO_DOMAIN, SCHEME, USER_POOL_CLIENT_ID } from './config';

/*
 * Sign-in is Cognito's Hosted UI with authorization code + PKCE, the same flow
 * and the same app client as the web. So this app never sees a password, and
 * the API's JWT authorizer accepts its tokens without knowing a phone exists.
 *
 * Tokens live in SecureStore (Keychain / Android Keystore), never AsyncStorage.
 */

const discovery: DiscoveryDocument = {
  authorizationEndpoint: `https://${COGNITO_DOMAIN}/oauth2/authorize`,
  tokenEndpoint: `https://${COGNITO_DOMAIN}/oauth2/token`,
  revocationEndpoint: `https://${COGNITO_DOMAIN}/oauth2/revoke`,
};

const redirectUri = makeRedirectUri({ scheme: SCHEME, path: 'auth/callback' });
const signedOutUri = `${SCHEME}://signed-out`;
const STORE_KEY = 'reellens.tokens';

/**
 * How the sign-in sheet is presented, so it reads as part of the app. The
 * page itself is Cognito's managed login, branded in infra/lib/auth.ts.
 *
 * - iOS: an ephemeral session. It drops the system's "wants to use … to Sign
 *   In" prompt and keeps no browser cookie — which this app never needed,
 *   since it keeps its own tokens.
 * - Android: a Chrome tab in the app's colours, without the page title or the
 *   share button. (Ephemeral sessions are iOS-only.)
 */
function sheetOptions(): AuthRequestPromptOptions {
  const dark = Appearance.getColorScheme() === 'dark';
  return {
    preferEphemeralSession: true,
    showTitle: false,
    enableDefaultShareMenuItem: false,
    showInRecents: false,
    toolbarColor: dark ? '#1d1d1c' : '#ffffff',
    secondaryToolbarColor: dark ? '#1d1d1c' : '#ffffff',
    controlsColor: dark ? '#748ffc' : '#3b5bdb',
    dismissButtonStyle: 'cancel',
  };
}
/** Refresh this long before expiry, so a token never lapses mid-request. */
const REFRESH_MARGIN_MS = 60_000;

interface Tokens {
  idToken: string;
  refreshToken?: string;
  expiresAt: number;
}

let tokens: Tokens | null | undefined; // undefined = not loaded yet
let refreshing: Promise<Tokens | null> | undefined;
const listeners = new Set<(signedIn: boolean) => void>();

async function load(): Promise<Tokens | null> {
  if (tokens !== undefined) return tokens;
  try {
    const raw = await SecureStore.getItemAsync(STORE_KEY);
    tokens = raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    tokens = null;
  }
  return tokens;
}

async function save(next: Tokens | null) {
  tokens = next;
  if (next) await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(next));
  else await SecureStore.deleteItemAsync(STORE_KEY);
  listeners.forEach((l) => l(Boolean(next)));
}

function fromResponse(r: { idToken?: string; refreshToken?: string; expiresIn?: number }, previousRefresh?: string): Tokens {
  if (!r.idToken) throw new Error('Cognito returned no id token');
  return {
    idToken: r.idToken,
    // Cognito does not rotate the refresh token, so a refresh response omits it.
    refreshToken: r.refreshToken ?? previousRefresh,
    expiresAt: Date.now() + (r.expiresIn ?? 3600) * 1000,
  };
}

/**
 * The id token for the API, refreshed if it is about to expire.
 *
 * The refresh is shared: several requests firing as the app wakes would
 * otherwise each spend the refresh token at once.
 */
export async function getIdToken(): Promise<string> {
  const current = await load();
  if (!current) throw new Error('not signed in');
  if (current.expiresAt - REFRESH_MARGIN_MS > Date.now()) return current.idToken;
  if (!current.refreshToken) {
    await save(null);
    throw new Error('session expired');
  }

  refreshing ??= refreshAsync(
    { clientId: USER_POOL_CLIENT_ID, refreshToken: current.refreshToken },
    discovery,
  )
    .then(async (r) => {
      const next = fromResponse(r, current.refreshToken);
      await save(next);
      return next;
    })
    .catch(async () => {
      // A refresh token past its 30 days, or revoked: sign in again.
      await save(null);
      return null;
    })
    .finally(() => {
      refreshing = undefined;
    });

  const next = await refreshing;
  if (!next) throw new Error('session expired');
  return next.idToken;
}

type Status = 'loading' | 'signedOut' | 'signedIn';

interface AuthContextValue {
  status: Status;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  error?: string;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string>();

  const [request, , promptAsync] = useAuthRequest(
    {
      clientId: USER_POOL_CLIENT_ID,
      redirectUri,
      scopes: ['openid', 'email', 'profile'],
      usePKCE: true,
    },
    discovery,
  );

  useEffect(() => {
    const listener = (signedIn: boolean) => setStatus(signedIn ? 'signedIn' : 'signedOut');
    listeners.add(listener);
    void load().then((t) => setStatus(t ? 'signedIn' : 'signedOut'));
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const signIn = useCallback(async () => {
    if (!request) return;
    setError(undefined);
    const result = await promptAsync(sheetOptions());
    if (result.type !== 'success') {
      if (result.type === 'error') setError(result.error?.message ?? 'sign-in failed');
      return;
    }
    try {
      const r = await exchangeCodeAsync(
        {
          clientId: USER_POOL_CLIENT_ID,
          code: result.params.code,
          redirectUri,
          extraParams: { code_verifier: request.codeVerifier ?? '' },
        },
        discovery,
      );
      await save(fromResponse(r));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sign-in failed');
    }
  }, [request, promptAsync]);

  const signOut = useCallback(async () => {
    const current = await load();
    await save(null);
    if (current?.refreshToken) {
      // Best effort: the local tokens are already gone either way.
      await revokeAsync(
        { clientId: USER_POOL_CLIENT_ID, token: current.refreshToken },
        discovery,
      ).catch(() => undefined);
    }
    // On Android the sign-in tab shares Chrome's cookies, so Cognito's own
    // session (an hour) must be cleared too, or the next "Sign in" would put
    // the same person straight back in. iOS signs in ephemerally and keeps no
    // cookie, so there it would only flash a browser sheet for nothing.
    if (Platform.OS !== 'ios') {
      await WebBrowser.openAuthSessionAsync(
        `https://${COGNITO_DOMAIN}/logout?client_id=${USER_POOL_CLIENT_ID}&logout_uri=${encodeURIComponent(signedOutUri)}`,
        signedOutUri,
        sheetOptions(),
      ).catch(() => undefined);
    }
  }, []);

  const value = useMemo(() => ({ status, signIn, signOut, error }), [status, signIn, signOut, error]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth outside AuthProvider');
  return value;
}
