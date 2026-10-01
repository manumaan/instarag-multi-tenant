import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Text, View } from 'react-native';
import { creatorName, isSlideshow, type Media, type MediaStatus } from '../lib/api';
import { useTheme } from './ui';

/*
 * What a reel is doing while it is added, shown as progress rather than a
 * spinner. Adding takes about a minute and almost all of it is one step —
 * Claude reading the frames — so a checklist alone sat unchanged for fifty
 * seconds and the app looked frozen. This adds an overall bar with time left,
 * a running timer and a sentence on the current step, and the reel's own
 * content (cover, creator, caption) as soon as each piece exists.
 */

type Stage = 'adding' | MediaStatus;

interface Step {
  stage: Stage;
  label: string;
  detail: string;
  /** Typical seconds, measured on the live pipeline (CLAUDE.md, "Pipeline timings"). */
  seconds: number;
}

const REEL_STEPS: Step[] = [
  { stage: 'adding', label: 'Saving the link', detail: 'Adding it to your library.', seconds: 2 },
  { stage: 'queued', label: 'Starting', detail: 'Lining up the work.', seconds: 3 },
  { stage: 'downloading', label: 'Downloading from Instagram', detail: 'Fetching the video and its caption.', seconds: 6 },
  { stage: 'extracting', label: 'Picking keyframes', detail: 'Finding the distinct shots and pulling out the audio.', seconds: 9 },
  {
    stage: 'analysing',
    label: 'Reading the reel',
    detail: 'Claude is reading every keyframe — signs, menus, on-screen text — while the audio is transcribed.',
    seconds: 50,
  },
  { stage: 'indexing', label: 'Making it searchable', detail: 'Indexing each moment so you can ask about it.', seconds: 3 },
];

/** A carousel has no video: no keyframes to pick, and its slides are read instead. */
const SLIDE_STEPS: Step[] = REEL_STEPS.filter((s) => s.stage !== 'extracting').map((s) =>
  s.stage === 'downloading'
    ? { ...s, label: 'Downloading the slides', detail: 'Fetching each slide and the caption.', seconds: 8 }
    : s.stage === 'analysing'
      ? { ...s, label: 'Reading the slides', detail: 'Claude is reading every slide, text and all.', seconds: 40 }
      : s,
);

export function stepsFor(media: Pick<Media, 'type' | 'slide_count'>): Step[] {
  return isSlideshow(media) ? SLIDE_STEPS : REEL_STEPS;
}

/** Where a reel is, for a library tile: step number and the share of the work done at its start. */
export function stageSummary(media: Pick<Media, 'status' | 'type' | 'slide_count'>) {
  const steps = stepsFor(media).filter((s) => s.stage !== 'adding');
  const index = Math.max(0, steps.findIndex((s) => s.stage === media.status));
  const total = steps.reduce((n, s) => n + s.seconds, 0);
  const before = steps.slice(0, index).reduce((n, s) => n + s.seconds, 0);
  return { step: index + 1, of: steps.length, label: steps[index]?.label ?? '', fraction: before / total };
}

const fmt = (s: number) => (s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);

export function ProgressCard({
  stage,
  media,
  cover,
  frameCount,
}: {
  /** 'adding' before the reel exists on the server, then its status. */
  stage: Stage;
  media?: Pick<Media, 'type' | 'slide_count' | 'uploader' | 'caption_raw'>;
  cover?: { uri: string; cacheKey: string };
  frameCount?: number;
}) {
  const t = useTheme();
  const steps = stepsFor(media ?? { type: 'reel' });
  const current = Math.max(0, steps.findIndex((s) => s.stage === stage));
  const step = steps[current];

  // When this step began, as far as this screen knows; it ticks so the timer
  // and the bar move every second instead of only on status changes.
  const startedAt = useRef<{ stage: Stage; at: number }>({ stage, at: Date.now() });
  if (startedAt.current.stage !== stage) startedAt.current = { stage, at: Date.now() };
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const inStep = (Date.now() - startedAt.current.at) / 1000;

  const total = steps.reduce((n, s) => n + s.seconds, 0);
  const done = steps.slice(0, current).reduce((n, s) => n + s.seconds, 0);
  // Within a step, creep towards its end but never claim it: 90% at most,
  // so the bar does not sit at "done" while the step is still running.
  const fraction = Math.min(0.97, (done + Math.min(inStep, step.seconds * 0.9)) / total);
  const overrun = inStep > step.seconds * 1.6 && inStep > 10;
  const left = Math.max(0, total - done - inStep);

  const bar = useRef(new Animated.Value(fraction)).current;
  useEffect(() => {
    Animated.timing(bar, { toValue: fraction, duration: 800, useNativeDriver: false }).start();
  }, [bar, fraction]);

  const who = creatorName(media?.uploader);
  const detail =
    stage === 'analysing' && frameCount
      ? step.detail.replace('every keyframe', `${frameCount} keyframes`).replace('every slide', `${frameCount} slides`)
      : step.detail;

  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <View style={{ width: 54, height: 72, borderRadius: 8, overflow: 'hidden', backgroundColor: t.border }}>
          {cover ? <Image source={cover} style={{ width: '100%', height: '100%' }} contentFit="cover" transition={250} /> : null}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ fontSize: 17, fontWeight: '700', color: t.text }}>
            {stage === 'adding' ? 'Adding your reel' : 'Analysing your reel'}
          </Text>
          <Text numberOfLines={2} style={{ fontSize: 13, color: t.muted }}>
            {who ? `${who}${media?.caption_raw ? ' — ' : ''}` : ''}
            {media?.caption_raw ?? (who ? '' : 'Details appear here as they arrive.')}
          </Text>
        </View>
      </View>

      <View style={{ gap: 6 }}>
        <View style={{ height: 8, borderRadius: 4, backgroundColor: t.border, overflow: 'hidden' }}>
          <Animated.View
            style={{
              height: '100%',
              borderRadius: 4,
              backgroundColor: t.accent,
              width: bar.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
            }}
          />
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ fontSize: 12, color: t.muted }}>
            Step {current + 1} of {steps.length}
          </Text>
          <Text style={{ fontSize: 12, color: overrun ? t.working : t.muted }}>
            {overrun ? 'Taking longer than usual — still working' : left > 5 ? `About ${fmt(left)} left` : 'Almost done'}
          </Text>
        </View>
      </View>

      <View style={{ gap: 10 }}>
        {steps.map((s, i) => {
          const isDone = i < current;
          const active = i === current;
          return (
            <View key={s.stage} style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ width: 20, height: 20, alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
                {active ? (
                  <ActivityIndicator size="small" color={t.accent} />
                ) : isDone ? (
                  <Text style={{ color: t.ready, fontSize: 15, fontWeight: '700' }}>✓</Text>
                ) : (
                  <View style={{ width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: t.border }} />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 15, color: isDone || active ? t.text : t.muted, fontWeight: active ? '600' : '400' }}>
                    {s.label}
                  </Text>
                  {active ? <Text style={{ fontSize: 12, color: t.muted, fontVariant: ['tabular-nums'] }}>{fmt(inStep)}</Text> : null}
                </View>
                {active ? <Text style={{ fontSize: 13, color: t.muted, marginTop: 2, lineHeight: 18 }}>{detail}</Text> : null}
              </View>
            </View>
          );
        })}
      </View>

      <Text style={{ fontSize: 12, color: t.muted }}>You can leave this screen — it keeps going, and the library shows its progress.</Text>
    </View>
  );
}
