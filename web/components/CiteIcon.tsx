/**
 * The mark on a cited moment.
 *
 * Two glyphs rather than one, because the distinction is real: a reel citation
 * points at a timestamp you can seek to, a carousel citation at a slide you can
 * turn to. The clip and the moment stay in the button's title, so the detail is
 * a hover away rather than thirty lines of repeated creator names.
 */
export default function CiteIcon({ slide }: { slide: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      {slide ? (
        // Stacked cards: a slide in a set.
        <>
          <rect x="4.5" y="2.5" width="9" height="9" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M11 13.5H4.2A1.7 1.7 0 0 1 2.5 11.8V5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </>
      ) : (
        // Play head: a moment in a timeline.
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M6.6 5.4 11 8l-4.4 2.6z" fill="currentColor" />
        </>
      )}
    </svg>
  );
}
