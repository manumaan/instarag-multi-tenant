import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { Pressable, Text } from 'react-native';
import { useTheme } from '../../components/ui';
import { useAuth } from '../../lib/auth';

/**
 * Library and Ask as bottom tabs, on both platforms. Ask is library-wide —
 * questions and plans across every reel — while a single reel's questions
 * stay on that reel's screen.
 */
export default function TabsLayout() {
  const t = useTheme();
  const { signOut } = useAuth();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.card },
        headerTintColor: t.text,
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.muted,
        tabBarStyle: { backgroundColor: t.card, borderTopColor: t.border },
        sceneStyle: { backgroundColor: t.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Library',
          headerTitle: 'Reel Lens',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'albums' : 'albums-outline'} color={color} size={size} />
          ),
          headerRight: () => (
            <Pressable onPress={() => void signOut()} hitSlop={8} style={{ marginRight: 16 }}>
              <Text style={{ color: t.accent, fontSize: 15 }}>Sign out</Text>
            </Pressable>
          ),
        }}
      />
      <Tabs.Screen
        name="ask"
        options={{
          title: 'Ask',
          headerTitle: 'Ask your reels',
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? 'sparkles' : 'sparkles-outline'} color={color} size={size} />
          ),
        }}
      />
    </Tabs>
  );
}
