'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { momentLabel, type Frame, type Media } from '@/lib/api';

/**
 * A keyframe at full size, opened from the filmstrip.
 *
 * The strip shows the small copies; the full keyframe (up to 1280px) loads here,
 * only for frames actually opened. Arrow keys or the buttons step through the
 * frames, Escape or the backdrop closes it, and the video is left alone.
 */
export default function FrameViewer(props: {
  media: Media;
  frames: Frame[];
  index: number;
  onClose: () => void;
  onFindSimilar: (tsMs: number) => void;
}) {
  const { media, frames, onClose, onFindSimilar } = props;
  const [current, setCurrent] = useState(props.index);
  const closeButton = useRef<HTMLButtonElement>(null);
  const frame = frames[current];

  const step = useCallback(
    (by: number) => setCurrent((i) => Math.min(frames.length - 1, Math.max(0, i + by))),
    [frames.length],
  );

  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose, step]);

  if (!frame) return null;
  const label = momentLabel(media, frame.ts_ms);

  return (
    <div className="sheet-backdrop viewer-backdrop" onClick={onClose}>
      <div
        className="card viewer"
        role="dialog"
        aria-modal="true"
        aria-label={`Frame at ${label}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <h2>
            {label} <span className="muted small">· {current + 1} of {frames.length}</span>
          </h2>
          <button ref={closeButton} className="ghost small" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className="viewer-stage">
          <button className="ghost viewer-nav" onClick={() => step(-1)} disabled={current === 0} aria-label="Previous frame">
            ‹
          </button>
          {frame.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={frame.ts_ms}
              src={frame.url}
              alt={frame.description ?? `frame at ${label}`}
              // The small copy is already in the cache from the strip: it shows at once
              // and the full frame replaces it when it arrives.
              style={frame.thumb_url ? { backgroundImage: `url("${frame.thumb_url}")` } : undefined}
            />
          ) : (
            <p className="muted">No image stored for this frame.</p>
          )}
          <button
            className="ghost viewer-nav"
            onClick={() => step(1)}
            disabled={current === frames.length - 1}
            aria-label="Next frame"
          >
            ›
          </button>
        </div>

        {frame.description && <p>{frame.description}</p>}
        {frame.ocr_text && (
          <>
            <h2>Text in frame</h2>
            <pre className="small">{frame.ocr_text}</pre>
          </>
        )}
        <button className="ghost small" onClick={() => onFindSimilar(frame.ts_ms)}>
          Find similar frames
        </button>
      </div>
    </div>
  );
}
