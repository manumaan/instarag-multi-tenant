import { router } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { Button, useTheme } from '../components/ui';
import { findInstagramUrl, shortcodeOf } from '../lib/api';

/**
 * Where a reel shared from Instagram lands.
 *
 * Instagram shares a permalink as text (`https://www.instagram.com/reel/…/?igsh=…`),
 * sometimes inside a sentence, so the link is pulled out of whatever came in.
 * The API strips the tracking tail and dedupes on the shortcode, so sharing a
 * reel someone already analysed opens it straight away with no second download.
 */
export default function Share() {
  const { hasShareIntent, shareIntent, resetShareIntent, isReady } = useShareIntentContext();
  const [error, setError] = useState<string>();
  const started = useRef(false);
  const t = useTheme();

  useEffect(() => {
    if (!isReady || started.current) return;
    if (!hasShareIntent) {
      // Opened with nothing to add — e.g. the share was already handled.
      router.replace('/');
      return;
    }
    started.current = true;

    const url = findInstagramUrl(shareIntent.webUrl) ?? findInstagramUrl(shareIntent.text);
    const id = url ? shortcodeOf(url) : undefined;
    resetShareIntent();
    if (!url || !id) {
      setError("That doesn't look like an Instagram reel or post link. Share it from Instagram's share button.");
      return;
    }
    // Straight to the reel: it sends the request itself and shows its progress
    // from the first second, instead of this screen waiting on a spinner.
    router.replace({ pathname: '/media/[id]', params: { id, add: url } });
  }, [isReady, hasShareIntent, shareIntent, resetShareIntent]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16, backgroundColor: t.bg }}>
      {error ? (
        <>
          <Text style={{ fontSize: 16, color: t.failed, textAlign: 'center' }}>{error}</Text>
          <Button title="Go to library" onPress={() => router.replace('/')} />
        </>
      ) : (
        <>
          <ActivityIndicator color={t.accent} />
          <Text style={{ color: t.muted }}>Opening the reel…</Text>
        </>
      )}
    </View>
  );
}
