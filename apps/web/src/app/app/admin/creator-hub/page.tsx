import Link from 'next/link';
import { requireWorkspace } from '../../../../workspaces/guard';
import { absentUntilMigrated } from '@emgloop/database';
import { creatorDomain, EMG_HREFS } from '../../../../creator/creator-runtime';
import { LoopPage, PageHead, StateBlock } from '../../_loop-os/record';
import { RefusedBlock, RosterView, TRAIL } from './_shared';

// EMG Creator Operations — the roster (design pass §10: Operations → Creators).
//
// One row per managed creator with what they need from EMG, what EMG waits on them for,
// what is in production and what is due soon, all read from the domain's EMG projection.
// The nav item states no permission beyond the ADMIN tree, so this page enforces exactly
// that authority, first, before any read.

export const dynamic = 'force-dynamic';

export default async function CreatorRosterPage({ searchParams }: { searchParams?: { refused?: string } }) {
  const session = await requireWorkspace('ADMIN');
  // Null only while the Creator Hub migration has not reached this database.
  const rows = await absentUntilMigrated(creatorDomain().records.roster(session.organizationId));
  return (
    <LoopPage label="Creators">
      <PageHead
        trail={[TRAIL.operations, { label: 'Creators' }]}
        title="Creators"
        subtitle="Every managed creator in your workspace: what they need from EMG, and what EMG is waiting on."
        actions={
          <div className="loop-btnrow">
            <Link className="loop-btn" href={EMG_HREFS.requests}>Requests</Link>
          </div>
        }
      />
      <RefusedBlock refused={searchParams?.refused} />
      {rows === null ? (
        <StateBlock kind="unavailable" title="The Creator Hub is not available on this deployment yet." body="Its database migration has not been applied here. Nothing is wrong with the existing records." />
      ) : (
        <RosterView rows={rows} />
      )}
    </LoopPage>
  );
}
