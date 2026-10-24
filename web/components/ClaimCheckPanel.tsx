'use client';

import { useEffect, useState } from 'react';
import { getClaimCheck, startClaimCheck, type ClaimCheck, type ClaimLabel, type ClaimVerdict } from '@/lib/api';

const POLL_MS = 3000;

const LABEL: Record<ClaimLabel, string> = {
  mostly_true: 'Mostly true',
  mixed: 'Mixed',
  mostly_hype: 'Mostly hype',
  cant_verify: "Can't verify",
};

const VERDICT: Record<ClaimVerdict, string> = {
  supported: 'Supported',
  partly_supported: 'Partly',
  disputed: 'Disputed',
  unverifiable: 'Unverified',
  not_checked: 'Not checked',
};

const SIGNAL: Record<string, string> = {
  absolute_language: 'Absolute language',
  urgency_or_scarcity: 'Urgency',
  miracle_promise: 'Miracle promise',
  unsupported_statistic: 'Unsupported number',
  undisclosed_promotion: 'Undisclosed ad',
  emotional_pressure: 'Emotional pressure',
  other: 'Other',
};

const KIND: Record<string, string> = { opinion: 'Opinion', promotional: 'Promotion' };

const REEL: Record<string, string> = {
  backed: 'Shown in the reel',
  inconsistent: 'Reel contradicts it',
  not_shown: 'Not shown',
};

const FLAG: Record<string, string> = {
  inconsistent_numbers: 'Numbers disagree',
  revenue_not_profit: 'Revenue, not profit',
  missing_proof: 'No proof',
  suspicious_detail: 'Gives it away',
  withheld_method: 'Method withheld',
  misleading_framing: 'Misleading framing',
};

/** A claim's chip: the web verdict, or what the reel shows when only the reel can speak to it. */
function chipFor(claim: { kind: string; basis: string; verdict: ClaimVerdict; reel_assessment?: string }) {
  if (claim.kind !== 'factual') return { text: KIND[claim.kind], cls: 'verdict-other' };
  if (claim.basis === 'reel') {
    const a = claim.reel_assessment ?? 'not_shown';
    return { text: REEL[a] ?? a, cls: a === 'backed' ? 'verdict-partly_supported' : a === 'inconsistent' ? 'verdict-disputed' : 'verdict-other' };
  }
  return { text: VERDICT[claim.verdict], cls: `verdict-${claim.verdict}` };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/**
 * Hype or true: the reel's claims, each searched on the web and judged only from
 * what came back, rolled into a score the user can take apart claim by claim.
 */
export default function ClaimCheckPanel(props: {
  mediaId: string;
  initial?: ClaimCheck;
  label: (tsMs: number) => string;
  onSeek: (tsMs: number) => void;
}) {
  const { mediaId, initial, label, onSeek } = props;
  const [check, setCheck] = useState<ClaimCheck | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(Boolean(initial?.report));

  useEffect(() => setCheck(initial ?? null), [initial]);

  useEffect(() => {
    if (check?.status !== 'working') return;
    const timer = setInterval(() => {
      getClaimCheck(mediaId)
        .then((r) => setCheck(r.check))
        .catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [check?.status, mediaId]);

  async function run(refresh: boolean) {
    setError(null);
    setOpen(true);
    try {
      setCheck((await startClaimCheck(mediaId, refresh)).check);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not start the check');
    }
  }

  const working = check?.status === 'working';
  const report = check?.report;

  return (
    <section className="claims">
      <div className="row claims-head">
        <h2>Hype or true?</h2>
        {!report && !working && (
          <button className="primary small" onClick={() => void run(false)}>
            Check the claims
          </button>
        )}
        {report && !working && (
          <button className="ghost small" onClick={() => void run(true)} title="Run the searches again">
            Re-check
          </button>
        )}
      </div>

      {working && (
        <p className="muted small" aria-live="polite">
          Checking: pulling out the claims, searching the web for each, then judging them against what came back.
          This takes about a minute.
        </p>
      )}
      {check?.status === 'failed' && <p className="error small">The check failed: {check.error ?? 'unknown error'}</p>}
      {error && <p className="error small">{error}</p>}

      {report && open && (
        <div className={`claims-report${working ? ' stale' : ''}`}>
          <div className={`claims-score label-${report.label}`}>
            <span className="claims-number">{report.score ?? '–'}</span>
            <div>
              <strong>{LABEL[report.label]}</strong>
              <p className="muted small">
                {report.score === null
                  ? 'Nothing could be checked against a source, and the reel shows little against itself.'
                  : (report.evidence_score === null
                      ? `Starts at a neutral ${report.base_score}: nothing could be checked on the web`
                      : `Evidence ${report.evidence_score}/100 across ${report.judged} checked claim${report.judged === 1 ? '' : 's'}`) +
                    (report.red_flag_penalty ? `, minus ${report.red_flag_penalty} for red flags` : '') +
                    (report.hype_penalty ? `, minus ${report.hype_penalty} for hype signals` : '') +
                    '.'}
              </p>
            </div>
          </div>
          <p>{report.summary}</p>

          {(report.red_flags ?? []).length > 0 && (
            <>
              <h2>What the reel shows against itself</h2>
              <ul className="claims-list">
                {report.red_flags.map((f, i) => (
                  <li key={i}>
                    <div className="row">
                      <span className="chip verdict-disputed">{FLAG[f.kind] ?? f.kind}</span>
                      {f.ts_ms.map((t) => (
                        <button key={t} className="evidence" onClick={() => onSeek(t)}>
                          <span className="muted">{label(t)}</span>
                        </button>
                      ))}
                    </div>
                    <p className="claims-text small">{f.finding}</p>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h2>Claims</h2>
          <ol className="claims-list">
            {report.claims.map((claim, i) => (
              <li key={i}>
                <div className="row">
                  <span className={`chip ${chipFor(claim).cls}`}>{chipFor(claim).text}</span>
                  {claim.basis === 'web' && claim.kind === 'factual' && <span className="muted small">web-checked</span>}
                  {claim.ts_ms !== undefined && (
                    <button className="evidence" onClick={() => onSeek(claim.ts_ms!)} title="jump to where it is said">
                      <span className="muted">{label(claim.ts_ms)}</span>
                    </button>
                  )}
                </div>
                <p className="claims-text">{claim.text}</p>
                <p className="muted small">{claim.basis === 'reel' && claim.reel_note ? claim.reel_note : claim.explanation}</p>
                {claim.basis === 'web' && claim.reel_note && <p className="muted small">In the reel: {claim.reel_note}</p>}
                {claim.sources.length > 0 && (
                  <p className="small claims-sources">
                    {claim.sources.map((s) => (
                      <a key={s.url} href={s.url} target="_blank" rel="noreferrer noopener" title={s.title}>
                        {hostOf(s.url)} ↗
                      </a>
                    ))}
                  </p>
                )}
              </li>
            ))}
          </ol>

          {report.hype_signals.length > 0 && (
            <>
              <h2>Hype signals</h2>
              <ul className="claims-list">
                {report.hype_signals.map((s, i) => (
                  <li key={i} className="row">
                    <span className="chip chip-guess">{SIGNAL[s.signal] ?? s.signal}</span>
                    {s.ts_ms !== undefined ? (
                      <button className="evidence" onClick={() => onSeek(s.ts_ms!)}>
                        <span className="muted">{label(s.ts_ms)}</span> “{s.quote}”
                      </button>
                    ) : (
                      <span className="small">“{s.quote}”</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {(report.plausible ?? []).length > 0 && (
            <>
              <h2>What is plausible</h2>
              <ul className="claims-list">
                {report.plausible.map((p, i) => (
                  <li key={i}>
                    <p className="claims-text small">{p.point}</p>
                    <p className="small claims-sources">
                      {p.sources.map((s) => (
                        <a key={s.url} href={s.url} target="_blank" rel="noreferrer noopener" title={s.title}>
                          {hostOf(s.url)} ↗
                        </a>
                      ))}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="muted small">
            Web verdicts come only from search results, never from the model&apos;s memory; a claim no result addresses
            counts as unverified, not false. Red flags come only from what the reel shows. A guide, not a ruling.
          </p>
        </div>
      )}
    </section>
  );
}
