import { requireWorkspace } from '../../../../../workspaces/guard';
import { absentUntilMigrated } from '@emgloop/database';
import { creatorDomain } from '../../../../../creator/creator-runtime';
import { viewerTime } from '../../../../../time/viewer-time';
import { LoopPage, PageHead, StateBlock } from '../../../_loop-os/record';
import { RefusedBlock, RequestsView, TRAIL, groupRequests } from '../_shared';

// EMG Creator Operations — the Requests lane (design pass §10): every production across
// creators, grouped by who it waits on. Rows open the Work OS detail (where the editing
// happens) and the content record (where the lineage lives). Nothing is duplicated here:
// the lane is a projection of Work OS and content rows, read from the domain.

export const dynamic = 'force-dynamic';

export default async function CreatorRequestsPage({ searchParams }: { searchParams?: { refused?: string } }) {
  const session = await requireWorkspace('ADMIN');
  // Null only while the Creator Hub migration has not reached this database.
  const rows = await absentUntilMigrated(creatorDomain().records.requests(session.organizationId));
  return (
    <LoopPage label="Creator requests">
      <PageHead
        trail={[TRAIL.operations, TRAIL.creators, { label: 'Requests' }]}
        title="Requests"
        subtitle="Productions across every creator: what needs EMG, what is with a creator, and what finished."
      />
      <RefusedBlock refused={searchParams?.refused} />
      {rows === null ? (
        <StateBlock kind="unavailable" title="The Creator Hub is not available on this deployment yet." body="Its database migration has not been applied here. Nothing is wrong with the existing records." />
      ) : (
        <RequestsView groups={groupRequests(rows)} time={viewerTime()} />
      )}
    </LoopPage>
  );
}
