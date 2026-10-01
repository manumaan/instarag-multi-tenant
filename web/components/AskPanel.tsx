'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import CiteIcon from '@/components/CiteIcon';
import { frameKey, framePictures } from '@/lib/frames';
import { sharePlanPdf } from '@/lib/pdf';
import {
  ask,
  getThread,
  looksLikePlan,
  isSlideshow,
  sourceLabel,
  startPlan,
  warmSearch,
  type AskAnswer,
  type Citation,
  type Plan,
  type Source,
} from '@/lib/api';

type Mode = 'answer' | 'plan';

interface Turn {
  question: string;
  mode: Mode;
  answer?: AskAnswer;
  plan?: Plan;
  /** Plans only, while the worker is still building. */
  building?: boolean;
  sources?: Source[];
  unsupported?: boolean;
  error?: string;
  /** frameKey → keyframe URL for every cited moment, once fetched. */
  pictures?: Map<string, string>;
  /** Where the plan's message lives, so its stored PDF can be found. */
  planAt?: { threadId: string; messageAt: string };
}

/** A plan takes about a minute; give up well after that rather than forever. */
const POLL_MS = 3000;
const POLL_LIMIT = 80;

/**
 * Ask, scoped to one reel when `mediaId` is given or to the whole library
 * otherwise. Citations are the point: `onCite` lets the reel detail screen
 * seek its player, and the library view links out to the reel instead.
 *
 * Two modes. An answer pins one fact and cites it. A plan is built out of the
 * whole library — "a travel plan for Istanbul with all the tips" — which needs
 * far more of the index, so it is built in the background and polled for.
 */
export default function AskPanel({
  mediaId,
  onCite,
  renderCitation,
  label,
}: {
  mediaId?: string;
  onCite?: (citation: Citation) => void;
  renderCitation?: (citation: Citation, label: string) => React.ReactNode;
  /** A carousel cites slides, not seconds. */
  label?: (citation: Citation) => string;
}) {
  const [question, setQuestion] = useState('');
  const [forcedMode, setForcedMode] = useState<Mode | undefined>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<number | undefined>();
  const [sharing, setSharing] = useState<number | undefined>();
  const [shareNote, setShareNote] = useState<{ index: number; text: string } | undefined>();
  const router = useRouter();

  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  /*
   * The index sleeps after ten idle minutes and takes tens of seconds to come
   * back — longer than the API waits. Focusing the box starts that wake-up, so
   * it happens while the question is being typed instead of after it is sent.
   * Throttled, because a wake lasts about ten minutes and re-poking a live
   * collection only keeps meters running.
   */
  const warmedAt = useRef(0);
  const warm = () => {
    const now = Date.now();
    if (now - warmedAt.current < 5 * 60 * 1000) return;
    warmedAt.current = now;
    void warmSearch().catch(() => {
      // Best effort. Let the question report anything genuinely wrong.
      warmedAt.current = 0;
    });
  };

  // Wake the index as soon as the panel is on screen — on a reel's page the
  // reel is usually watched first, which covers most of the warm-up. Focusing
  // the box alone left too little time before the API's 30s ceiling.
  useEffect(() => {
    warm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const detected: Mode = looksLikePlan(question) ? 'plan' : 'answer';
  const mode: Mode = forcedMode ?? detected;

  const update = (patch: Partial<Turn>) =>
    setTurns((prev) => prev.map((turn, i) => (i === prev.length - 1 ? { ...turn, ...patch } : turn)));

  /**
   * Pictures arrive after the text, so a turn is addressed by its index, not
   * as "the last one" — another question may have been asked by then.
   */
  const withPictures = (index: number, citations: Citation[]) => {
    if (citations.length === 0) return;
    void framePictures(citations).then((pictures) => {
      if (live.current) setTurns((prev) => prev.map((turn, i) => (i === index ? { ...turn, pictures } : turn)));
    });
  };

  /**
   * A picture opens its moment: the reel screen seeks its own player, and the
   * library view goes to the reel at that point.
   */
  const openCitation = (citation: Citation) => {
    if (onCite) onCite(citation);
    else router.push(`/media?id=${encodeURIComponent(citation.media_id)}&t=${citation.ts_ms}`);
  };

  /** The plan lands on the thread's assistant message, so watch that. */
  async function waitForPlan(id: string, messageAt: string, index: number) {
    for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (!live.current) return;
      const thread = await getThread(id);
      const message = thread.messages.find((m) => m.created_at === messageAt);
      if (!message || message.status === 'working') continue;

      if (message.status === 'failed') {
        update({ building: false, error: message.error ?? 'the plan could not be built' });
        return;
      }
      update({
        building: false,
        plan: message.plan,
        sources: message.sources,
        unsupported: message.status === 'unsupported',
      });
      withPictures(index, message.plan?.sections.flatMap((s) => s.items.flatMap((item) => item.citations)) ?? []);
      return;
    }
    update({ building: false, error: 'the plan is taking longer than expected — try again' });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const asked = question.trim();
    if (!asked || busy) return;

    const asking = mode;
    const index = turns.length;
    setQuestion('');
    setForcedMode(undefined);
    setBusy(true);
    setTurns((prev) => [...prev, { question: asked, mode: asking, building: asking === 'plan' }]);

    try {
      if (asking === 'plan') {
        const started = await startPlan(asked, { mediaId, threadId });
        setThreadId(started.threadId);
        update({ planAt: { threadId: started.threadId, messageAt: started.messageAt } });
        await waitForPlan(started.threadId, started.messageAt, index);
      } else {
        const answer = await ask(asked, { mediaId, threadId });
        setThreadId(answer.threadId ?? undefined);
        update({ answer });
        withPictures(index, answer.citations);
      }
    } catch (err) {
      update({ building: false, error: err instanceof Error ? err.message : 'the question failed' });
    } finally {
      if (live.current) setBusy(false);
    }
  }

  const itemCount = (plan: Plan) => plan.sections.reduce((n, section) => n + section.items.length, 0);

  /**
   * The creator's own name, before the tail of self-description Instagram
   * handles carry — "Katherine 🇹🇷 Istanbul trip planner · travel tips ·
   * itineraries". They separate it with a pipe, a middot or a bullet depending
   * on the account, so all three are cut, and what is left is capped: these sit
   * in a pill next to a timestamp, not on a line of their own.
   */
  const creator = (source: Source) => {
    const name = (source.uploader ?? '').split(/[|·•]/)[0].trim();
    if (!name) return source.media_id.slice(0, 8);
    return name.length > 22 ? `${name.slice(0, 21)}…` : name;
  };

  /** One chip per creator, not per clip: two clips by the same person read as a repeat. */
  const distinctCreators = (sources: Source[] | undefined) => {
    const seen = new Map<string, Source>();
    for (const source of sources ?? []) if (!seen.has(creator(source))) seen.set(creator(source), source);
    return [...seen.entries()];
  };

  /**
   * A travel plan is something you paste somewhere else, so it copies as plain
   * text. Clipboard writes are refused in some app views, so the failure is
   * silent rather than a broken-looking button.
   */
  async function copyPlan(plan: Plan, index: number) {
    const lines = [plan.title, '', plan.overview];
    for (const section of plan.sections) {
      lines.push('', section.heading.toUpperCase());
      for (const item of section.items) lines.push(`- ${item.text}`);
    }
    if (plan.gaps.length > 0) {
      lines.push('', "NOT COVERED BY YOUR CLIPS");
      for (const gap of plan.gaps) lines.push(`- ${gap}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(index);
      setTimeout(() => setCopied(undefined), 2000);
    } catch {
      // Nothing to do: the text is on screen and selectable.
    }
  }

  /** Builds the PDF and hands it to the system share sheet, or downloads it. */
  async function sharePlan(turn: Turn, index: number) {
    if (!turn.plan || sharing !== undefined) return;
    setSharing(index);
    setShareNote(undefined);
    try {
      const { how, missingPictures } = await sharePlanPdf(
        turn.plan,
        turn.sources ?? [],
        turn.pictures ?? new Map(),
        turn.planAt,
      );
      const notes = [
        how === 'downloaded' ? 'Downloaded — attach it to a message to send it.' : '',
        missingPictures > 0 ? `${missingPictures} picture${missingPictures === 1 ? '' : 's'} could not be included.` : '',
      ].filter(Boolean);
      if (notes.length) setShareNote({ index, text: notes.join(' ') });
    } catch (err) {
      setShareNote({ index, text: err instanceof Error ? `Could not make the PDF: ${err.message}` : 'Could not make the PDF.' });
    } finally {
      if (live.current) setSharing(undefined);
    }
  }

  /** The keyframe a citation points at, as a button that opens that moment. */
  const picture = (citation: Citation | undefined, turn: Turn, className: string) => {
    if (!citation) return <span className={`${className} empty`} />;
    const url = turn.pictures?.get(frameKey(citation));
    const source = turn.sources?.find((s) => s.media_id === citation.media_id) ??
      turn.answer?.sources?.find((s) => s.media_id === citation.media_id);
    const text = label ? label(citation) : sourceLabel(source, citation.ts_ms);
    return (
      <button type="button" className={className} title={text} aria-label={`Open ${text}`} onClick={() => openCitation(citation)}>
        {/* CORS mode, so the cached copy is one the PDF export may also read. */}
        {url ? <img src={url} alt="" loading="lazy" crossOrigin="anonymous" /> : null}
      </button>
    );
  };

  /**
   * A citation is a mark, not a sentence. Thirty tips each naming their clip and
   * timestamp in full buried the advice under its own provenance, so the label
   * moved to the title and the button carries an icon.
   */
  const citationChip = (citation: Citation, sources: Source[] | undefined, key: number) => {
    const source = sources?.find((s) => s.media_id === citation.media_id);
    const text = label ? label(citation) : sourceLabel(source, citation.ts_ms);
    if (renderCitation) return <span key={key}>{renderCitation(citation, text)}</span>;
    return (
      <button key={key} className="cite-icon" title={text} aria-label={text} onClick={() => onCite?.(citation)}>
        <CiteIcon slide={isSlideshow({ type: source?.type ?? 'reel', slide_count: source?.slide_count })} />
      </button>
    );
  };

  return (
    <section className="ask">
      <h2>Ask</h2>

      {turns.length === 0 && (
        <p className="muted small">
          {mediaId
            ? 'Ask about this reel — "which cafe is shown here?"'
            : 'Ask a question, or ask for something built from everything you have saved — "create me a travel plan for Istanbul with all the tips".'}
        </p>
      )}

      <div className="turns">
        {turns.map((turn, i) => (
          <div key={i} className="turn">
            <p className="question">
              {turn.mode === 'plan' && <span className="mode-tag">Plan</span>}
              {turn.question}
            </p>
            {turn.error && <p className="error small">{turn.error}</p>}

            {turn.building && (
              <p className="plan-building">
                Reading across your library and writing it up. This takes about a minute.
              </p>
            )}

            {turn.answer && (
              <>
                <p className={turn.answer.answered ? undefined : 'muted'}>{turn.answer.answer}</p>
                {turn.pictures && turn.answer.citations.length > 0 && (
                  <div className="cite-pictures">
                    {turn.answer.citations
                      .filter((c, j, all) => all.findIndex((d) => frameKey(d) === frameKey(c)) === j)
                      .map((citation) => (
                        <span key={frameKey(citation)}>{picture(citation, turn, 'cite-picture')}</span>
                      ))}
                  </div>
                )}
                {turn.answer.citations.length > 0 && (
                  <div className="citations">
                    {turn.answer.citations.map((citation, j) =>
                      citationChip(citation, turn.answer?.sources, j),
                    )}
                  </div>
                )}
                {!turn.answer.answered && (
                  <p className="muted small">Not supported by what has been indexed.</p>
                )}
              </>
            )}

            {turn.plan && (
              <article className="plan">
                <header className="plan-head">
                  <h3>{turn.plan.title}</h3>
                  <p className="plan-subtitle">Curated by Reel Lens app</p>
                  <p className="plan-lede">{turn.plan.overview}</p>

                  {turn.plan.sections.length > 0 && (
                    <div className="plan-meta">
                      <span className="count">
                        {turn.plan.sections.length} sections · {itemCount(turn.plan)} tips
                      </span>
                      {turn.sources && turn.sources.length > 0 && (
                        <span className="plan-from">
                          <span className="label">from</span>
                          {distinctCreators(turn.sources).map(([name]) => (
                            <span key={name} className="cite">
                              {name}
                            </span>
                          ))}
                        </span>
                      )}
                      <span className="spacer" />
                      <button className="btn small" onClick={() => copyPlan(turn.plan!, i)}>
                        {copied === i ? 'Copied' : 'Copy'}
                      </button>
                      <button
                        className="btn small primary"
                        onClick={() => void sharePlan(turn, i)}
                        disabled={sharing !== undefined}
                      >
                        {sharing === i ? 'Preparing…' : 'Share PDF'}
                      </button>
                    </div>
                  )}
                  {shareNote?.index === i && <p className="muted small">{shareNote.text}</p>}
                </header>

                {turn.plan.sections.map((section, s) => (
                  <section key={s} className="plan-section">
                    <h4>
                      {section.heading}
                      <span className="n">{section.items.length}</span>
                    </h4>
                    <ul className="plan-items">
                      {section.items.map((item, k) => (
                        <li key={k} className="with-picture">
                          {picture(item.citations[0], turn, 'item-picture')}
                          <p>{item.text}</p>
                          <span className="cites">
                            {item.citations.map((citation, j) => citationChip(citation, turn.sources, j))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}

                {turn.unsupported && (
                  <p className="muted small">
                    Nothing in your library covers this, so there is nothing to build from.
                  </p>
                )}

                {turn.plan.gaps.length > 0 && (
                  <div className="plan-gaps">
                    <h4>Your clips don&apos;t cover</h4>
                    <ul>
                      {turn.plan.gaps.map((gap, g) => (
                        <li key={g}>{gap}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {turn.plan.moments !== undefined && turn.plan.sections.length > 0 && (
                  <p className="plan-foot">
                    Built from {turn.plan.moments} moments across your library
                    {turn.plan.itemsDropped
                      ? `, after dropping ${turn.plan.itemsDropped} the clips did not support`
                      : ''}
                    .
                  </p>
                )}
              </article>
            )}

            {!turn.answer && !turn.plan && !turn.error && !turn.building && (
              <p className="muted small">Thinking…</p>
            )}
          </div>
        ))}
      </div>

      <form className="url-form" onSubmit={submit}>
        <input
          type="text"
          placeholder={mediaId ? 'Ask about this reel…' : 'Ask, or ask for a plan…'}
          value={question}
          onFocus={warm}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={busy}
        />
        <button className="primary" type="submit" disabled={busy || !question.trim()}>
          {mode === 'plan' ? 'Build' : 'Ask'}
        </button>
      </form>

      {question.trim() && (
        <p className="muted small mode-hint">
          {mode === 'plan'
            ? 'Building this from your whole library.'
            : 'Answering from the closest moments.'}{' '}
          <button
            type="button"
            className="linkish"
            onClick={() => setForcedMode(mode === 'plan' ? 'answer' : 'plan')}
          >
            {mode === 'plan' ? 'Just answer it instead' : 'Build it from everything instead'}
          </button>
        </p>
      )}
    </section>
  );
}
