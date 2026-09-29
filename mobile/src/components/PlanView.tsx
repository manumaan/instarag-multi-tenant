import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { creatorName, sourceLabel, type Citation, type Plan, type Source } from '../lib/api';
import { frameKey } from '../lib/frames';
import { Card, useTheme } from './ui';

/** Opens the cited reel with its player at that moment. */
export function openCitation(c: Citation) {
  router.push({ pathname: '/media/[id]', params: { id: c.media_id, t: String(c.ts_ms) } });
}

/**
 * A plan laid out as a document, the same shape as its PDF: title, lede, who
 * the clips were by, then sections with a picture beside each tip — the frame
 * the tip was read from — and the gaps in their own panel, so the honest half
 * reads as deliberate rather than as an error.
 */
export function PlanView({
  plan,
  sources,
  pictures,
  unsupported,
}: {
  plan: Plan;
  sources: Source[];
  pictures: Map<string, string>;
  unsupported?: boolean;
}) {
  const t = useTheme();
  const sourceOf = (id: string) => sources.find((s) => s.media_id === id);
  const creators = [...new Set(sources.map((s) => creatorName(s.uploader)).filter(Boolean))];

  return (
    <View style={{ gap: 14 }}>
      <View style={{ borderBottomWidth: 2, borderBottomColor: t.accent, paddingBottom: 10 }}>
        <Text style={{ fontSize: 24, fontWeight: '700', color: t.text }}>{plan.title}</Text>
        <Text style={{ fontSize: 14, color: t.accent, marginTop: 4 }}>Curated by Reel Lens app</Text>
      </View>

      {plan.overview ? <Text style={{ fontSize: 15, color: t.muted, lineHeight: 21 }}>{plan.overview}</Text> : null}
      {creators.length ? (
        <Text style={{ fontSize: 13, color: t.muted }}>From clips by {creators.join(', ')}</Text>
      ) : null}

      {unsupported ? (
        <Card>
          <Text style={{ color: t.text }}>Your library doesn't have clips about this yet.</Text>
        </Card>
      ) : null}

      {plan.sections.map((section) => (
        <View key={section.heading} style={{ gap: 10 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', letterSpacing: 0.6, color: t.accent }}>
            {section.heading.toUpperCase()} · {section.items.length} {section.items.length === 1 ? 'tip' : 'tips'}
          </Text>
          {section.items.map((item, i) => {
            const first = item.citations[0];
            const picture = first ? pictures.get(frameKey(first)) : undefined;
            return (
              <View key={i} style={{ flexDirection: 'row', gap: 12 }}>
                <Pressable
                  onPress={() => first && openCitation(first)}
                  disabled={!first}
                  accessibilityLabel={first ? `Open ${sourceLabel(sourceOf(first.media_id), first.ts_ms)}` : undefined}
                >
                  <Image
                    source={picture ? { uri: picture, cacheKey: `frame-${first ? frameKey(first) : i}` } : undefined}
                    style={{ width: 72, height: 96, borderRadius: 6, backgroundColor: t.border }}
                    contentFit="cover"
                  />
                </Pressable>
                <View style={{ flex: 1, gap: 6 }}>
                  <Text style={{ fontSize: 15, color: t.text, lineHeight: 21 }}>{item.text}</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {item.citations.map((c) => (
                      <Pressable
                        key={frameKey(c)}
                        onPress={() => openCitation(c)}
                        style={{ borderWidth: 1, borderColor: t.accent, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}
                      >
                        <Text style={{ color: t.accent, fontSize: 12 }}>▶ {sourceLabel(sourceOf(c.media_id), c.ts_ms)}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              </View>
            );
          })}
        </View>
      ))}

      {plan.gaps.length ? (
        <Card>
          <Text style={{ fontSize: 15, fontWeight: '600', color: t.text, marginBottom: 6 }}>Not covered by your clips</Text>
          {plan.gaps.map((g) => (
            <Text key={g} style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>
              • {g}
            </Text>
          ))}
        </Card>
      ) : null}
    </View>
  );
}
