// The depth view of a domain reading, for the domain's own page (Loop Intelligence Phases D-E). A server
// component over `DomainReadingView`: the same stored digest the Home tile projects, shown in full --
// the statement, how current it is, and every signal with what it rests on. Readings are labelled as
// readings; a MEASURED figure is shown as measured; nothing is shown that the digest does not hold.

import { intelligenceCoverageLabel, rankDomainSignals, type IntelligenceSignal, type TimeView } from '@emgloop/shared';

import { LabelBadge } from '../app/app/_loop-os/product-state';
import { Panel } from '../app/app/_loop-os/record';
import type { DomainReadingView } from './domain-reading';

const KNOWLEDGE: Readonly<Record<IntelligenceSignal['knowledge'], string>> = Object.freeze({
  OBSERVED: 'As the records show it',
  MEASURED: 'Measured by Loop',
  INFERRED: 'Loop’s reading',
});

const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  ATTENTION: 'Needs attention',
  OBLIGATION: 'Owed',
  RISK: 'Risk',
  DECISION_PENDING: 'Decision pending',
  STALLED: 'Stalled',
  UNRESOLVED: 'Open',
  UPCOMING: 'Coming up',
  OPPORTUNITY: 'Opportunity',
  CHANGE: 'Change',
  OPERATIONAL: 'Operational',
  QUIET: 'Quiet',
  RESOLVED: 'Resolved',
});

function metricWords(s: IntelligenceSignal): string | null {
  if (!s.metric) return null;
  const v = s.metric.unit === 'minor_currency' ? `$${(s.metric.value / 100).toFixed(2)}` : s.metric.unit === 'percent' ? `${s.metric.value}%` : String(s.metric.value);
  const b = s.metric.baseline === undefined ? '' : ` (was ${s.metric.unit === 'minor_currency' ? `$${(s.metric.baseline / 100).toFixed(2)}` : s.metric.unit === 'percent' ? `${s.metric.baseline}%` : s.metric.baseline})`;
  return `${v}${b}`;
}

export function DomainReadingPanel({ title, view, time, empty }: { title: string; view: DomainReadingView | null; time: TimeView; empty: string }) {
  if (view === null) return null;
  const p = view.projection;
  if (p.state === 'NONE' || !view.digest) {
    return (
      <Panel title={title} lead={empty}>
        <span />
      </Panel>
    );
  }
  const signals = rankDomainSignals(view.digest.content.signals ?? []);
  return (
    <Panel title={title} lead={p.statement ?? ''}>
      <p className="loop-panel__lead" data-domain-reading-state={p.state}>
        {p.coverage ? <LabelBadge label={intelligenceCoverageLabel(p.coverage)} /> : null}{' '}
        {p.asCurrent ? 'Read ' : 'As of '}
        {p.generatedAt ? <time dateTime={time.iso(p.generatedAt)}>{time.relative(p.generatedAt)}</time> : null}
      </p>
      {signals.length > 0 ? (
        <ul className="loop-chats__list" data-domain-reading-signals>
          {signals.map((s) => (
            <li key={s.key} className="loop-chats__entry" data-signal-kind={s.kind} data-signal-knowledge={s.knowledge}>
              <div className="loop-chats__conv-head">
                <span className="loop-chats__label">{KIND_WORDS[s.kind] ?? s.kind}</span>
                {s.severity === 'HIGH' ? <span className="loop-pill loop-pill--attention">Pressing</span> : null}
                {s.party ? <span className="loop-pill">{s.party}</span> : null}
              </div>
              <p className="loop-chats__title">{s.statement}</p>
              <p className="loop-chats__meta">
                {KNOWLEDGE[s.knowledge]}
                {metricWords(s) ? ` · ${metricWords(s)}` : ''}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      {(view.digest.content.limitations ?? []).length > 0 ? <p className="loop-chats__meta">What Loop could not see or conclude: {(view.digest.content.limitations ?? []).join('; ')}</p> : null}
    </Panel>
  );
}
