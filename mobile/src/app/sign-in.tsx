import { useShareIntentContext } from 'expo-share-intent';
import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, useTheme } from '../components/ui';
import { useAuth } from '../lib/auth';
import { configured } from '../lib/config';

export default function SignIn() {
  const { signIn, error } = useAuth();
  const { hasShareIntent } = useShareIntentContext();
  const t = useTheme();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 16 }}>
        <Text style={{ fontSize: 30, fontWeight: '700', color: t.text }}>Reel Lens</Text>
        <Text style={{ fontSize: 16, color: t.muted, lineHeight: 22 }}>
          Share a reel from Instagram to analyse it, then ask questions about what was shown and said.
        </Text>
        {hasShareIntent ? (
          <Text style={{ fontSize: 15, color: t.text }}>Sign in and we'll add the reel you shared.</Text>
        ) : null}
        {!configured ? (
          <Text style={{ color: t.failed }}>
            This build has no API configuration. Run scripts/write-mobile-env.sh and rebuild.
          </Text>
        ) : null}
        <Button title="Sign in" kind="primary" onPress={() => void signIn()} disabled={!configured} />
        {error ? <Text style={{ color: t.failed }}>{error}</Text> : null}
        <Text style={{ fontSize: 13, color: t.muted }}>
          Reel Lens is invite-only. Use the email and password from your invite.
        </Text>
      </View>
    </SafeAreaView>
  );
}
