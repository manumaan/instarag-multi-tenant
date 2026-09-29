import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, useTheme } from '../../components/ui';
import { ApiError, ask, listThreads, looksLikePlan, startPlan, warmSearch, type Thread } from '../../lib/api';

type Mode = 'plan' | 'answer';

/**
 * Ask across the whole library.
 *
 * Two modes, as on the web: an answer pins one fact and cites it; a plan
 * ("create me a travel plan for Istanbul with all the tips") is built from many
 * clips in the background. Both land on a thread, so a plan can be left and
 * come back to, and every past question is one tap away.
 */
export default function AskTab() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [question, setQuestion] = useState('');
  const [forced, setForced] = useState<Mode>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [threads, setThreads] = useState<Thread[]>();

  const mode: Mode = forced ?? (looksLikePlan(question) ? 'plan' : 'answer');

  useFocusEffect(
    useCallback(() => {
      void listThreads()
        .then((r) => setThreads([...r.items].sort((a, b) => b.created_at.localeCompare(a.created_at))))
        .catch(() => setThreads([]));
    }, []),
  );

  async function submit() {
    const asked = question.trim();
    if (!asked || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const threadId =
        mode === 'plan' ? (await startPlan(asked)).threadId : ((await ask(asked)).threadId ?? undefined);
      setQuestion('');
      setForced(undefined);
      if (threadId) router.push({ pathname: '/thread/[id]', params: { id: threadId } });
      else setError('That was answered but not saved to a thread. Try asking again.');
    } catch (err) {
      // A 503/504 is the search index waking up past the API's 30s ceiling; it
      // is warm by the time this shows.
      setError(
        err instanceof ApiError && err.status >= 503
          ? 'The search index was waking up. Ask again — it should be quick now.'
          : err instanceof Error
            ? err.message
            : 'The question failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  const chip = (value: Mode, label: string) => {
    const active = mode === value;
    return (
      <Pressable
        onPress={() => setForced(value)}
        style={{
          paddingHorizontal: 12,
          paddingVertical: 5,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: active ? t.accent : t.border,
          backgroundColor: active ? t.accent : 'transparent',
        }}
      >
        <Text style={{ color: active ? t.accentText : t.muted, fontSize: 13, fontWeight: '600' }}>{label}</Text>
      </Pressable>
    );
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      // The tab header sits above this view; the keyboard is measured from the screen top.
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}
    >
      <FlatList
        data={threads ?? []}
        keyExtractor={(th) => th.id}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <Text style={{ fontSize: 13, color: t.muted, marginBottom: 2 }}>
            Ask a question across all your reels, or ask for a plan — "create me a travel plan for Istanbul with all
            the tips".
          </Text>
        }
        ListEmptyComponent={
          threads === undefined ? <ActivityIndicator color={t.accent} style={{ marginTop: 24 }} /> : null
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push({ pathname: '/thread/[id]', params: { id: item.id } })}
            style={({ pressed }) => ({
              padding: 14,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: t.border,
              backgroundColor: t.card,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <Text numberOfLines={2} style={{ fontSize: 15, fontWeight: '600', color: t.text }}>
              {item.title}
            </Text>
            <Text style={{ fontSize: 12, color: t.muted, marginTop: 4 }}>
              {item.scope === 'media' ? 'About one reel' : 'Whole library'} · {item.created_at.slice(0, 10)}
            </Text>
          </Pressable>
        )}
      />

      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: t.border,
          backgroundColor: t.card,
          padding: 12,
          gap: 8,
        }}
      >
        {error ? <Text style={{ color: t.failed, fontSize: 13 }}>{error}</Text> : null}
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          {chip('plan', 'Plan')}
          {chip('answer', 'Answer')}
          <Text style={{ fontSize: 12, color: t.muted, flex: 1 }} numberOfLines={1}>
            {mode === 'plan' ? 'Builds from many clips · ~1 min' : 'One cited answer'}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput
            value={question}
            onChangeText={setQuestion}
            onFocus={warmSearch}
            placeholder="Ask your reels…"
            placeholderTextColor={t.muted}
            multiline
            editable={!busy}
            style={{
              flex: 1,
              maxHeight: 110,
              borderWidth: 1,
              borderColor: t.border,
              borderRadius: 10,
              paddingHorizontal: 12,
              paddingVertical: 10,
              color: t.text,
              backgroundColor: t.bg,
              fontSize: 15,
            }}
          />
          <Button
            title={busy ? '…' : mode === 'plan' ? 'Build' : 'Ask'}
            kind="primary"
            onPress={() => void submit()}
            disabled={busy || !question.trim()}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}
