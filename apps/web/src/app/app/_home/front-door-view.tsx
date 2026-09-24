import Link from 'next/link';
import type { ReactNode } from 'react';
import { counted, type AttentionAssessment, type HeadlineView, type TimeView } from '@emgloop/shared';
import { SidebarIcon } from '../../crm/_brand/SidebarIcon';
import { ActivityList, type ActivityEntry } from '../_loop-os/activity-item';
import { StateBadge } from '../_loop-os/product-state';
import { StateBlock } from '../_loop-os/record';
import type { ActivityItem } from '../admin/workspace-home-data';
import type { HeadlineCaseState } from './front-door-data';
import type { HomeKpiStrip } from './kpis';
import type { HomeTile } from './tiles';
import type { Settled } from './settle';
import { SourceUnavailable } from './briefing-view';

// Loop Home's front door, drawn (2026-09-24): the executive KPI row, the Headlines panel, recent
// activity, and the tools & spaces grid. Server components over the pure projections (kpis.ts,
// tiles.ts) and the authorities' own read models. Presentation only -- nothing here loads, decides
// or widens anything. A figure Loop does not have is a word; a domain that is not connected or could
// not be read says so; a link exists only where a page does.

// --- Executive KPIs ----------------------------------------------------------------------------------

const CHANGE_ARROW: Readonly<Record<'up' | 'down' | 'flat', string>> = Object.freeze({ up: '↑', down: '↓', flat: '→' });

export function KpiStrip({ strip }: { strip: Settled<HomeKpiStrip> | null }) {
  if (strip === null) return null;
  const head = (sub: ReactNode) => (
    <div className="loop-brief__head">
      <h2 className="loop-panel__title">Executive KPIs</h2>
      {sub}
    </div>
  );
  if (!strip.ok || strip.value.state === 'UNAVAILABLE') {
    return (
      <section className="loop-front__kpis" aria-label="Executive KPIs" id="executive-kpis" data-home-kpis="UNAVAILABLE">
        {head(null)}
        <SourceUnavailable what="CallGrid" />
      </section>
    );
  }
  const s = strip.value;
  if (s.state === 'NO_DATA') {
    return (
      <section className="loop-front__kpis" aria-label="Executive KPIs" id="executive-kpis" data-home-kpis="NO_DATA">
        {head(null)}
        <StateBlock kind="empty" compact title={s.freshness.word} body={s.freshness.detail} />
      </section>
    );
  }
  return (
    <section className="loop-front__kpis" aria-label="Executive KPIs" id="executive-kpis" data-home-kpis="OK">
      {head(
        <>
          <span className="loop-brief__sub" data-home-kpi-period>
            {s.periodLabel}
            {s.comparisonLabel ? <span data-home-kpi-comparison> · vs {s.comparisonLabel.charAt(0).toLowerCase()}{s.comparisonLabel.slice(1)}</span> : null}
          </span>
          <span className="loop-pill loop-pill--neutral loop-front__fresh" title={s.freshness.detail} data-home-kpi-freshness={s.freshness.state}>
            {s.freshness.word}
          </span>
          <Link className="loop-link loop-brief__more" href="/app/admin/marketplace">
            CallGrid Intelligence →
          </Link>
        </>,
      )}
      <div className="loop-front__kpigrid">
        {s.kpis.map((k) => (
          <Link key={k.key} href={k.href} className="loop-front__kpi" data-home-kpi={k.key} data-home-kpi-state={k.state} title={k.note ?? undefined}>
            <span className="loop-front__kpi-l">{k.label}</span>
            <span className={`loop-front__kpi-v${k.state !== 'VALUE' ? ' is-word' : ''}`}>{k.value}</span>
            {k.subline ? <span className="loop-front__kpi-s">{k.subline}</span> : null}
            {k.change ? (
              <span className={`loop-front__kpi-d is-${k.change.favorable === null ? 'flat' : k.change.favorable ? 'good' : 'bad'}`} data-home-kpi-change={k.change.direction}>
                <span aria-hidden="true">{CHANGE_ARROW[k.change.direction]}</span> {k.change.text}
                {s.comparisonLabel ? <span className="loop-sr-only"> against {s.comparisonLabel}</span> : null}
              </span>
            ) : (
              <span className="loop-front__kpi-d is-none" data-home-kpi-nochange>
                {k.noChangeReason}
              </span>
            )}
            {k.coverageNote ? (
              <span className="loop-front__kpi-n" title={k.coverageNote}>
                Incomplete<span className="loop-sr-only">: {k.coverageNote}</span>
              </span>
            ) : null}
          </Link>
        ))}
      </div>
      {s.coverageNote ? <p className="loop-brief__foot">{s.coverageNote}</p> : null}
    </section>
  );
}

// --- Headlines -----------------------------------------------------------------------------------------

export const HEADLINES_ON_HOME = 4;

const CASE_WORDS: Readonly<Record<HeadlineCaseState['state'], { label: string; tone: string }>> = Object.freeze({
  UNDER_INVESTIGATION: { label: 'Under investigation', tone: 'loop-pill--info' },
  NEW: { label: 'Not yet investigated', tone: 'loop-pill--attention' },
  UNKNOWN: { label: 'Investigation not read', tone: 'loop-pill--neutral' },
});

export function HeadlinesPanel({
  headlines,
  attention,
  cases,
  time,
  href,
}: {
  /** The non-dismissed Headlines the review read; null when that read failed. */
  headlines: readonly HeadlineView[] | null;
  attention: AttentionAssessment | null;
  cases: ReadonlyMap<string, HeadlineCaseState>;
  time: TimeView;
  href: string;
}) {
  const shown = (headlines ?? []).slice(0, HEADLINES_ON_HOME);
  const more = (headlines?.length ?? 0) - shown.length;
  return (
    <section className="loop-panel loop-brief__panel loop-front__headlines" aria-label="Headlines" id="headlines">
      <div className="loop-brief__head">
        <h2 className="loop-panel__title">Headlines</h2>
        {headlines && headlines.length > 0 ? <span className="loop-brief__sub">{counted(headlines.length, 'open Headline', 'open Headlines')}</span> : null}
        <Link className="loop-link loop-brief__more" href={href}>
          View all headlines →
        </Link>
      </div>
      {headlines === null ? (
        <SourceUnavailable what="Headlines" />
      ) : shown.length === 0 ? (
        <div className="loop-brief__quiet loop-front__attention" data-home-headlines-empty={attention?.state ?? 'UNKNOWN'}>
          {attention ? (
            <>
              <StateBadge state={attention.state} />
              <span>
                {attention.state === 'ALL_CLEAR' ? 'No qualifying Headlines right now. ' : ''}
                {attention.statement}
              </span>
              {attention.notKnown.length > 0 ? (
                <ul className="loop-front__notknown">
                  {attention.notKnown.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <span>No open Headlines.</span>
          )}
        </div>
      ) : (
        <ul className="loop-brief__rows">
          {shown.map((h) => {
            const investigation = cases.get(h.id) ?? { state: 'UNKNOWN' as const };
            const words = CASE_WORDS[investigation.state];
            return (
              <li className="loop-brief__row" key={h.id} data-home-headline={h.id} data-home-headline-case={investigation.state}>
                <span className={`loop-brief__dot is-${h.measurement.againstObjective ? 'critical' : 'attention'}`} aria-hidden="true" />
                <div className="loop-brief__body">
                  <p className="loop-brief__what">
                    <Link href={`${href}/${encodeURIComponent(h.id)}`}>{h.statement}</Link>
                  </p>
                  <p className="loop-brief__meta">
                    <span className={`loop-pill ${words.tone}`}>{words.label}</span>
                    {h.objectiveTitle ? <span className="loop-brief__where">{h.objectiveTitle}</span> : null}
                    <span className="loop-brief__why" data-home-headline-why>
                      Why: {h.ruleDescription}
                    </span>
                    <span>
                      first seen <time dateTime={h.firstDetectedAt}>{time.relative(h.firstDetectedAt)}</time>
                      {h.detectionCount > 1 ? (
                        <>
                          {' · '}last seen <time dateTime={h.lastDetectedAt}>{time.relative(h.lastDetectedAt)}</time>
                        </>
                      ) : null}
                    </span>
                  </p>
                </div>
                <div className="loop-brief__ways">
                  <Link className="loop-btn loop-btn--quiet loop-brief__act" href={`${href}/${encodeURIComponent(h.id)}`}>
                    {investigation.state === 'UNDER_INVESTIGATION' ? 'Open investigation' : 'Look into it'}
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {more > 0 ? (
        <p className="loop-brief__foot">
          <Link className="loop-link" href={href}>
            {counted(more, 'more open Headline', 'more open Headlines')} →
          </Link>
        </p>
      ) : null}
    </section>
  );
}

// --- Recent activity -------------------------------------------------------------------------------

/** The audit category's area, in the words the operational Home already uses for it. */
const AUDIT_AREA: Readonly<Record<string, string>> = Object.freeze({ work: 'Work', customer: 'CRM', invitation: 'Team' });

export function RecentActivityPanel({ rows, time, auditHref }: { rows: readonly ActivityItem[] | null; time: TimeView; auditHref: string | null }) {
  const entries: ActivityEntry[] = (rows ?? []).map((a) => ({
    key: `audit:${a.id}`,
    // Every row is a recorded act from the organization's audit log: that is the truth it is.
    category: 'AUDIT',
    story: a.actorName ? `${a.label} · ${a.actorName}` : a.label,
    when: time.relative(a.createdAtIso),
    whenIso: a.createdAtIso,
    evidence: [
      { label: 'Area', value: AUDIT_AREA[a.category] ?? a.category },
      { label: 'Recorded by', value: 'the audit log' },
      { label: 'When', value: time.dateTime(a.createdAtIso) },
    ],
  }));
  return (
    <section className="loop-panel loop-brief__panel loop-front__activity" aria-label="Recent activity" id="recent-activity">
      <div className="loop-brief__head">
        <h2 className="loop-panel__title">Recent activity</h2>
        {rows && rows.length > 0 ? <span className="loop-brief__sub">Business events from the audit log</span> : null}
        {auditHref ? (
          <Link className="loop-link loop-brief__more" href={auditHref}>
            View all →
          </Link>
        ) : null}
      </div>
      {rows === null ? (
        <SourceUnavailable what="recent activity" />
      ) : entries.length === 0 ? (
        <p className="loop-brief__quiet">No business activity recorded yet.</p>
      ) : (
        <div className="loop-front__activity-list" data-home-activity-categories={[...new Set(rows.map((r) => r.category))].join(',')}>
          <ActivityList entries={entries} label="Recent business activity" />
        </div>
      )}
    </section>
  );
}

// --- Your tools & spaces ------------------------------------------------------------------------------

export function ToolsGrid({ tiles }: { tiles: readonly HomeTile[] }) {
  if (tiles.length === 0) return null;
  return (
    <section className="loop-front__tools" aria-label="Your tools & spaces" id="tools">
      <div className="loop-brief__head">
        <h2 className="loop-panel__title">Your tools &amp; spaces</h2>
        <span className="loop-brief__sub">Only what you can open</span>
      </div>
      <div className="loop-front__tilegrid">
        {tiles.map((t) => (
          <Link key={t.key} href={t.href} className="loop-front__tile" data-home-tile={t.key} data-home-tile-state={t.state} title={t.note ?? undefined}>
            <span className="loop-front__tile-head">
              <span className="loop-front__tile-icon" aria-hidden="true">
                <SidebarIcon name={t.icon} />
              </span>
              <span className="loop-front__tile-title">{t.label}</span>
            </span>
            {t.metric ? (
              <span className="loop-front__tile-metric">
                <b>{t.metric.value}</b> <span>{t.metric.label}</span>
              </span>
            ) : null}
            {t.stateLine ? (
              <span className={`loop-front__tile-state is-${t.state.toLowerCase().replace(/_/g, '-')}`} data-home-tile-stateline>
                {t.stateLine}
              </span>
            ) : null}
            {t.lines.map((line) => (
              <span className="loop-front__tile-line" key={line}>
                {line}
              </span>
            ))}
            <span className="loop-front__tile-go">{t.linkLabel} →</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
