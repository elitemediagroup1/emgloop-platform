// The executive layer: Today's Brief and Top Priorities.
//
// THE BRIEF is the health band with a few words of reason, then at most two short
// sentences -- what materially changed, and what to review first -- within 45 words.
// The money, where revenue sits, the health model's own words and what is not known
// are behind "View details", each with its basis (measured, arithmetic, Loop's
// reading, not known). No sentence names a cause.
//
// TOP PRIORITIES are at most three undecided Situations, in the order the engine
// already ranked them, each with its kind, why it matters and the suggested next
// action. Everything else Loop detected is one click away in Intelligence -- never
// on this screen as a count to be worked through.

import Link from 'next/link';

import { BRIEF_BASIS_LABELS, HEALTH_BAND_LABEL, type CallGridBrief } from '@emgloop/shared';

import type { TopPriority } from './executive-data';
import { clock } from './command-ui';

const BAND_TONE: Record<string, string> = { HEALTHY: 'good', WATCH: 'warn', RISK: 'crit', CRITICAL: 'crit', UNKNOWN: 'neutral' };

export function TodaysBrief({
  brief, title, analyzedAt, detailsHref,
}: {
  brief: CallGridBrief;
  title: string;
  analyzedAt: Date;
  detailsHref: string;
}) {
  return (
    <section className="cgx-brief" aria-label={title}>
      <header className="cgx-brief__head">
        <h2 className="cgx-brief__title">
          <span className="cgx-brief__spark" aria-hidden="true">✦</span> {title}
        </h2>
        <p className="cgx-brief__meta">Loop analysis · {clock(analyzedAt)}</p>
      </header>
      <div className={`cgx-health cgx-health--${BAND_TONE[brief.band] ?? 'neutral'}`}>
        <p className="cgx-health__text">
          Business health: <strong className="cgx-health__band">{HEALTH_BAND_LABEL[brief.band]}</strong>
          {brief.reason ? <span className="cgx-health__reason"> — {brief.reason}.</span> : null}
        </p>
      </div>
      {brief.sentences.length > 0 ? <p className="cgx-brief__text">{brief.sentences.map((s) => s.text).join(' ')}</p> : null}
      <details className="cgx-brief__details">
        <summary className="cgx-brief__more">View details</summary>
        <ul className="cgx-brief__basis">
          {[...brief.sentences, ...brief.details].map((s, i) => (
            <li key={i} className="cgx-basis">
              <span className={`cgx-basis__tag cgx-basis__tag--${s.basis.toLowerCase()}`}>{BRIEF_BASIS_LABELS[s.basis]}</span>
              <span className="cgx-basis__text">{s.text}</span>
              {s.detail ? <span className="cgx-basis__detail">{s.detail}</span> : null}
            </li>
          ))}
        </ul>
        <p className="cgx-brief__foot">
          Nothing here is a model’s summary: each sentence is assembled from measured figures and Loop’s health model. <Link href={detailsHref}>The evidence, the limits and every finding →</Link>
        </p>
      </details>
    </section>
  );
}

const KIND_TONE: Record<string, string> = { RISK: 'crit', OPPORTUNITY: 'good', NEEDS_INVESTIGATION: 'warn', WATCH: 'neutral' };

export function TopPriorities({
  priorities, allHref, emptyLine, unavailable,
}: {
  priorities: readonly TopPriority[];
  allHref: string;
  emptyLine: string;
  unavailable: string | null;
}) {
  return (
    <section className="cgx-prio" aria-label="Top priorities">
      <header className="cgx-prio__head">
        <h2 className="cgx-prio__title">Top priorities</h2>
        <Link href={allHref} className="cgx-card__action">View all intelligence →</Link>
      </header>
      {unavailable ? <p className="cgx-note">{unavailable}</p> : null}
      {priorities.length === 0 ? (
        <p className="cgx-empty">{emptyLine}</p>
      ) : (
        <ol className="cgx-prio__list">
          {priorities.map((p, i) => (
            <li key={p.key} className="cgx-prio__item">
              <span className={`cgx-prio__rank cgx-prio__rank--${KIND_TONE[p.kind]}`} aria-hidden="true">{i + 1}</span>
              <div className="cgx-prio__body">
                <p className="cgx-prio__line">
                  <span className="cgx-prio__name">{p.title}</span>
                  <span className={`loop-pill loop-pill--${KIND_TONE[p.kind] === 'crit' ? 'critical' : KIND_TONE[p.kind] === 'good' ? 'good' : KIND_TONE[p.kind] === 'warn' ? 'attention' : 'neutral'} cgx-prio__kind`}>{p.kindLabel}</span>
                </p>
                <p className="cgx-prio__why">{p.explanation}</p>
                {p.action ? <p className="cgx-prio__action">{p.action}</p> : null}
              </div>
              <Link href={p.href} className="loop-btn cgx-prio__open">Review</Link>
            </li>
          ))}
        </ol>
      )}
      <p className="cgx-prio__rest">
        The rest of what Loop found — undecided, assigned, watched and closed — is in <Link href={allHref}>Intelligence</Link>.
      </p>
    </section>
  );
}
