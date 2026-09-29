import { Image } from 'expo-image';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { sourceLabel, type Citation, type Source } from '../lib/api';
import { frameKey } from '../lib/frames';
import { openCitation } from './PlanView';
import { useTheme } from './ui';

/**
 * An answer from across the library: the text, then the moments it cites as
 * pictures — the frames themselves — each opening its reel at that point.
 */
export function AnswerView({
  text,
  citations,
  sources,
  pictures,
  answered = true,
}: {
  text: string;
  citations: Citation[];
  sources: Source[];
  pictures: Map<string, string>;
  answered?: boolean;
}) {
  const t = useTheme();
  const sourceOf = (id: string) => sources.find((s) => s.media_id === id);
  const unique = citations.filter((c, i) => citations.findIndex((d) => frameKey(d) === frameKey(c)) === i);

  return (
    <View style={{ gap: 10 }}>
      <Text style={{ fontSize: 15, lineHeight: 21, color: answered ? t.text : t.muted }}>{text}</Text>
      {unique.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
          {unique.map((c) => {
            const picture = pictures.get(frameKey(c));
            const label = sourceLabel(sourceOf(c.media_id), c.ts_ms);
            return (
              <Pressable key={frameKey(c)} onPress={() => openCitation(c)} accessibilityLabel={`Open ${label}`} style={{ width: 96, gap: 4 }}>
                <Image
                  source={picture ? { uri: picture, cacheKey: `frame-${frameKey(c)}` } : undefined}
                  style={{ width: 96, height: 128, borderRadius: 8, backgroundColor: t.border }}
                  contentFit="cover"
                />
                <Text numberOfLines={1} style={{ fontSize: 12, color: t.accent }}>
                  ▶ {label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}
