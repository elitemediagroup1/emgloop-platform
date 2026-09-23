import { requireWorkspace } from '../../../../../workspaces/guard';
import { creatorDomain } from '../../../../../creator/creator-runtime';
import { viewerTime } from '../../../../../time/viewer-time';
import { LoopPage, PageHead } from '../../../_loop-os/record';
import { RefusedBlock, RequestsView, TRAIL, groupRequests } from '../_shared';

// EMG Creator Operations — the Requests lane (design pass §10): every production across
// creators, grouped by who it waits on. Rows open the Work OS detail (where the editing
// happens) and the content record (where the lineage lives). Nothing is duplicated here:
// the lane is a projection of Work OS and content rows, read from the domain.

export const dynamic = 'force-dynamic';

export default async function CreatorRequestsPage({ searchParams }: { searchParams?: { refused?: string } }) {
  const session = await requireWorkspace('ADMIN');
  const rows = await creatorDomain().records.requests(session.organizationId);
  return (
    <LoopPage label="Creator requests">
      <PageHead
        trail={[TRAIL.operations, TRAIL.creators, { label: 'Requests' }]}
        title="Requests"
        subtitle="Productions across every creator: what needs EMG, what is with a creator, and what finished."
      />
      <RefusedBlock refused={searchParams?.refused} />
      <RequestsView groups={groupRequests(rows)} time={viewerTime()} />
    </LoopPage>
  );
}
