'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import DropZone from '@/components/DropZone';
import LensSheet from '@/components/LensSheet';
import StatusChip from '@/components/StatusChip';
import { deleteMedia, isSlideshow, listMedia, retryMedia, type Media } from '@/lib/api';
import { subscribeToMedia } from '@/lib/ws';

const IN_FLIGHT: Media['status'][] = [
  'awaiting_upload',
  'queued',
  'downloading',
  'extracting',
  'analysing',
  'indexing',
];

/**
 * Prefer something meaningful over the raw permalink: the uploader, or the
 * first sentence of what the reel turned out to be about.
 */
function title(media: Media): string {
  if (media.original_filename) return media.original_filename;
  if (media.uploader) return media.uploader;
  const summary = media.analysis_summary?.split(/(?<=[.!?])\s/)[0];
  if (summary) return summary.length > 90 ? `${summary.slice(0, 90)}…` : summary;
  return media.permalink ?? media.id.slice(0, 8);
}
/** Safety net only: the WebSocket carries status changes. */
const POLL_MS = 30_000;

/** Library: the grid of everything dropped in, newest first. */
export default function LibraryPage() {
  const [items, setItems] = useState<Media[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lensOpen, setLensOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const page = await listMedia();
      setItems(page.items);
      setCursor(page.cursor);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not load your library');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Pipeline pushes each status change; merge it into whatever is on screen.
  useEffect(() =>
    subscribeToMedia(({ media }) =>
      setItems((prev) => {
        const index = prev.findIndex((m) => m.id === media.id);
        if (index === -1) return [media, ...prev];
        const next = [...prev];
        next[index] = { ...next[index], ...media };
        return next;
      }),
    ),
  []);

  // Anything still in the pipeline means the grid could be stale if the socket dropped.
  useEffect(() => {
    if (!items.some((m) => IN_FLIGHT.includes(m.status))) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [items, refresh]);

  async function loadMore() {
    if (!cursor) return;
    const page = await listMedia(cursor);
    setItems((prev) => [...prev, ...page.items]);
    setCursor(page.cursor);
  }

  /**
   * Reels fail for reasons that pass: a rate limit clears, a codec gets fixed
   * by a deploy. Retrying re-runs the pipeline rather than just clearing the
   * error.
   */
  async function retry(id: string) {
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, status: 'queued', error: undefined } : m)));
    try {
      await retryMedia(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'retry failed');
    } finally {
      void refresh();
    }
  }

  async function remove(id: string) {
    setItems((prev) => prev.filter((m) => m.id !== id));
    try {
      await deleteMedia(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete failed');
      void refresh();
    }
  }

  return (
    <main className="page">
      <div className="row actions">
        <Link href="/ask" className="btn primary">
          Ask your library
        </Link>
        <button className="btn" onClick={() => setLensOpen(true)}>
          Search by screenshot
        </button>
      </div>
      {lensOpen && <LensSheet onClose={() => setLensOpen(false)} />}
      <DropZone onAdded={(media) => setItems((prev) => [media, ...prev.filter((m) => m.id !== media.id)])} />

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted">Loading your library…</p>
      ) : items.length === 0 ? (
        <p className="muted">Nothing here yet. Drop a reel above.</p>
      ) : (
        <>
          <div className="grid">
            {items.map((media) => (
              <article key={media.id} className="card tile">
                <Link href={`/media?id=${media.id}`} className="tile-body">
                  <div className="thumb">
                    {media.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={media.thumbnailUrl}
                        alt={media.analysis_summary ?? 'cover frame'}
                        loading="lazy"
                        // A reel still in the pipeline has no cover yet, and a
                        // presigned url can outlive its object.
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    ) : (
                      <span className="muted small">{IN_FLIGHT.includes(media.status) ? 'working…' : 'no cover'}</span>
                    )}
                    <StatusChip media={media} />
                  </div>
                  <h3>{title(media)}</h3>
                  {isSlideshow(media) && (
                    <p className="muted small">
                      {media.slide_count === 1 ? 'image post' : `carousel · ${media.slide_count ?? '?'} slides`}
                    </p>
                  )}
                  <p className="muted small">{new Date(media.created_at).toLocaleString()}</p>
                  {media.error && <p className="error small">{media.error}</p>}
                </Link>
                <div className="row">
                  {media.status === 'failed' && (
                    <button className="primary small" onClick={() => void retry(media.id)}>
                      Retry
                    </button>
                  )}
                  <button className="ghost small" onClick={() => void remove(media.id)} aria-label="Delete">
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
          {cursor && (
            <button className="ghost" onClick={() => void loadMore()}>
              Load more
            </button>
          )}
        </>
      )}
    </main>
  );
}
