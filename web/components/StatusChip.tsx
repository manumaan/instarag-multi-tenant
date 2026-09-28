import type { Media, MediaStatus } from '@/lib/api';

const LABELS: Record<MediaStatus, string> = {
  awaiting_upload: 'uploading',
  queued: 'queued',
  downloading: 'downloading',
  extracting: 'extracting',
  analysing: 'analysing',
  indexing: 'indexing',
  ready: 'ready',
  failed: 'failed',
};

export default function StatusChip({ media }: { media: Pick<Media, 'status' | 'source'> }) {
  return <span className={`chip chip-${media.status}`}>{LABELS[media.status] ?? media.status}</span>;
}
