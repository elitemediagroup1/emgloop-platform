import Link from 'next/link';
import type { ReactNode } from 'react';
import { counted, headlineSituationLabel, type AttentionAssessment, type HeadlineView, type TimeView } from '@emgloop/shared';
import { SidebarIcon } from '../../crm/_brand/SidebarIcon';
import { ActivityList, type ActivityEntry } from '../_loop-os/activity-item';
import { LabelBadge, StateBadge } from '../_loop-os/product-state';
import { StateBlock } from '../_loop-os/record';
import type { ActivityItem } from '../admin/workspace-home-data';
import type { HeadlineStanding } from './front-door-data';
import type { HomeKpiStrip } from './kpis';
import type { HomeTile } from './tiles';
import type { Settled } from './settle';
import { SourceUnavailable } from './briefing-view';

// Loop Home's front door, drawn (2026-09-24; the composition correction, 2026-09-24): the executive
// KPI row, the Headlines section, recent activity, and the tools & spaces grid. Server components over the pure projections (kpis.ts,
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

/**
 * Headlines as cards: what Loop identified, why it matters (the rule and the objective it moved
 * against), the evidence behind it (coverage and sightings), and where it stands -- the situation word
 * `headlineSituation` derives from the Headline and its Case, in the Headline workspace's own
 * vocabulary. Rows are the Headline authority's and nothing else's.
 */
export function HeadlinesPanel({
  headlines,
  attention,
  standings,
  time,
  href,
}: {
  /** The non-dismissed Headlines the review read; null when that read failed. */
  headlines: readonly HeadlineView[] | null;
  attention: AttentionAssessment | null;
  standings: ReadonlyMap<string, HeadlineStanding>;
  time: TimeView;
  href: string;
}) {
  const shown = (headlines ?? []).slice(0, HEADLINES_ON_HOME);
  const more = (headlines?.length ?? 0) - shown.length;
  return (
    <section className="loop-front__headlines" aria-label="Headlines" id="headlines">
      <div className="loop-brief__head">
        <h2 className="loop-panel__title">Headlines</h2>
        {headlines && headlines.length > 0 ? <span className="loop-brief__sub">{counted(headlines.length, 'open Headline', 'open Headlines')}</span> : null}
        <Link className="loop-link loop-brief__more" href={href}>
          View all Headlines →
        </Link>
      </div>
      {headlines === null ? (
        <SourceUnavailable what="Headlines" />
      ) : shown.length === 0 ? (
        <div className="loop-front__knowledge" data-home-headlines-empty={attention?.state ?? 'UNKNOWN'}>
          {attention ? (
            <>
              <StateBadge state={attention.state} />
              <p className="loop-front__knowledge-text">
                {attention.state === 'ALL_CLEAR' ? 'No qualifying Headlines right now. ' : ''}
                {attention.statement}
              </p>
              {attention.notKnown.length > 0 ? (
                <ul className="loop-front__notknown">
                  {attention.notKnown.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="loop-front__knowledge-text">No open Headlines.</p>
          )}
        </div>
      ) : (
        <ul className="loop-front__hlgrid">
          {shown.map((h) => {
            const standing = standings.get(h.id) ?? { situation: null, caseId: null };
            const detail = `${href}/${encodeURIComponent(h.id)}`;
            const coverage = h.measurement.currentCoverage !== null ? `coverage ${Math.round(h.measurement.currentCoverage * 100)}%` : null;
            return (
              <li className="loop-front__hl" key={h.id} data-home-headline={h.id} data-home-headline-situation={standing.situation ?? 'UNKNOWN'}>
                <div className="loop-front__hl-top">
                  {standing.situation ? <LabelBadge label={headlineSituationLabel(standing.situation)} /> : <span className="loop-pill loop-pill--neutral">Standing not read</span>}
                  <span className={`loop-brief__dot is-${h.measurement.againstObjective ? 'critical' : 'attention'}`} aria-hidden="true" />
                </div>
                <p className="loop-front__hl-what">
                  <Link href={detail}>{h.statement}</Link>
                </p>
                <p className="loop-front__hl-why" data-home-headline-why>
                  Why it matters: {h.ruleDescription}
                  {h.objectiveTitle ? <span className="loop-brief__where"> · {h.objectiveTitle}</span> : null}
                </p>
                <p className="loop-front__hl-evidence" data-home-headline-evidence>
                  {coverage ? <span>{coverage}</span> : null}
                  <span>{counted(h.detectionCount, 'sighting', 'sightings')}</span>
                  <span>
                    first seen <time dateTime={h.firstDetectedAt}>{time.relative(h.firstDetectedAt)}</time>
                    {h.detectionCount > 1 ? (
                      <>
                        {' · '}last seen <time dateTime={h.lastDetectedAt}>{time.relative(h.lastDetectedAt)}</time>
                      </>
                    ) : null}
                  </span>
                </p>
                <Link className="loop-link loop-front__hl-go" href={detail}>
                  {standing.situation === 'UNDER_INVESTIGATION' ? 'Open investigation →' : 'Look into it →'}
                </Link>
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

/** Recent activity is compact on Home: the latest few events, with the audit log one link away. */
export const ACTIVITY_ON_HOME = 6;

export function RecentActivityPanel({ rows, time, auditHref }: { rows: readonly ActivityItem[] | null; time: TimeView; auditHref: string | null }) {
  const entries: ActivityEntry[] = (rows ?? []).slice(0, ACTIVITY_ON_HOME).map((a) => ({
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
            {t.status ? <span className="loop-front__tile-status">{t.status}</span> : null}
            <span className="loop-front__tile-go">{t.linkLabel} →</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
