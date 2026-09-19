// CallGrid Intelligence — Activity.
//
// The CallGrid operational change stream. CallGrid exposes no durable operational
// event log, so every item here is a FINDING produced by the same intelligence
// engine the Overview and the dimension pages use — not a second set of rules
// with its own thresholds. What appears here appears there, with the same
// evidence and the same rule version.
//
// It never fabricates a timestamp more precise than the window a finding was
// derived from: a period-level conclusion is stamped with the reporting window,
// because pretending to know the minute something happened would be an invention.
//
// CallGrid business events only — no user, CRM, integration, platform or Work OS
// activity.

import Link from 'next/link';
import type { CallGridFinding } from '@emgloop/shared';
import { loadBidReport, bidSnapshotMatches } from '../bid-report';
import { callGridIntelligence, bidIntelligence } from '../intelligence-data';
import { loadCommandContext, withQuery, type SearchParams } from '../command-data';
import { CommandShell } from '../command-ui';
import { FindingCard, UnknownsSection } from '../intelligence-ui';
import { requireWorkspacePermission } from '../../../../../workspaces/guard';

export const dynamic = 'force-dynamic';

type FilterKey = 'all' | 'buyers' | 'vendors' | 'sources' | 'campaigns' | 'bids' | 'calls' | 'intelligence';
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'buyers', label: 'Buyers' },
  { key: 'vendors', label: 'Vendors' },
  { key: 'sources', label: 'Sources' },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'bids', label: 'Bids' },
  { key: 'calls', label: 'Calls' },
  { key: 'intelligence', label: 'Intelligence' },
];

/**
 * Which filter a finding belongs to.
 *
 * Derived from the finding's own id and entity types — a finding about a buyer
 * files under Buyers whichever rule produced it.
 */
function scopeOf(finding: CallGridFinding): FilterKey {
  const entity = finding.affectedEntities[0]?.entityType ?? finding.supportingEvidence[0]?.entityType;
  switch (entity) {
    case 'buyer': return 'buyers';
    case 'vendor': return 'vendors';
    case 'source': return 'sources';
    case 'campaign': return 'campaigns';
    case 'bid_source':
    case 'bid_destination': return 'bids';
    default: break;
  }
  if (finding.primaryMetric === 'totalCalls' || finding.primaryMetric === 'billableRate') return 'calls';
  return 'intelligence';
}

export default async function ActivityPage({ searchParams }: { searchParams?: SearchParams }) {
  const session = await requireWorkspacePermission('ADMIN', 'intelligence', 'view');
  const ctx = await loadCommandContext(session, searchParams);
  const { now, window, desc, report } = ctx;
  const org = ctx.organizationId;
  const rawFilter = searchParams?.filter;
  const filter = (FILTERS.find((f) => f.key === (typeof rawFilter === 'string' ? rawFilter : ''))?.key ?? 'all') as FilterKey;

  const bid = await loadBidReport(org);

  const intel = callGridIntelligence(report, now);
  const bidIntel = bidIntelligence(bid, now, desc.periodTitle, bidSnapshotMatches(bid.meta, window));

  const all = [...intel.findings, ...bidIntel.findings, ...bidIntel.snapshotChanges];
  const items = (filter === 'all' ? all : all.filter((f) => scopeOf(f) === filter));

  const filterHref = (key: FilterKey) =>
    withQuery('/app/admin/marketplace/activity', ctx.query, key === 'all' ? {} : { filter: key });

  // A period-level finding gets the window it was derived from, never a minute.
  const stampFor = (f: CallGridFinding) =>
    f.currentWindow.startsWith('Latest')
      ? f.currentWindow
      : `Detected for the ${window.label} reporting window`;

  return (
    <CommandShell
      ctx={ctx}
      active="activity"
      path="/app/admin/marketplace/activity"
      crumbs={[{ label: 'Intelligence', href: withQuery('/app/admin/marketplace/intelligence', ctx.query) }, { label: 'Every finding, as a stream' }]}
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
        ) : items.length === 0 ? (
          <section className="tile tile--wide">
            <p className="tile__line">No CallGrid changes for this period clear the significance thresholds.</p>
          </section>
        ) : (
          <div className="cg-findings">
            {items.map((f) => (
              <div className="cg-actitem" key={f.id}>
                <p className="cg-actwhen">{stampFor(f)}</p>
                <FindingCard finding={f} compact />
              </div>
            ))}
          </div>
        )}
      </div>

      {filter === 'bids' && bidIntel.snapshotChanges.length === 0 ? (
        <div className="cg-sec">
          <section className="tile tile--wide">
            <p className="tile__line cg-muted">
              Bid items describe the latest synchronized snapshot, not the selected period. A change over time needs a
              second stored snapshot, and only one is kept.
            </p>
          </section>
        </div>
      ) : null}

      <UnknownsSection unknowns={intel.unknowns} />
    </CommandShell>
  );
}
