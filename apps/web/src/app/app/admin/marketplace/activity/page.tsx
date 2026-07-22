// CallGrid Intelligence — Activity.
//
// The chronological CallGrid operational stream. CallGrid exposes no durable
// operational event log, so this DERIVES clear changes between verified snapshots
// (the selected window vs its comparison window) and labels them honestly as
// "Derived from CallGrid reporting". It never fabricates event timestamps more
// precise than the underlying window, and it carries only CallGrid business
// events — no user/CRM/integration/platform/Work-OS activity.

import Link from 'next/link';
import { requireCrmContext } from '../../../../../crm/crm-data';
import { parseCallGridRange, resolveCallGridWindow, callGridRangeQuery, describeCallGridWindow } from '@emgloop/shared';
import { money, num } from '../../../_loop-os';
import { loadCallGridReport, type CallGridDimRow, type Dimension } from '../callgrid-report';
import { buildDimQuery } from '../dimension-metrics';
import { DimensionShell } from '../dimension-ui';

export const dynamic = 'force-dynamic';

type FilterKey = 'all' | 'buyers' | 'vendors' | 'sources' | 'campaigns' | 'bids' | 'calls';
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'buyers', label: 'Buyers' },
  { key: 'vendors', label: 'Vendors' },
  { key: 'sources', label: 'Sources' },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'bids', label: 'Bids' },
  { key: 'calls', label: 'Calls' },
];

interface Event {
  id: string;
  scope: FilterKey;
  title: string;
  detail: string;
  href?: string;
}

const NOUN: Record<Dimension, string> = { buyers: 'Buyer', vendors: 'Vendor', sources: 'Source', campaigns: 'Campaign' };

// Derive notable revenue movements + activation/inactivation for one dimension.
function deriveDimension(
  dim: Dimension,
  rows: CallGridDimRow[],
  priorByKey: Map<string, CallGridDimRow>,
  rangeQuery: string,
): Event[] {
  const scope = dim as FilterKey;
  const noun = NOUN[dim];
  const events: Event[] = [];
  const selectionParam = dim === 'buyers' ? 'buyer' : dim === 'vendors' ? 'vendor' : dim === 'sources' ? 'source' : 'campaign';
  const href = (key: string) => `/app/admin/marketplace/${dim}?` + buildDimQuery({ [selectionParam]: key, ...(rangeQuery ? Object.fromEntries(new URLSearchParams(rangeQuery)) : {}) });

  for (const r of rows) {
    const prior = priorByKey.get(r.key);
    if (!prior || prior.revenueCents <= 0) {
      if (r.calls > 0) events.push({ id: `${dim}:new:${r.key}`, scope, title: `${noun} began receiving traffic`, detail: `${r.label} · ${num(r.calls)} calls`, href: href(r.key) });
      continue;
    }
    const change = Math.round(((r.revenueCents - prior.revenueCents) / prior.revenueCents) * 100);
    if (Math.abs(change) >= 20) {
      events.push({
        id: `${dim}:rev:${r.key}`,
        scope,
        title: `${noun} revenue ${change > 0 ? 'increased' : 'declined'}`,
        detail: `${r.label} · ${money(r.revenueCents)} (${change > 0 ? '+' : ''}${change}%)`,
        href: href(r.key),
      });
    }
  }
  // Inactivation: had revenue last window, gone/zero now.
  const currentKeys = new Set(rows.map((r) => r.key));
  for (const [key, prior] of priorByKey) {
    if (!currentKeys.has(key) && prior.revenueCents > 0) {
      events.push({ id: `${dim}:gone:${key}`, scope, title: `${noun} became inactive`, detail: `${prior.label} · no activity this period (was ${money(prior.revenueCents)})` });
    }
  }
  return events.sort((a, b) => a.title.localeCompare(b.title)).slice(0, 8);
}

export default async function ActivityPage({ searchParams }: { searchParams?: Record<string, string | undefined> }) {
  const { organizationId: org } = await requireCrmContext();

  const now = new Date();
  const range = parseCallGridRange({ range: searchParams?.range, s: searchParams?.s, e: searchParams?.e });
  const window = resolveCallGridWindow(range, now);
  const rangeQuery = callGridRangeQuery(window.preset, { start: range.start, end: range.end });
  const filter = (FILTERS.find((f) => f.key === searchParams?.filter)?.key ?? 'all') as FilterKey;
  const desc = describeCallGridWindow(window, now);

  const report = await loadCallGridReport(org, window);

  const dims: Dimension[] = ['buyers', 'vendors', 'sources', 'campaigns'];
  let events: Event[] = report.ok
    ? dims.flatMap((d) => deriveDimension(d, report.dimensions[d], report.comparisonByKey[d], rangeQuery))
    : [];
  // Overall call volume movement (the 'calls' scope).
  if (report.ok && report.comparison && report.metrics.totalCalls !== null && report.comparison.totalCalls) {
    const prev = report.comparison.totalCalls;
    const change = prev > 0 ? Math.round(((report.metrics.totalCalls - prev) / prev) * 100) : 0;
    if (Math.abs(change) >= 10) {
      events.push({ id: 'calls:volume', scope: 'calls', title: `Total call volume ${change > 0 ? 'increased' : 'declined'}`, detail: `${num(report.metrics.totalCalls)} calls (${change > 0 ? '+' : ''}${change}%)` });
    }
  }
  if (filter !== 'all') events = events.filter((e) => e.scope === filter);

  const filterHref = (key: FilterKey) =>
    '?' + buildDimQuery({
      range: window.preset,
      s: window.preset === 'custom' ? range.start : undefined,
      e: window.preset === 'custom' ? range.end : undefined,
      filter: key === 'all' ? undefined : key,
    });

  return (
    <DimensionShell
      active="activity"
      title="Activity"
      subtitle="Operational changes across CallGrid for the selected period."
      window={window}
      now={now}
      customStart={range.start}
      customEnd={range.end}
      rangeQuery={rangeQuery}
    >
      <div className="cg-sec">
        <div className="cg-filters">
          {FILTERS.map((f) => (
            <Link key={f.key} href={filterHref(f.key)} className={'cg-filter' + (filter === f.key ? ' cg-filter--active' : '')}>
              {f.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="cg-sec">
        <p className="cg-seclabel">Activity · {desc.periodTitle} · Derived from CallGrid reporting</p>
        {!report.ok ? (
          <section className="tile tile--wide"><p className="tile__line cg-muted">CallGrid data could not be loaded.</p></section>
        ) : events.length === 0 ? (
          <section className="tile tile--wide"><p className="tile__line">No notable CallGrid changes for this period.</p></section>
        ) : (
          <ul className="dim-activity cg-actlist">
            {events.map((e) => (
              <li className="dim-activity__item" key={e.id}>
                <span className="dim-activity__title">{e.href ? <Link href={e.href} className="dim-rowlink">{e.title}</Link> : e.title}</span>
                <span className="dim-activity__detail">{e.detail}</span>
                <span className="dim-activity__when">{window.label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {filter === 'bids' ? (
        <div className="cg-sec">
          <section className="tile tile--wide"><p className="tile__line cg-muted">Bid changes require two synchronized snapshots to derive; only the latest snapshot is available. See the Bids workspace.</p></section>
        </div>
      ) : null}
    </DimensionShell>
  );
}
