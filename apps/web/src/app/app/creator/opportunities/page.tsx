import Link from 'next/link';
import { requireWorkspace } from '../../../../workspaces/guard';
import { CREATOR_HREFS, creatorDomain, requireCreator } from '../../../../creator/creator-runtime';
import { seatOf } from '../../../../creator/creator-data';
import { viewerTime } from '../../../../time/viewer-time';
import { LoopPage, PageHead, StateBlock } from '../../_loop-os/record';
import { OPPORTUNITY_TONES, Pill } from '../_parts/vocabulary';

// Opportunities (Creator Hub): the creator-safe projection only. The read model already drops
// anything EMG has not designated as creator-visible (an internal stage, a forecast, a term); this
// page draws what is left and never fills in what was withheld.

export const dynamic = 'force-dynamic';

export default async function CreatorOpportunitiesPage() {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const time = viewerTime();
  const opportunities = await creatorDomain().records.opportunities(seatOf(seat), seat.partyId);

  return (
    <LoopPage label="Opportunities">
      <PageHead trail={[{ label: 'Creator' }, { label: 'Opportunities' }]} title="Opportunities" subtitle="Brand interest EMG is working on for you, in the words EMG chose to share." />
      {opportunities.length === 0 ? (
        <StateBlock kind="empty" title="No opportunities yet." body="EMG shares an opportunity here once it decides you can see it. Nothing is hidden behind a number." />
      ) : (
        <ul className="ch-list" aria-label="Opportunities">
          {opportunities.map((o) => (
            <li key={o.id}>
              <Link className="ch-row" href={CREATOR_HREFS.opportunity(o.id)}>
                <span className="ch-row__main">
                  <span className="ch-row__title">{o.title}</span>
                  <span className="ch-row__meta">
                    {o.brandLabel ? `${o.brandLabel} · ` : ''}
                    {o.campaigns.length} campaign{o.campaigns.length === 1 ? '' : 's'} · updated {time.relative(o.updatedAt)}
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
      )}
    </LoopPage>
  );
}
