// Situations on Home (Loop Intelligence Phase F). A server component over `SituationsRead`: each open
// situation's title and narrative, whose it is ("Only you" for a private one), how it was checked, and --
// on demand -- the claims with what an independent reader made of each. Readings are labelled as
// readings; causation is never shown because it is never allowed to be written.

import type { SituationView } from '@emgloop/database';
import type { TimeView } from '@emgloop/shared';

import type { SituationsRead } from './situations';

const VERIFICATION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  VERIFIED: 'Independently checked: every claim supported',
  PARTIAL: 'Independently checked: some claims supported',
  NOT_VERIFIED: 'Not independently checked this time',
  UNAVAILABLE: 'No independent check is available',
  DISPUTED: 'An independent check did not support it',
});

const VERDICT_WORDS: Readonly<Record<string, string>> = Object.freeze({ SUPPORTED: 'Supported', UNSUPPORTED: 'Not supported', UNCLEAR: 'Unclear' });

function SituationEntry({ s, time, href }: { s: SituationView; time: TimeView; href: string | null }) {
  const r = s.record;
  return (
    <li className="loop-chats__entry" data-situation-visibility={s.visibility} data-situation-verification={r?.verification.state ?? 'NONE'}>
      <div className="loop-chats__conv-head">
        <span className="loop-chats__label">{href ? <a href={href}>{s.title}</a> : s.title}</span>
        {s.visibility === 'PRINCIPAL' ? <span className="loop-pill">Only you</span> : null}
        {s.severity === 'HIGH' ? <span className="loop-pill loop-pill--attention">Pressing</span> : null}
      </div>
      {s.summary ? <p className="loop-chats__title">{s.summary}</p> : null}
      <p className="loop-chats__meta">
        Loop’s reading across {r ? r.domains.length : 0} parts of the business · {r ? VERIFICATION_WORDS[r.verification.state] ?? '' : ''} · seen{' '}
        <time dateTime={time.iso(s.lastDetectedAt)}>{time.relative(s.lastDetectedAt)}</time>
      </p>
      {r && r.claims.length > 0 ? (
        <details className="loop-chats__meta">
          <summary>What it rests on</summary>
          <ul>
            {r.claims.map((c, i) => (
              <li key={i} data-claim-verdict={c.verdict ?? 'NONE'}>
                {c.statement}
                {c.verdict ? ` (${VERDICT_WORDS[c.verdict]})` : ''}
              </li>
            ))}
          </ul>
          {r.limitations.length > 0 ? <p>What Loop could not see or conclude: {r.limitations.join('; ')}</p> : null}
        </details>
      ) : null}
    </li>
  );
}

export function SituationsPanel({ read, time, caseHref }: { read: SituationsRead; time: TimeView; caseHref: ((id: string) => string) | null }) {
  const org = read.organization ?? [];
  if (read.personal.length === 0 && org.length === 0) return null;
  return (
    <section className="loop-panel" aria-label="Situations" data-situations>
      <h2 className="loop-panel__title">Situations</h2>
      <p className="loop-panel__lead">Where Loop found signals from different parts of the business about the same records at the same time.</p>
      <ul className="loop-chats__list">
        {read.personal.map((s) => (
          <SituationEntry key={s.id} s={s} time={time} href={null} />
        ))}
        {org.map((s) => (
          <SituationEntry key={s.id} s={s} time={time} href={caseHref ? caseHref(s.id) : null} />
        ))}
      </ul>
    </section>
  );
}

/** A situation Case's record on the Case page: what it connects, and how each claim was checked. */
export function SituationRecordSection({ view, time }: { view: SituationView; time: TimeView }) {
  const r = view.record;
  if (!r) return null;
  return (
    <section className="cw-sec" aria-label="What Loop connected" data-situation-record>
      <h2 className="cw-sec__title">What Loop connected</h2>
      <p>{r.narrative}</p>
      <p className="loop-chats__meta">
        Across {r.domains.join(', ').toLowerCase()} · {VERIFICATION_WORDS[r.verification.state] ?? ''} · between{' '}
        <time dateTime={r.windowStart}>{time.date(new Date(r.windowStart))}</time> and <time dateTime={r.windowEnd}>{time.date(new Date(r.windowEnd))}</time>
      </p>
      <ul>
        {r.claims.map((c, i) => (
          <li key={i} data-claim-verdict={c.verdict ?? 'NONE'}>
            {c.statement}
            {c.verdict ? ` (${VERDICT_WORDS[c.verdict]})` : ''}
          </li>
        ))}
      </ul>
      {r.limitations.length > 0 ? <p className="loop-chats__meta">What Loop could not see or conclude: {r.limitations.join('; ')}</p> : null}
      <p className="loop-chats__meta">This is Loop’s reading of signals that occurred together. It does not say that one caused another.</p>
    </section>
  );
}
