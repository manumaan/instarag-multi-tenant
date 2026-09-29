import { getShareExtensionKey } from 'expo-share-intent';

/**
 * Rewrites deep links before Expo Router tries to match them.
 *
 * - The iOS share extension opens the app with `reellens://dataUrl=<key>`,
 *   which matches no route; send it to the screen that reads the share.
 * - Cognito's redirects (`auth/callback`, `signed-out`) are consumed by the
 *   auth session itself. On Android they also arrive as a deep link, and
 *   routing them would show "unmatched route" behind the sign-in.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    if (path.includes(`dataUrl=${getShareExtensionKey()}`)) return '/share';
    if (path.includes('auth/callback') || path.includes('signed-out')) return '/';
    return path;
  } catch {
    return '/';
  }
}
