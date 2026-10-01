import { ActivityIndicator, Pressable, StyleSheet, Text, View, useColorScheme, type ViewStyle } from 'react-native';
import { isSlideshow, type Media, type MediaStatus } from '../lib/api';

const light = {
  bg: '#f6f6f4',
  card: '#ffffff',
  text: '#1b1b1a',
  muted: '#6b6b66',
  border: '#e3e3de',
  accent: '#3b5bdb',
  accentText: '#ffffff',
  ready: '#2b8a3e',
  readyBg: '#e6f4ea',
  working: '#9c6500',
  workingBg: '#fff4db',
  failed: '#c92a2a',
  failedBg: '#fdecec',
};

const dark: typeof light = {
  bg: '#121212',
  card: '#1d1d1c',
  text: '#ededea',
  muted: '#9a9a94',
  border: '#2f2f2d',
  accent: '#748ffc',
  accentText: '#0d0d0d',
  ready: '#69db7c',
  readyBg: '#1c2f21',
  working: '#ffc94d',
  workingBg: '#33290f',
  failed: '#ff8787',
  failedBg: '#3a1c1c',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

const STATUS_LABEL: Record<MediaStatus, string> = {
  awaiting_upload: 'Waiting',
  queued: 'Queued',
  downloading: 'Downloading',
  extracting: 'Extracting',
  analysing: 'Analysing',
  indexing: 'Indexing',
  ready: 'Ready',
  failed: 'Failed',
};

export const isWorking = (status: MediaStatus) => status !== 'ready' && status !== 'failed';

export function StatusChip({ status }: { status: MediaStatus }) {
  const t = useTheme();
  const [fg, bg] =
    status === 'ready' ? [t.ready, t.readyBg] : status === 'failed' ? [t.failed, t.failedBg] : [t.working, t.workingBg];
  return (
    <View style={[styles.chip, { backgroundColor: bg }]}>
      <Text style={[styles.chipText, { color: fg }]}>{STATUS_LABEL[status]}</Text>
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.card, borderColor: t.border }, style]}>{children}</View>;
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  return <Text style={[styles.sectionTitle, { color: t.text }]}>{children}</Text>;
}

export function Button({
  title,
  onPress,
  kind = 'secondary',
  disabled,
  small,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary';
  disabled?: boolean;
  small?: boolean;
}) {
  const t = useTheme();
  const primary = kind === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        {
          backgroundColor: primary ? t.accent : 'transparent',
          borderColor: primary ? t.accent : t.border,
          opacity: disabled ? 0.5 : pressed ? 0.75 : 1,
        },
      ]}
    >
      <Text style={[styles.buttonText, small && styles.small, { color: primary ? t.accentText : t.text }]}>{title}</Text>
    </Pressable>
  );
}

export const styles = StyleSheet.create({
  chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, alignSelf: 'flex-start' },
  chipText: { fontSize: 12, fontWeight: '600' },
  step: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepIcon: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
  stepText: { fontSize: 15 },
  small: { fontSize: 13 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14 },
  sectionTitle: { fontSize: 17, fontWeight: '600', marginBottom: 8 },
  button: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonSmall: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  buttonText: { fontSize: 15, fontWeight: '600' },
});
