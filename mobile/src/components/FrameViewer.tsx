import { Image } from 'expo-image';
import { useState } from 'react';
import { FlatList, Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { momentLabel, type Frame, type Media } from '../lib/api';

/**
 * A keyframe at full size, opened from the filmstrip.
 *
 * The strip carries only the small copies, so this is the one place a full
 * keyframe (up to 1280px) is fetched — and only for the frames actually opened.
 * Swipe sideways for the neighbouring frames; the video is left alone.
 */
export function FrameViewer({
  media,
  frames,
  index,
  onClose,
}: {
  media: Media;
  frames: Frame[];
  index: number;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState(index);
  const frame = frames[current];

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <View style={{ flex: 1, backgroundColor: '#000', paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, height: 44 }}>
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] }}>
            {frame ? momentLabel(media, frame.ts_ms) : ''}
            <Text style={{ color: '#aaa', fontWeight: '400' }}>  {current + 1} / {frames.length}</Text>
          </Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Close">
            <Text style={{ color: '#fff', fontSize: 16 }}>Done</Text>
          </Pressable>
        </View>

        <FlatList
          data={frames}
          horizontal
          pagingEnabled
          initialScrollIndex={index}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          showsHorizontalScrollIndicator={false}
          keyExtractor={(f) => String(f.ts_ms)}
          onMomentumScrollEnd={(e) => setCurrent(Math.round(e.nativeEvent.contentOffset.x / width))}
          renderItem={({ item }) => (
            <Image
              // Keyed by moment, like every other frame on this screen, so a frame
              // opened once is not downloaded again on the next visit.
              source={item.url ? { uri: item.url, cacheKey: `frame-${item.media_id}:${item.ts_ms}` } : undefined}
              placeholder={item.thumb_url ? { uri: item.thumb_url, cacheKey: `frame-s-${item.media_id}:${item.ts_ms}` } : undefined}
              placeholderContentFit="contain"
              style={{ width, height: height * 0.62 }}
              contentFit="contain"
              accessibilityLabel={item.description ?? `frame at ${momentLabel(media, item.ts_ms)}`}
            />
          )}
          style={{ flexGrow: 0 }}
        />

        {frame?.description || frame?.ocr_text ? (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 10 }}>
            {frame.description ? <Text style={{ color: '#eee', fontSize: 15, lineHeight: 21 }}>{frame.description}</Text> : null}
            {frame.ocr_text ? (
              <>
                <Text style={{ color: '#999', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 }}>Text in frame</Text>
                <Text selectable style={{ color: '#ccc', fontSize: 13, lineHeight: 19 }}>
                  {frame.ocr_text}
                </Text>
              </>
            ) : null}
          </ScrollView>
        ) : null}
      </View>
    </Modal>
  );
}
