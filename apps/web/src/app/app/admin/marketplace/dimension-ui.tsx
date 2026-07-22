// Shared CallGrid dimension-page UI — the one design language for Buyers, Vendors,
// Sources and Campaigns: the page shell (header + section nav + date control), the
// summary-tile grid, the sortable performance table, the selected-entity detail
// panel, and the recent-activity section. Presentational server components only —
// no data access. A page composes these; it never re-implements the chrome.

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { CallGridWindow } from '@emgloop/shared';
import { CallGridNav, type CallGridNavKey } from './_CallGridNav';
import CallGridDateRange from './CallGridDateRange';
import type { Trend } from './dimension-metrics';

// The page shell — identical chrome on every CallGrid tab.
export function DimensionShell({
  active,
  title,
  subtitle,
  window,
  customStart,
  customEnd,
  rangeQuery,
  children,
}: {
  active: CallGridNavKey;
  title: string;
  subtitle: string;
  window: CallGridWindow;
  customStart?: string;
  customEnd?: string;
  rangeQuery: string;
  children: ReactNode;
}) {
  return (
    <div className="loop-os">
      <div className="cmd cg-page dim-page">
        <div className="cmd-head">
          <div className="cmd-head__main">
            <p className="cmd-head__greeting">CallGrid Intelligence</p>
            <p className="cmd-head__meta">{window.label} · Eastern Time</p>
          </div>
        </div>
        <h1 className="dim-title">{title}</h1>
        <p className="dim-sub">{subtitle}</p>
        <CallGridNav active={active} rangeQuery={rangeQuery} />
        <CallGridDateRange preset={window.preset} customStart={customStart} customEnd={customEnd} label={window.label} />
        {children}
      </div>
    </div>
  );
}

export interface SummaryTile {
  title: string;
  value: string;
  sub?: string;
}

export function SummaryTiles({ tiles }: { tiles: SummaryTile[] }) {
  return (
    <div className="cg-sec">
      <p className="cg-seclabel">Summary</p>
      <div className="dim-tiles">
        {tiles.map((t) => (
          <section className="tile" aria-label={t.title} key={t.title}>
            <div className="tile__head"><span className="tile__title">{t.title}</span></div>
            <div className="tile__num">{t.value}</div>
            {t.sub ? <p className="tile__line">{t.sub}</p> : null}
          </section>
        ))}
      </div>
    </div>
  );
}

// A generic performance-table column. `sortKey` makes the header a sort link.
export interface PerfColumn<T> {
  label: string;
  align?: 'left' | 'right';
  sortKey?: string;
  render: (row: T) => ReactNode;
}

export function PerformanceTable<T>({
  sectionLabel,
  columns,
  rows,
  getKey,
  selectedKey,
  sort,
  sortHref,
  emptyLine,
}: {
  sectionLabel: string;
  columns: PerfColumn<T>[];
  rows: T[];
  getKey: (row: T) => string;
  selectedKey?: string | null;
  sort?: { key: string; dir: 'asc' | 'desc' };
  sortHref?: (key: string) => string;
  emptyLine: string;
}) {
  return (
    <div className="cg-sec">
      <p className="cg-seclabel">{sectionLabel}</p>
      {rows.length === 0 ? (
        <section className="tile tile--wide" aria-label={sectionLabel}>
          <p className="tile__line">{emptyLine}</p>
        </section>
      ) : (
        <div className="adm-tablewrap">
          <table className="adm-table dim-table">
            <thead>
              <tr>
                {columns.map((c, i) => {
                  const active = sort && c.sortKey === sort.key;
                  const arrow = active ? (sort!.dir === 'desc' ? ' ↓' : ' ↑') : '';
                  return (
                    <th key={i} className={c.align === 'right' ? 'dim-num' : undefined}>
                      {c.sortKey && sortHref ? (
                        <Link href={sortHref(c.sortKey)} className={'dim-sort' + (active ? ' dim-sort--active' : '')}>
                          {c.label}{arrow}
                        </Link>
                      ) : (
                        c.label
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const k = getKey(row);
                return (
                  <tr key={k} className={selectedKey === k ? 'dim-row dim-row--sel' : 'dim-row'}>
                    {columns.map((c, i) => (
                      <td key={i} className={c.align === 'right' ? 'dim-num' : undefined}>
                        {c.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function TrendCell({ t }: { t: Trend }) {
  return <span className={'dim-trend dim-trend--' + t.dir}>{t.text}</span>;
}

export interface DetailFact {
  label: string;
  value: string;
}

export function DetailPanel({
  sectionLabel,
  name,
  period,
  facts,
  note,
  emptyPrompt,
}: {
  sectionLabel: string;
  name: string | null;
  period: string;
  facts: DetailFact[];
  note?: string;
  emptyPrompt: string;
}) {
  return (
    <div className="cg-sec">
      <p className="cg-seclabel">{sectionLabel}</p>
      <section className="tile tile--wide dim-detail" aria-label={sectionLabel}>
        {!name ? (
          <p className="tile__line cg-muted">{emptyPrompt}</p>
        ) : (
          <>
            <div className="dim-detail__head">
              <span className="dim-detail__name">{name}</span>
              <span className="dim-detail__period">{period} · Eastern Time</span>
            </div>
            <dl className="dim-detail__grid">
              {facts.map((f) => (
                <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>
              ))}
            </dl>
            {note ? <p className="dim-detail__note cg-muted">{note}</p> : null}
          </>
        )}
      </section>
    </div>
  );
}

// The honesty banner for snapshot-only bid data: it does NOT honor the calendar
// range, so it says so and shows the provenance (snapshot date, last sync,
// provider window). Never fabricates historical bid reporting.
function easternDateTime(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(d);
}
function utcDate(d: Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

export function SnapshotNotice({
  windowStart, windowEnd, fetchedAt, reportTimezone,
}: {
  windowStart: Date; windowEnd: Date; fetchedAt: Date; reportTimezone: string | null;
}) {
  return (
    <div className="cg-snapnotice">
      <p className="cg-snapnotice__lead">Bid reporting reflects the latest synchronized provider snapshot.</p>
      <dl className="cg-snapnotice__grid">
        <div><dt>Latest snapshot date</dt><dd>{utcDate(windowStart)}</dd></div>
        <div><dt>Last synchronization</dt><dd>{easternDateTime(fetchedAt)} ET</dd></div>
        <div><dt>Provider reporting window</dt><dd>{utcDate(windowStart)} – {utcDate(windowEnd)}{reportTimezone ? ` (${reportTimezone}, as requested)` : ''}</dd></div>
      </dl>
    </div>
  );
}

export interface ActivityItem {
  id: string;
  title: string;
  detail?: string;
  when: string;
}

export function ActivitySection({
  items,
  emptyLine,
  sectionLabel = 'Recent Activity',
}: {
  items: ActivityItem[];
  emptyLine: string;
  sectionLabel?: string;
}) {
  return (
    <div className="cg-sec">
      <p className="cg-seclabel">{sectionLabel}</p>
      <section className="tile tile--wide" aria-label={sectionLabel}>
        {items.length === 0 ? (
          <p className="tile__line cg-muted">{emptyLine}</p>
        ) : (
          <ul className="dim-activity">
            {items.map((a) => (
              <li className="dim-activity__item" key={a.id}>
                <span className="dim-activity__title">{a.title}</span>
                {a.detail ? <span className="dim-activity__detail">{a.detail}</span> : null}
                <span className="dim-activity__when">{a.when}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
