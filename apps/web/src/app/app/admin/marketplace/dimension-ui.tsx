// Shared CallGrid workspace UI: the summary-tile grid, the sortable performance
// table, the trend cell, the bid-snapshot notice and the activity section.
// Presentational server components only — no data access. The page chrome (header,
// period, KPIs, section selector) is `CommandShell` in ./command-ui.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatCalendarDate, formatInstant } from '@emgloop/shared';
import type { Trend } from './dimension-metrics';
import { viewerTime } from '../../../../time/viewer-time';

export interface SummaryTile {
  title: string;
  value: string;
  sub?: string;
}

export function SummaryTiles({ tiles, label = 'Summary' }: { tiles: SummaryTile[]; label?: string }) {
  return (
    <div className="cg-sec">
      <p className="cg-seclabel">{label}</p>
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

// The honesty banner for snapshot-only bid data: it does NOT honor the calendar
// range, so it says so and shows the provenance (snapshot date, last sync,
// provider window). Never fabricates historical bid reporting.
function syncedAt(d: Date): string {
  return formatInstant(d, viewerTime().timeZone, 'dateTime', { withZone: true });
}
// A provider reporting day CallGrid was asked for in UTC: a calendar date in the
// window's own zone, shown as that date to every reader (Loop Time Authority).
function utcDate(d: Date): string {
  return formatCalendarDate(d);
}

export function SnapshotNotice({
  windowStart, windowEnd, fetchedAt, reportTimezone, selectedPeriodLabel, matchesSelectedPeriod,
}: {
  windowStart: Date; windowEnd: Date; fetchedAt: Date; reportTimezone: string | null;
  /** The selected CallGrid period label, shown so the operator can compare grains. */
  selectedPeriodLabel?: string;
  /** True only when the snapshot genuinely coincides with the selected period. */
  matchesSelectedPeriod?: boolean;
}) {
  return (
    <div className="cg-snapnotice">
      <p className="cg-snapnotice__lead">
        {matchesSelectedPeriod
          ? 'Bid reporting matches the selected period.'
          : 'The CallGrid calendar selection applies to date-queryable call reporting. Current bid metrics reflect the latest synchronized provider snapshot, not the selected CallGrid period.'}
      </p>
      <dl className="cg-snapnotice__grid">
        <div><dt>Latest snapshot date</dt><dd>{utcDate(windowStart)}</dd></div>
        <div><dt>Last synchronization</dt><dd>{syncedAt(fetchedAt)}</dd></div>
        <div><dt>Provider reporting window</dt><dd>{utcDate(windowStart)} – {utcDate(windowEnd)}{reportTimezone ? ` (${reportTimezone}, as requested)` : ''}</dd></div>
        {selectedPeriodLabel ? <div><dt>Selected CallGrid period</dt><dd>{selectedPeriodLabel}</dd></div> : null}
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
