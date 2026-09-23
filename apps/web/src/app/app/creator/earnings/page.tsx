import { requireWorkspace } from '../../../../workspaces/guard';
import { creatorDomain, requireCreator } from '../../../../creator/creator-runtime';
import { viewerTime } from '../../../../time/viewer-time';
import { LoopPage, PageHead } from '../../_loop-os/record';
import { EarningsBody } from '../_parts/earnings-body';

// Earnings (Creator Hub). The body carries the rule: only AVAILABLE is money the creator can act
// on, and Loop moves none of it. This page states its authority, loads the read model and draws.

export const dynamic = 'force-dynamic';

export default async function CreatorEarningsPage() {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const time = viewerTime();
  const earnings = await creatorDomain().records.earnings(seat.actor.organizationId, seat.profileId);
  return (
    <LoopPage label="Earnings">
      <PageHead trail={[{ label: 'Creator' }, { label: 'Earnings' }]} title="Earnings" subtitle="What EMG has recorded for you, by state. Only what is available to you is payable." />
      <EarningsBody earnings={earnings} time={time} />
    </LoopPage>
  );
}
