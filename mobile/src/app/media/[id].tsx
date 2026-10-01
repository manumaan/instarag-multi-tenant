import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { ProgressCard } from '../../components/Progress';
import { Button, Card, SectionTitle, StatusChip, isWorking, useTheme } from '../../components/ui';
import {
  ApiError,
  addFromUrl,
  ask,
  getMedia,
  isSlideshow,
  momentLabel,
  retryMedia,
  warmSearch,
  type AskAnswer,
  type Media,
  type MediaDetail,
} from '../../lib/api';
import { subscribeToMedia } from '../../lib/ws';

/** Fallback for a dropped socket: the pipeline takes a minute or two, so this is plenty. */
const POLL_MS = 10_000;

export default function ReelDetail() {
  // `t` is a cited moment (ms) to open at — from a plan tip or an answer's picture.
  // `add`: a link being added right now. The screen opens before the request
  // returns, so progress shows from the first moment rather than a spinner.
  const { id, t: startParam, add } = useLocalSearchParams<{ id: string; t?: string; add?: string }>();
  const [adding, setAdding] = useState(Boolean(add));
  const [addError, setAddError] = useState<string>();
  const startAtMs = startParam !== undefined && Number.isFinite(Number(startParam)) ? Number(startParam) : undefined;
  const startApplied = useRef(false);
  const t = useTheme();
  const [detail, setDetail] = useState<MediaDetail>();
  const [error, setError] = useState<string>();
  const scroll = useRef<ScrollView>(null);
  const slides = useRef<FlatList>(null);
  const { width } = useWindowDimensions();

  const load = useCallback(async () => {
    try {
      setDetail(await getMedia(id));
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this reel.');
    }
  }, [id]);

  useEffect(() => {
    if (!add) {
      void load();
      return;
    }
    // The reel is not ours until this returns, so it is read only after.
    setAdding(true);
    setAddError(undefined);
    addFromUrl(add)
      .then(() => {
        setAdding(false);
        return load();
      })
      .catch((err: unknown) => setAddError(err instanceof Error ? err.message : 'Could not add that link.'));
  }, [add, load]);

  // Wake the search index now, while the reel is being watched, rather than
  // when the question box is focused — by then there is too little time left
  // before the API's 30s ceiling. Throttled inside warmSearch.
  useEffect(() => {
    warmSearch();
  }, []);

  const status = detail?.media.status;
  const working = status ? isWorking(status) : false;

  // Live status from the socket. Every step adds something worth showing — the
  // caption and creator after the download, the cover and keyframes after
  // extraction — so the reel is re-read on each change, not only at the end,
  // and the screen fills in as the work happens.
  useEffect(
    () =>
      subscribeToMedia(({ media }) => {
        if (media.id !== id) return;
        setDetail((current) => (current ? { ...current, media: { ...current.media, ...media } } : current));
        void load();
      }),
    [id, load],
  );

  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [working, load]);

  /*
   * The video is fetched only when it is wanted. It is the heaviest thing on
   * this screen by far — 6 MB for a median reel, 56 MB for the largest — and
   * it used to start downloading the moment the screen opened, played or not.
   * On mobile data that was most of the cost of looking at a reel. Opening at a
   * cited moment counts as wanting it: that is someone coming to watch.
   */
  const player = useVideoPlayer(null);
  const playbackUrl = detail?.playbackUrl;
  const [videoWanted, setVideoWanted] = useState(startAtMs !== undefined);
  const pendingSeek = useRef<number | undefined>(startAtMs);
  const videoLoaded = useRef(false);
  useEffect(() => {
    // Loaded once: the screen re-reads the reel while it is being processed, and
    // each read presigns a fresh URL, which would otherwise restart playback.
    if (!playbackUrl || !videoWanted || videoLoaded.current) return;
    videoLoaded.current = true;
    void player.replaceAsync(playbackUrl).then(() => {
      // Seek only once the source is in: a seek before that is dropped.
      const at = pendingSeek.current;
      pendingSeek.current = undefined;
      if (at !== undefined) player.currentTime = at / 1000;
      player.play();
    });
  }, [player, playbackUrl, videoWanted]);

  const media = detail?.media;
  const slideshow = media ? isSlideshow(media) : false;

  /** Every citation, frame and transcript line lands here: jump to that moment. */
  const seek = useCallback(
    (tsMs: number) => {
      scroll.current?.scrollTo({ y: 0, animated: true });
      if (slideshow) {
        const index = detail?.frames.findIndex((f) => f.ts_ms === tsMs) ?? -1;
        if (index >= 0) slides.current?.scrollToIndex({ index, animated: true });
        return;
      }
      if (!videoLoaded.current) {
        // First play: fetch the video, then land on this moment.
        pendingSeek.current = tsMs;
        setVideoWanted(true);
        return;
      }
      player.currentTime = tsMs / 1000;
      player.play();
    },
    [slideshow, detail?.frames, player],
  );

  // A carousel has no player: turn to the cited slide once the slides render.
  useEffect(() => {
    if (!slideshow || startAtMs === undefined || startApplied.current || !detail?.frames.length) return;
    startApplied.current = true;
    const timer = setTimeout(() => seek(startAtMs), 300);
    return () => clearTimeout(timer);
  }, [slideshow, startAtMs, detail?.frames.length, seek]);

  if (adding || addError) {
    return (
      <ScrollView contentContainerStyle={{ padding: 16 }} style={{ backgroundColor: t.bg }}>
        <Card>
          {addError ? (
            <View style={{ gap: 12 }}>
              <Text style={{ fontSize: 17, fontWeight: '700', color: t.text }}>Couldn't add this reel</Text>
              <Text style={{ color: t.failed }}>{addError}</Text>
              <Button
                title="Try again"
                kind="primary"
                onPress={() => {
                  setAddError(undefined);
                  addFromUrl(add!)
                    .then(() => {
                      setAdding(false);
                      return load();
                    })
                    .catch((err: unknown) => setAddError(err instanceof Error ? err.message : 'Could not add that link.'));
                }}
              />
            </View>
          ) : (
            <ProgressCard stage="adding" />
          )}
        </Card>
      </ScrollView>
    );
  }

  if (!detail || !media) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: t.bg }}>
        {error ? (
          <>
            <Text style={{ color: t.failed, textAlign: 'center', marginBottom: 12 }}>{error}</Text>
            <Button title="Try again" onPress={() => void load()} />
          </>
        ) : (
          <ActivityIndicator color={t.accent} />
        )}
      </View>
    );
  }

  const creator = media.uploader?.split(/[|·•]/)[0].trim();

  return (
    <>
      <Stack.Screen options={{ title: creator || (media.type === 'reel' ? 'Reel' : 'Post') }} />
      <ScrollView ref={scroll} contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled">
        {working ? (
          <Card>
            <ProgressCard
              stage={media.status}
              media={media}
              cover={
                detail.frames[0]?.url
                  ? { uri: detail.frames[0].url, cacheKey: `frame-${media.id}:${detail.frames[0].ts_ms}` }
                  : undefined
              }
              frameCount={detail.frames.length || undefined}
            />
          </Card>
        ) : null}
        {status === 'failed' ? (
          <Card>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
              <SectionTitle>Not analysed</SectionTitle>
              <StatusChip status={media.status} />
            </View>
            {media.error ? <Text style={{ color: t.muted, fontSize: 13 }}>{media.error}</Text> : null}
            <View style={{ marginTop: 12 }}>
              <Button
                title="Retry"
                kind="primary"
                onPress={() =>
                  void retryMedia(media.id)
                    .then(load)
                    .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Retry failed'))
                }
              />
            </View>
          </Card>
        ) : null}

        {!slideshow && playbackUrl ? (
          videoWanted ? (
            <VideoView
              player={player}
              nativeControls
              contentFit="contain"
              style={{ width: '100%', height: Math.min(width * 1.25, 520), borderRadius: 12, backgroundColor: '#000' }}
            />
          ) : (
            <Pressable
              onPress={() => setVideoWanted(true)}
              accessibilityRole="button"
              accessibilityLabel="Play video"
              style={{ width: '100%', height: Math.min(width * 1.25, 520), borderRadius: 12, overflow: 'hidden', backgroundColor: '#000' }}
            >
              {/* The cover frame stands in until play: already fetched, a few tens of KB. */}
              {detail.frames[0]?.url ? (
                <Image
                  source={{ uri: detail.frames[0].url, cacheKey: `frame-${media.id}:${detail.frames[0].ts_ms}` }}
                  style={{ width: '100%', height: '100%' }}
                  contentFit="contain"
                />
              ) : null}
              <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
                <View
                  style={{
                    width: 68,
                    height: 68,
                    borderRadius: 34,
                    backgroundColor: 'rgba(0,0,0,0.55)',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: 28, marginLeft: 4 }}>▶</Text>
                </View>
                <Text style={{ color: '#fff', fontSize: 13, marginTop: 10, textShadowColor: '#000', textShadowRadius: 4 }}>
                  Tap to play
                </Text>
              </View>
            </Pressable>
          )
        ) : null}

        {slideshow && detail.frames.length > 0 ? (
          <FlatList
            ref={slides}
            data={detail.frames}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            keyExtractor={(f) => String(f.ts_ms)}
            getItemLayout={(_, index) => ({ length: width - 32, offset: (width - 32) * index, index })}
            renderItem={({ item }) => (
              <Image
                // Keyed by moment, not URL: the URL is presigned afresh on every
                // read, so a URL-keyed cache never hit and every visit re-downloaded.
                source={item.url ? { uri: item.url, cacheKey: `frame-${item.media_id}:${item.ts_ms}` } : undefined}
                style={{ width: width - 32, height: (width - 32) * 1.25, backgroundColor: t.border }}
                contentFit="contain"
              />
            )}
            style={{ borderRadius: 12 }}
          />
        ) : null}

        {error ? <Text style={{ color: t.failed }}>{error}</Text> : null}

        {media.analysis_summary ? (
          <Card>
            <SectionTitle>Summary</SectionTitle>
            <Text style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>{media.analysis_summary}</Text>
          </Card>
        ) : null}

        {media.places?.length ? <Places media={media} onSeek={seek} /> : null}

        {status === 'ready' ? <Ask media={media} onSeek={seek} /> : null}

        {media.caption_raw ? <Caption caption={media.caption_raw} fromFrames={media.caption_source === 'frames'} /> : null}

        {detail.frames.length > 0 && !slideshow ? (
          <Card>
            <SectionTitle>Keyframes</SectionTitle>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {detail.frames.map((f) => (
                <Pressable key={f.ts_ms} onPress={() => seek(f.ts_ms)} style={{ gap: 4 }}>
                  <Image
                    source={f.url ? { uri: f.url, cacheKey: `frame-${f.media_id}:${f.ts_ms}` } : undefined}
                    style={{ width: 90, height: 120, borderRadius: 6, backgroundColor: t.border }}
                    contentFit="cover"
                  />
                  <Text style={{ fontSize: 12, color: t.muted }}>{momentLabel(media, f.ts_ms)}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Card>
        ) : null}

        {detail.transcriptSegments.length > 0 ? (
          <Card>
            <SectionTitle>What was said</SectionTitle>
            <View style={{ gap: 10 }}>
              {detail.transcriptSegments.map((s) => (
                <Pressable key={s.start_ms} onPress={() => seek(s.start_ms)} style={{ flexDirection: 'row', gap: 10 }}>
                  <Text style={{ color: t.accent, fontSize: 13, width: 44, fontVariant: ['tabular-nums'] }}>
                    {momentLabel(media, s.start_ms)}
                  </Text>
                  <Text style={{ flex: 1, color: t.text, fontSize: 15, lineHeight: 21 }}>{s.text}</Text>
                </Pressable>
              ))}
            </View>
          </Card>
        ) : null}

        {media.permalink ? (
          <Button title="Open in Instagram" onPress={() => void Linking.openURL(media.permalink!)} />
        ) : null}
      </ScrollView>
    </>
  );
}

function Places({ media, onSeek }: { media: Media; onSeek: (tsMs: number) => void }) {
  const t = useTheme();
  const basisLabel = { read_from_frame: 'read on screen', from_caption: 'from caption', inferred: 'inferred' } as const;
  return (
    <Card>
      <SectionTitle>Places</SectionTitle>
      <View style={{ gap: 12 }}>
        {media.places!.map((p) => (
          <View key={`${p.name}-${p.kind}`} style={{ gap: 4 }}>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }}>
              {p.name} <Text style={{ fontWeight: '400', color: t.muted }}>· {p.kind}</Text>
            </Text>
            {/* Inferred places are marked, never shown as if they were read off the frame. */}
            <Text style={{ fontSize: 12, color: p.basis === 'inferred' ? t.working : t.muted }}>{basisLabel[p.basis]}</Text>
            {p.evidence.map((e) => (
              <Pressable key={`${e.ts_ms}-${e.text}`} onPress={() => onSeek(e.ts_ms)}>
                <Text style={{ fontSize: 13, color: t.accent }}>
                  {momentLabel(media, e.ts_ms)} — “{e.text}”
                </Text>
              </Pressable>
            ))}
          </View>
        ))}
      </View>
    </Card>
  );
}

function Caption({ caption, fromFrames }: { caption: string; fromFrames: boolean }) {
  const t = useTheme();
  const [copied, setCopied] = useState<string>();
  const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu)?.join(' ');

  async function copy(text: string, what: string) {
    await Clipboard.setStringAsync(text);
    setCopied(what);
    setTimeout(() => setCopied(undefined), 1500);
  }

  return (
    <Card>
      <SectionTitle>Caption</SectionTitle>
      {fromFrames ? <Text style={{ fontSize: 12, color: t.muted, marginBottom: 6 }}>Read off the video</Text> : null}
      <Text selectable style={{ color: t.text, fontSize: 15, lineHeight: 21 }}>
        {caption}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
        <Button small title={copied === 'caption' ? 'Copied' : 'Copy caption'} onPress={() => void copy(caption, 'caption')} />
        {hashtags ? (
          <Button small title={copied === 'tags' ? 'Copied' : 'Copy hashtags'} onPress={() => void copy(hashtags, 'tags')} />
        ) : null}
      </View>
    </Card>
  );
}

interface Exchange {
  question: string;
  answer?: AskAnswer;
  error?: string;
}

function Ask({ media, onSeek }: { media: Media; onSeek: (tsMs: number) => void }) {
  const t = useTheme();
  const [question, setQuestion] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setQuestion('');
    setExchanges((xs) => [...xs, { question: q }]);
    try {
      const answer = await ask(q, { mediaId: media.id, threadId });
      setThreadId(answer.threadId);
      setExchanges((xs) => xs.map((x, i) => (i === xs.length - 1 ? { ...x, answer } : x)));
    } catch (err) {
      // A 503/504 here is the index's cold start outlasting the API's 30s
      // ceiling. The collection is warm by the time this shows, so say so.
      const message =
        err instanceof ApiError && err.status >= 503
          ? 'The search index was waking up. Ask again — it should be quick now.'
          : err instanceof Error
            ? err.message
            : 'Could not answer.';
      setExchanges((xs) => xs.map((x, i) => (i === xs.length - 1 ? { ...x, error: message } : x)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionTitle>Ask about this reel</SectionTitle>
      <View style={{ gap: 14 }}>
        {exchanges.map((x, i) => (
          <View key={i} style={{ gap: 6 }}>
            <Text style={{ color: t.text, fontWeight: '600', fontSize: 15 }}>{x.question}</Text>
            {x.answer ? (
              <>
                <Text style={{ color: x.answer.answered ? t.text : t.muted, fontSize: 15, lineHeight: 21 }}>
                  {x.answer.answer}
                </Text>
                {x.answer.citations.length ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {x.answer.citations
                      .filter((c) => c.media_id === media.id)
                      .map((c) => (
                        <Pressable
                          key={`${c.media_id}-${c.ts_ms}`}
                          onPress={() => onSeek(c.ts_ms)}
                          accessibilityLabel={`Go to ${momentLabel(media, c.ts_ms)}`}
                          style={{ borderWidth: 1, borderColor: t.accent, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 }}
                        >
                          <Text style={{ color: t.accent, fontSize: 13 }}>▶ {momentLabel(media, c.ts_ms)}</Text>
                        </Pressable>
                      ))}
                  </View>
                ) : null}
              </>
            ) : x.error ? (
              <Text style={{ color: t.failed }}>{x.error}</Text>
            ) : (
              <ActivityIndicator color={t.accent} style={{ alignSelf: 'flex-start' }} />
            )}
          </View>
        ))}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput
            value={question}
            onChangeText={setQuestion}
            onFocus={warmSearch}
            placeholder="e.g. Which cafe is this?"
            placeholderTextColor={t.muted}
            returnKeyType="send"
            onSubmitEditing={() => void submit()}
            editable={!busy}
            style={{
              flex: 1,
              borderWidth: 1,
              borderColor: t.border,
              borderRadius: 10,
              paddingHorizontal: 12,
              paddingVertical: 10,
              color: t.text,
            }}
          />
          <Button title="Ask" kind="primary" onPress={() => void submit()} disabled={busy || !question.trim()} />
        </View>
      </View>
    </Card>
  );
}
