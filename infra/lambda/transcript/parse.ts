/**
 * Amazon Transcribe output -> the segments we store and index.
 *
 * Transcribe returns word-level items plus its own `audio_segments`; the
 * segments are what we want, because a citation has to point at something a
 * person can be sent to in the player, not at a single word.
 */

export interface TranscribeOutput {
  results?: {
    transcripts?: Array<{ transcript?: string }>;
    audio_segments?: Array<{
      id?: number;
      start_time?: string;
      end_time?: string;
      transcript?: string;
    }>;
    language_code?: string;
    language_identification?: Array<{ code?: string; score?: string }>;
  };
}

export interface TranscriptSegment {
  start_ms: number;
  end_ms: number;
  text: string;
}

const toMs = (seconds: string | undefined) => Math.round(Number(seconds ?? 0) * 1000);

/** Drops empty segments, which Transcribe emits for pauses and music. */
export function parseSegments(output: TranscribeOutput): TranscriptSegment[] {
  const segments = output.results?.audio_segments ?? [];
  return segments
    .map((segment) => ({
      start_ms: toMs(segment.start_time),
      end_ms: toMs(segment.end_time),
      text: (segment.transcript ?? '').trim(),
    }))
    .filter((segment) => segment.text.length > 0)
    .sort((a, b) => a.start_ms - b.start_ms);
}

export function fullTranscript(output: TranscribeOutput): string {
  return (output.results?.transcripts ?? [])
    .map((t) => (t.transcript ?? '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function detectedLanguage(output: TranscribeOutput): string | undefined {
  const identified = output.results?.language_identification?.[0]?.code;
  return identified ?? output.results?.language_code;
}

/**
 * Groups segments into citable chunks of at least `minMs`.
 *
 * Transcribe splits mid-sentence: a real reel gave "One bite" and "and I was
 * speechless." a tenth of a second apart. Indexed separately those are two
 * weak matches instead of one good one. The grouping runs forward — a short
 * fragment joins what follows it, not the finished sentence before it — and
 * never bridges a gap wider than `maxGapMs`, which would glue unrelated lines
 * together across a pause.
 */
export function mergeShortSegments(
  segments: TranscriptSegment[],
  minMs = 1500,
  maxGapMs = 400,
): TranscriptSegment[] {
  const merged: TranscriptSegment[] = [];
  let buffer: TranscriptSegment | undefined;

  for (const segment of segments) {
    if (!buffer) {
      buffer = { ...segment };
      continue;
    }
    const gap = segment.start_ms - buffer.end_ms;
    const bufferTooShort = buffer.end_ms - buffer.start_ms < minMs;
    if (bufferTooShort && gap <= maxGapMs) {
      buffer.end_ms = segment.end_ms;
      buffer.text = `${buffer.text} ${segment.text}`.trim();
    } else {
      merged.push(buffer);
      buffer = { ...segment };
    }
  }
  if (buffer) merged.push(buffer);
  return merged;
}

/**
 * Splits long segments at sentence boundaries.
 *
 * Transcribe returned a real 46s reel as three segments of ~20s each. A
 * citation pointing at a 20-second span is nearly useless next to a frame
 * citation that lands on the exact moment, so anything longer than `maxMs` is
 * broken up. Timestamps within a split are apportioned by character count,
 * which is an approximation — speech rate is not uniform — but it puts the
 * player within a second or two of the right line instead of twenty.
 */
export function splitLongSegments(segments: TranscriptSegment[], maxMs = 10000): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];

  for (const segment of segments) {
    const durationMs = segment.end_ms - segment.start_ms;
    if (durationMs <= maxMs) {
      out.push(segment);
      continue;
    }

    const sentences = segment.text.match(/[^.!?]+[.!?]*\s*/g)?.filter((s) => s.trim()) ?? [segment.text];
    if (sentences.length === 1) {
      out.push(segment);
      continue;
    }

    // Group whole sentences until the group is long enough to stand alone.
    const totalChars = sentences.reduce((sum, sentence) => sum + sentence.length, 0);
    const msPerChar = durationMs / totalChars;

    let group: string[] = [];
    let groupStartMs = segment.start_ms;
    let consumedChars = 0;

    const flush = (endMs: number) => {
      const text = group.join('').trim();
      if (text) out.push({ start_ms: Math.round(groupStartMs), end_ms: Math.round(endMs), text });
      group = [];
    };

    for (const sentence of sentences) {
      group.push(sentence);
      consumedChars += sentence.length;
      const endMs = segment.start_ms + consumedChars * msPerChar;
      if (endMs - groupStartMs >= maxMs) {
        flush(endMs);
        groupStartMs = endMs;
      }
    }
    flush(segment.end_ms);
  }

  return out;
}
