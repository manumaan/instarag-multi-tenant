'use client';

import Link from 'next/link';
import AskPanel from '@/components/AskPanel';
import CiteIcon from '@/components/CiteIcon';

/** Library-scoped Ask: citations link out to the reel they came from. */
export default function AskPage() {
  return (
    <main className="page">
      <Link href="/" className="back">
        ← Library
      </Link>
      <div className="card">
        <AskPanel
          renderCitation={(citation, label) => (
            <Link
              className="cite-icon"
              title={label}
              aria-label={label}
              href={`/media?id=${citation.media_id}&t=${citation.ts_ms}`}
            >
              <CiteIcon slide={label.startsWith('Slide') || label.includes('· Slide')} />
            </Link>
          )}
        />
      </div>
    </main>
  );
}
