/** The instruction that accompanies a reel's keyframes, or a carousel's slides. */
export function buildInstruction(options: {
  caption?: string;
  permalink?: string;
  /** A carousel is a set of slides, not a timeline: saying so changes the read. */
  isCarousel?: boolean;
}): string {
  const lines = options.isCarousel
    ? [
        'These are the slides of one Instagram carousel post, in order. Each is labelled with',
        'its ts_ms, which encodes the slide number rather than a time: 0 is slide 1, 1000 is',
        'slide 2, and so on.',
        '',
        'A carousel is usually one argument told across slides — a list, a recipe, a',
        'before-and-after, a set of tips. Read them as a sequence and let reel_summary say',
        'what the post as a whole is saying, not just what each slide shows.',
      ]
    : [
        'These are the keyframes of one Instagram reel, in order. Each is labelled with its ts_ms.',
      ];

  lines.push(
    '',
    'Return exactly one frames entry per labelled ts_ms, reusing those values verbatim. Do not invent',
    'timestamps and do not merge frames.',
    '',
    'ocr_text must be verbatim and must include shop signage, awning and window text, menu boards,',
    'street signs and on-screen captions. Text often continues across consecutive frames or slides:',
    'read them in sequence so the post makes sense as a whole.',
    '',
    'places is what makes questions like "which cafe is in this reel" answerable. Set basis to',
    'read_from_frame only when the name is actually legible in a frame, and attach the evidence you',
    'read it from with the ts_ms it came from. Use from_caption when only the caption names it, and',
    'inferred when you are reasoning from architecture, language or style. Never present an inferred',
    'place as though you read it. Prefer leaving places empty over guessing a name.',
  );

  const subject = options.isCarousel ? 'carousel' : 'reel';
  if (options.caption) {
    lines.push('', `Caption posted with the ${subject}:`, options.caption);
    lines.push('', 'Leave caption_from_frames empty: the caption is already known.');
  } else {
    lines.push(
      '',
      `This ${subject} has no caption stored. If the post caption is legible in any frame or slide,`,
      'return it verbatim in caption_from_frames; otherwise leave that empty.',
    );
  }
  if (options.permalink) lines.push('', `Source: ${options.permalink}`);

  return lines.join('\n');
}
