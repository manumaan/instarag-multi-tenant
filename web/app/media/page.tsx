'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import StatusChip from '@/components/StatusChip';
import AskPanel from '@/components/AskPanel';
import LensSheet from '@/components/LensSheet';
import { getMedia, isSlideshow, momentLabel, retryMedia, type MediaDetail } from '@/lib/api';
import { subscribeToMedia } from '@/lib/ws';

const IN_FLIGHT = ['awaiting_upload', 'queued', 'downloading', 'extracting', 'analysing', 'indexing'];
/** Safety net only: the WebSocket carries status changes. */
const POLL_MS = 30_000;

/** Reel detail: player, keyframe filmstrip, caption panel with copy actions. */
function ReelDetail() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id') ?? '';
  const [detail, setDetail] = useState<MediaDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [seekTo, setSeekTo] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [lensFrame, setLensFrame] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);

  // A citation from library-wide Ask arrives as ?t=<ms>.
  useEffect(() => {
    const t = Number(searchParams.get('t'));
    if (Number.isFinite(t) && t > 0) {
      setSeekTo(t);
      setSelected(t);
    }
  }, [searchParams]);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      setDetail(await getMedia(id));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not load this reel');
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A status change here means new frames and presigned URLs, so refetch.
  useEffect(() => subscribeToMedia(({ media }) => media.id === id && void refresh()), [id, refresh]);

  useEffect(() => {
    if (!detail || !IN_FLIGHT.includes(detail.media.status)) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [detail, refresh]);

  async function copy(label: string, text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }

  if (error) {
    return (
      <main className="page">
        <Link href="/" className="back">
          ← Library
        </Link>
        <p className="error">{error}</p>
      </main>
    );
  }
  if (!detail) {
    return (
      <main className="page">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const { media, frames, transcriptSegments, playbackUrl } = detail;
  const caption = media.caption_normalized ?? media.caption_raw;
  const hashtags = caption?.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  const isCarousel = isSlideshow(media);
  const isVideo = media.content_type?.startsWith('video/') && !isCarousel;
  const selectedFrame = frames.find((f) => f.ts_ms === selected);

  return (
    <main className="page detail">
      <Link href="/" className="back">
        ← Library
      </Link>

      <div className="detail-grid">
        <section className="card player">
          <div className="player-head">
            <StatusChip media={media} />
            <span className="muted small">{media.type}</span>
            {media.uploader && <span className="muted small">@{media.uploader}</span>}
          </div>

          {isCarousel ? (
            <div className="slides">
              {selectedFrame?.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={selectedFrame.url} alt={selectedFrame.description ?? 'slide'} />
              ) : frames[0]?.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={frames[0].url} alt={frames[0].description ?? 'first slide'} />
              ) : (
                <div className="placeholder">
                  <p className="muted">
                    {IN_FLIGHT.includes(media.status) ? 'Working…' : 'No slides were stored.'}
                  </p>
                </div>
              )}
              <p className="muted small">
                {media.slide_count ?? frames.length} slide
                {(media.slide_count ?? frames.length) === 1 ? '' : 's'} — pick one below
              </p>
            </div>
          ) : playbackUrl && isVideo ? (
            <video
              controls
              src={playbackUrl}
              onLoadedMetadata={(e) => {
                if (seekTo !== null) e.currentTarget.currentTime = seekTo / 1000;
              }}
              ref={(el) => {
                if (el && seekTo !== null) el.currentTime = seekTo / 1000;
              }}
            />
          ) : playbackUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={playbackUrl} alt={media.original_filename ?? 'uploaded media'} />
          ) : media.permalink ? (
            <div className="placeholder">
              <p className="muted">
                {IN_FLIGHT.includes(media.status) ? 'Fetching this reel…' : 'No local copy of this reel.'}
              </p>
              <a href={media.permalink} target="_blank" rel="noreferrer noopener">
                Open on Instagram ↗
              </a>
            </div>
          ) : (
            <div className="placeholder">
              <p className="muted">No playable media yet.</p>
            </div>
          )}

          {media.analysis_summary && (
            <div className="summary">
              <h2>What happens</h2>
              <p>{media.analysis_summary}</p>
            </div>
          )}

          <div className="filmstrip">
            {frames.length === 0 ? (
              <p className="muted small">
                {IN_FLIGHT.includes(media.status)
                  ? 'Extracting keyframes…'
                  : 'No keyframes were extracted.'}
              </p>
            ) : (
              frames.map((frame) => (
                <button
                  key={frame.ts_ms}
                  className={`frame${selected === frame.ts_ms ? ' selected' : ''}`}
                  onClick={() => {
                    setSeekTo(frame.ts_ms);
                    setSelected(frame.ts_ms);
                  }}
                  title={frame.description ?? undefined}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {frame.url && <img src={frame.url} alt={frame.description ?? `frame at ${frame.ts_ms}ms`} />}
                  <span className="small">{momentLabel(media, frame.ts_ms)}</span>
                </button>
              ))
            )}
          </div>
          {transcriptSegments.length > 0 && (
            <div className="transcript">
              <h2>
                Transcript{media.spoken_language ? ` · ${media.spoken_language}` : ''}
              </h2>
              <ol>
                {transcriptSegments.map((segment) => (
                  <li key={segment.start_ms}>
                    <button
                      className="evidence"
                      onClick={() => {
                        setSeekTo(segment.start_ms);
                        setSelected(null);
                      }}
                    >
                      <span className="muted">{(segment.start_ms / 1000).toFixed(1)}s</span> {segment.text}
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {selectedFrame && (
            <div className="frame-detail">
              <h2>{isCarousel ? momentLabel(media, selectedFrame.ts_ms) : `Frame at ${momentLabel(media, selectedFrame.ts_ms)}`}</h2>
              <p>{selectedFrame.description}</p>
              {selectedFrame.ocr_text && (
                <>
                  <h2>Text in frame</h2>
                  <pre className="small">{selectedFrame.ocr_text}</pre>
                </>
              )}
              <button className="ghost small" onClick={() => setLensFrame(selectedFrame.ts_ms)}>
                Find similar frames
              </button>
            </div>
          )}
        </section>

        <aside className="card caption-panel">
          <h2>Caption</h2>
          {caption ? (
            <>
              <pre className="caption">{caption}</pre>
              <div className="row">
                <button className="primary small" onClick={() => void copy('caption', caption)}>
                  Copy caption
                </button>
                <button
                  className="ghost small"
                  disabled={hashtags.length === 0}
                  onClick={() => void copy('hashtags', hashtags.join(' '))}
                >
                  Copy hashtags ({hashtags.length})
                </button>
              </div>
              {copied && <p className="muted small">Copied {copied}.</p>}
              {media.caption_source === 'frames' && (
                <p className="muted small">Read off the video — no caption metadata was available.</p>
              )}
            </>
          ) : (
            <p className="muted small">
              No caption yet. Captions come from the API in connected mode, or from reading the
              screenshot in drop-in mode — both land in a later phase.
            </p>
          )}

          {media.places && media.places.length > 0 && (
            <>
              <h2>Places</h2>
              <ul className="places">
                {media.places.map((place) => (
                  <li key={`${place.name}-${place.kind}`}>
                    <strong>{place.name}</strong>{' '}
                    <span className="muted small">{place.kind}</span>
                    {place.basis !== 'read_from_frame' && (
                      <span className="chip chip-guess" title="not read from the video">
                        {place.basis === 'from_caption' ? 'from caption' : 'inferred'}
                      </span>
                    )}
                    {place.evidence.map((evidence, i) => (
                      <button
                        key={i}
                        className="evidence"
                        onClick={() => {
                          setSeekTo(evidence.ts_ms);
                          setSelected(evidence.ts_ms);
                        }}
                        title={`jump to ${(evidence.ts_ms / 1000).toFixed(1)}s`}
                      >
                        <span className="muted">{momentLabel(media, evidence.ts_ms)}</span> “{evidence.text}”
                      </button>
                    ))}
                  </li>
                ))}
              </ul>
            </>
          )}

          <AskPanel
            mediaId={media.id}
            label={(citation) => momentLabel(media, citation.ts_ms)}
            onCite={(citation) => {
              setSeekTo(citation.ts_ms);
              setSelected(citation.ts_ms);
            }}
          />

          {media.status === 'failed' && (
            <>
              <h2>This reel failed</h2>
              {media.error && <pre className="small">{media.error.slice(0, 600)}</pre>}
              <button
                className="primary"
                disabled={retrying}
                onClick={() => {
                  setRetrying(true);
                  retryMedia(media.id)
                    .then(() => refresh())
                    .catch(() => undefined)
                    .finally(() => setRetrying(false));
                }}
              >
                {retrying ? 'Retrying…' : 'Retry'}
              </button>
            </>
          )}

          <h2>Details</h2>
          <dl className="meta">
            <dt>id</dt>
            <dd className="mono">{media.id}</dd>
            <dt>source</dt>
            <dd>{media.source}</dd>
            <dt>added</dt>
            <dd>{new Date(media.created_at).toLocaleString()}</dd>
            {media.bytes !== undefined && (
              <>
                <dt>size</dt>
                <dd>{(media.bytes / 1024 / 1024).toFixed(1)} MB</dd>
              </>
            )}
            {media.permalink && (
              <>
                <dt>permalink</dt>
                <dd>
                  <a href={media.permalink} target="_blank" rel="noreferrer noopener">
                    instagram.com ↗
                  </a>
                </dd>
              </>
            )}
          </dl>
        </aside>
      </div>

      {lensFrame !== null && (
        <LensSheet frame={{ mediaId: media.id, tsMs: lensFrame }} onClose={() => setLensFrame(null)} />
      )}
    </main>
  );
}

/** useSearchParams needs a boundary in a statically exported page. */
export default function ReelDetailPage() {
  return (
    <Suspense
      fallback={
        <main className="page">
          <p className="muted">Loading…</p>
        </main>
      }
    >
      <ReelDetail />
    </Suspense>
  );
}
