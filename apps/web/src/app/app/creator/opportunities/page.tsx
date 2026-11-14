import { CreatorPageHead } from '../../../../creator/creator-page-head';
import { CreatorRefreshButton } from '../../../../creator/CreatorRefreshButton';
import { CreatorUpdatesRefresh } from '../../../../creator/CreatorUpdatesRefresh';
import {
  CreatorPartnershipBoard,
  loadCreatorBrandUpdates,
} from '../../../../creator/creator-brand-updates';
import Link from 'next/link';
import { requireWorkspace } from '../../../../workspaces/guard';
import { CREATOR_HREFS, creatorDomain, requireCreator } from '../../../../creator/creator-runtime';
import { seatOf } from '../../../../creator/creator-data';
import { viewerTime } from '../../../../time/viewer-time';
import { LoopPage, StateBlock } from '../../_loop-os/record';
import { OPPORTUNITY_TONES, Pill } from '../_parts/vocabulary';

// Opportunities (Creator Hub): the creator-safe projection only. The read model already drops
// anything EMG has not designated as creator-visible (an internal stage, a forecast, a term); this
// page draws what is left and never fills in what was withheld.

export const dynamic = 'force-dynamic';

export default async function CreatorOpportunitiesPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const time = viewerTime();
  const opportunities = await creatorDomain().records.opportunities(seatOf(seat), seat.partyId);

  const brands = await loadCreatorBrandUpdates(seat, time);
  const stage = typeof searchParams.stage === 'string' ? searchParams.stage : '0';
  const query = typeof searchParams.q === 'string' ? searchParams.q.trim().slice(0, 100) : '';
  return (
    <LoopPage label="Partnerships">
      <CreatorUpdatesRefresh />
      <CreatorPageHead
        section="Partnerships"
        title="From first hello to partnership."
        description="Your brand relationships, with the latest position and the next step in one place."
        actions={<CreatorRefreshButton />}
      />
      {brands.incomplete ? (
        <p className="loop-note">Some sources could not be read. Counts may be incomplete.</p>
      ) : null}
      <CreatorPartnershipBoard
        rows={brands.rows}
        time={time}
        stage={stage}
        brandId={typeof searchParams.brand === 'string' ? searchParams.brand : undefined}
        status={typeof searchParams.status === 'string' ? searchParams.status : undefined}
        query={query}
        available={brands.available}
      />
      {opportunities.length > 0 ? (
        <section className="ch-shared-opportunities">
          <h2>Shared opportunity records</h2>
          <ul className="ch-list" aria-label="Partnerships">
            {opportunities.map((o) => (
              <li key={o.id}>
                <Link className="ch-row" href={CREATOR_HREFS.opportunity(o.id)}>
                  <span className="ch-row__main">
                    <span className="ch-row__title">{o.title}</span>
                    <span className="ch-row__meta">
                      {o.brandLabel ? `${o.brandLabel} · ` : ''}
                      {o.campaigns.length} campaign{o.campaigns.length === 1 ? '' : 's'} · updated{' '}
                      {time.relative(o.updatedAt)}
                    </span>
                    {o.summary ? <span className="ch-row__line">{o.summary}</span> : null}
                  </span>
                  {o.creatorVisibleState ? (
                    <Pill tone={OPPORTUNITY_TONES[o.creatorVisibleState]} small>
                      {o.stateLabel}
                    </Pill>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </LoopPage>
  );
}
