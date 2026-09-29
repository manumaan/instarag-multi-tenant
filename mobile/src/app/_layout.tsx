import { Stack } from 'expo-router';
import { ShareIntentProvider } from 'expo-share-intent';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { useTheme } from '../components/ui';
import { AuthProvider, useAuth } from '../lib/auth';

function Routes() {
  const { status } = useAuth();
  const t = useTheme();

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}>
        <ActivityIndicator color={t.accent} />
      </View>
    );
  }

  const signedIn = status === 'signedIn';
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.card },
        headerTintColor: t.text,
        contentStyle: { backgroundColor: t.bg },
      }}
    >
      {/*
        A share that arrives signed out lands on sign-in; the share itself is
        held by ShareIntentProvider, and the library forwards it on once the
        user is in. So signing in never loses the reel they were sharing.
      */}
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="index" options={{ title: 'Reel Lens' }} />
        <Stack.Screen name="media/[id]" options={{ title: '' }} />
        <Stack.Screen name="share" options={{ title: 'Adding reel', presentation: 'modal' }} />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    // Outermost, per expo-share-intent: it must see the launch intent first.
    <ShareIntentProvider options={{ resetOnBackground: true }}>
      <AuthProvider>
        <StatusBar style="auto" />
        <Routes />
      </AuthProvider>
    </ShareIntentProvider>
  );
}
