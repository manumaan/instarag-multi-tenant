import { Image } from 'expo-image';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useShareIntentContext } from 'expo-share-intent';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, TextInput, View } from 'react-native';
import { Button, StatusChip, isWorking, useTheme } from '../components/ui';
import { addFromUrl, findInstagramUrl, listMedia, type Media } from '../lib/api';
import { useAuth } from '../lib/auth';
import { subscribeToMedia } from '../lib/ws';

export default function Library() {
  const { hasShareIntent } = useShareIntentContext();
  const { signOut } = useAuth();
  const t = useTheme();

  const [items, setItems] = useState<Media[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [link, setLink] = useState('');
  const [adding, setAdding] = useState(false);
  const loadingMore = useRef(false);

  // A share can arrive while the library is showing (or right after sign-in).
  useEffect(() => {
    if (hasShareIntent) router.push('/share');
  }, [hasShareIntent]);

  const refresh = useCallback(async () => {
    try {
      const page = await listMedia();
      setItems(page.items);
      setCursor(page.cursor);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your library.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Re-read on focus: a reel added from the share sheet should be here on return.
  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  // Progress arrives over the socket, so a tile's chip moves without a pull.
  useEffect(
    () =>
      subscribeToMedia(({ media }) =>
        setItems((current) => {
          const i = current.findIndex((m) => m.id === media.id);
          if (i === -1) return current;
          const next = [...current];
          // The event carries the record, not the presigned thumbnail; keep ours.
          next[i] = { ...current[i], ...media, thumbnailUrl: media.thumbnailUrl ?? current[i].thumbnailUrl };
          return next;
        }),
      ),
    [],
  );

  async function loadMore() {
    if (!cursor || loadingMore.current) return;
    loadingMore.current = true;
    try {
      const page = await listMedia(cursor);
      setItems((current) => [...current, ...page.items.filter((m) => !current.some((c) => c.id === m.id))]);
      setCursor(page.cursor);
    } catch {
      // Leave the cursor; the next scroll to the end tries again.
    } finally {
      loadingMore.current = false;
    }
  }

  async function addLink() {
    const url = findInstagramUrl(link);
    if (!url) {
      setError('Paste an instagram.com reel or post link.');
      return;
    }
    setAdding(true);
    setError(undefined);
    try {
      const { mediaId } = await addFromUrl(url);
      setLink('');
      router.push({ pathname: '/media/[id]', params: { id: mediaId } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that link.');
    } finally {
      setAdding(false);
    }
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => void signOut()} hitSlop={8}>
              <Text style={{ color: t.accent, fontSize: 15 }}>Sign out</Text>
            </Pressable>
          ),
        }}
      />
      <FlatList
        data={items}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        // Without this, a tap on Add while the link field has focus only
        // dismisses the keyboard, and the button never sees the press.
        keyboardShouldPersistTaps="handled"
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void refresh();
            }}
          />
        }
        ListHeaderComponent={
          <View style={{ gap: 8, marginBottom: 4 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                value={link}
                onChangeText={setLink}
                placeholder="Paste an Instagram link"
                placeholderTextColor={t.muted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="go"
                onSubmitEditing={() => void addLink()}
                editable={!adding}
                style={{
                  flex: 1,
                  borderWidth: 1,
                  borderColor: t.border,
                  borderRadius: 10,
                  paddingHorizontal: 12,
                  paddingVertical: 10,
                  color: t.text,
                  backgroundColor: t.card,
                }}
              />
              <Button title={adding ? 'Adding…' : 'Add'} kind="primary" onPress={() => void addLink()} disabled={adding || !link.trim()} />
            </View>
            <Text style={{ fontSize: 13, color: t.muted }}>
              Or use Share → Reel Lens from any reel in Instagram.
            </Text>
            {error ? <Text style={{ color: t.failed }}>{error}</Text> : null}
          </View>
        }
        ListEmptyComponent={
          loading ? null : (
            <Text style={{ color: t.muted, textAlign: 'center', marginTop: 40 }}>
              Your library is empty. Share a reel from Instagram to start.
            </Text>
          )
        }
        renderItem={({ item }) => <Tile media={item} />}
      />
    </>
  );
}

function Tile({ media }: { media: Media }) {
  const t = useTheme();
  const title = media.uploader?.split(/[|·•]/)[0].trim() || (media.type === 'reel' ? 'Reel' : 'Post');
  const subtitle = media.analysis_summary ?? media.caption_raw ?? media.permalink ?? '';
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/media/[id]', params: { id: media.id } })}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: 12,
        padding: 10,
        borderRadius: 12,
        backgroundColor: t.card,
        borderWidth: 1,
        borderColor: t.border,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Image
        // The presigned URL changes on every list call; key the cache on the
        // reel instead, or every refresh would download every tile again.
        source={media.thumbnailUrl ? { uri: media.thumbnailUrl, cacheKey: `thumb-${media.id}` } : undefined}
        style={{ width: 72, height: 96, borderRadius: 8, backgroundColor: t.border }}
        contentFit="cover"
        cachePolicy="memory-disk"
        recyclingKey={media.id}
      />
      <View style={{ flex: 1, gap: 6 }}>
        <Text numberOfLines={1} style={{ fontSize: 16, fontWeight: '600', color: t.text }}>
          {title}
        </Text>
        <Text numberOfLines={3} style={{ fontSize: 14, color: t.muted, lineHeight: 19 }}>
          {subtitle}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <StatusChip status={media.status} />
          {isWorking(media.status) ? <Text style={{ fontSize: 12, color: t.muted }}>in progress</Text> : null}
        </View>
      </View>
    </Pressable>
  );
}
