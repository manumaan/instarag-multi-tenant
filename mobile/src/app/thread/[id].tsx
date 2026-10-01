import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { AnswerView } from '../../components/AnswerView';
import { PlanView } from '../../components/PlanView';
import { Card, useTheme } from '../../components/ui';
import { getThread, type ThreadMessage } from '../../lib/api';
import { framePictures } from '../../lib/frames';
import { sharePlanPdf } from '../../lib/pdf';

/** A plan takes about a minute; poll gently, and give up well past that. */
const POLL_MS = 3000;
const POLL_LIMIT = 120;

/**
 * One thread: the questions asked and what came back. A plan's assistant
 * message starts as `working` and is filled in by the plan worker, so this
 * polls until nothing on the thread is still being built.
 */
export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const [messages, setMessages] = useState<ThreadMessage[]>();
  const [pictures, setPictures] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string>();
  const [sharing, setSharing] = useState(false);
  const polls = useRef(0);

  const load = useCallback(async () => {
    try {
      const thread = await getThread(id);
      setMessages(thread.messages);
      setError(undefined);
      return thread.messages;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this thread.');
      return undefined;
    }
  }, [id]);

  const working = messages?.some((m) => m.status === 'working') ?? true;

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!working || !messages) return;
    const timer = setInterval(() => {
      polls.current += 1;
      if (polls.current > POLL_LIMIT) {
        clearInterval(timer);
        setError('The plan is taking longer than expected. Pull back and open it again in a minute.');
        return;
      }
      void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [working, messages, load]);

  // Pictures for every cited moment, once the answers are in.
  useEffect(() => {
    if (!messages || working) return;
    const cited = messages.flatMap((m) => [
      ...(m.citations ?? []),
      ...(m.plan?.sections.flatMap((s) => s.items.flatMap((i) => i.citations)) ?? []),
    ]);
    void framePictures(cited).then(setPictures);
  }, [messages, working]);

  // The newest finished plan on the thread is the one the header shares.
  const latestPlan = [...(messages ?? [])].reverse().find((m) => m.plan && m.status !== 'working');

  async function share() {
    if (!latestPlan?.plan || sharing) return;
    setSharing(true);
    try {
      await sharePlanPdf(latestPlan.plan, latestPlan.sources ?? [], pictures, {
        threadId: id,
        messageAt: latestPlan.created_at,
      });
    } catch (err) {
      Alert.alert('Could not share the PDF', err instanceof Error ? err.message : String(err));
    } finally {
      setSharing(false);
    }
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: latestPlan?.plan?.title ? 'Plan' : 'Ask',
          headerRight: () =>
            latestPlan?.plan ? (
              <Pressable onPress={() => void share()} disabled={sharing} hitSlop={8}>
                <Text style={{ color: t.accent, fontSize: 16, fontWeight: '600', opacity: sharing ? 0.5 : 1 }}>
                  {sharing ? 'Preparing…' : 'Share PDF'}
                </Text>
              </Pressable>
            ) : null,
        }}
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 18 }}>
        {!messages && !error ? <ActivityIndicator color={t.accent} /> : null}
        {error ? <Text style={{ color: t.failed }}>{error}</Text> : null}
        {messages?.map((m) =>
          m.role === 'user' ? (
            <Text key={m.created_at} style={{ fontSize: 17, fontWeight: '600', color: t.text }}>
              {m.content}
            </Text>
          ) : m.status === 'working' ? (
            <Card key={m.created_at}>
              <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                <ActivityIndicator color={t.accent} />
                <Text style={{ color: t.text, flex: 1 }}>
                  Building your plan from your clips. This usually takes about a minute — you can leave and come back.
                </Text>
              </View>
            </Card>
          ) : m.status === 'failed' ? (
            <Text key={m.created_at} style={{ color: t.failed }}>
              {m.error ?? 'The plan could not be built.'}
            </Text>
          ) : m.plan ? (
            <PlanView
              key={m.created_at}
              plan={m.plan}
              sources={m.sources ?? []}
              pictures={pictures}
              unsupported={m.status === 'unsupported'}
            />
          ) : (
            <AnswerView
              key={m.created_at}
              text={m.content}
              citations={m.citations ?? []}
              sources={m.sources ?? []}
              pictures={pictures}
            />
          ),
        )}
      </ScrollView>
    </>
  );
}
