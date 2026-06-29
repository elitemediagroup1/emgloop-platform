import { requirePermission } from '../../../../auth/guard';
import LiveFeed from '../LiveFeed';

// Live Operations — Live Activity Feed (Sprint 15), real-data hotfix.
//
// A real-time operational view across every Brain sense (website, calls,
// bookings, customers, integrations) for the LAST 24 HOURS, demo/QA/test
// records excluded. Server component permission-gates with 'intelligence',
// then mounts the LiveFeed client which polls /api/live/activity. Newest first.
// Rendering lives inside the LiveFeed client component (variant='activity').

export const dynamic = 'force-dynamic';

export default async function LiveActivityPage() {
  await requirePermission('intelligence', 'view');

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <h1 className="crm-h1">Live Operations</h1>
          <p className="crm-sub">Every Brain sense in real time — newest first, last 24 hours. Polled, deterministic, real Neon data only.</p>
        </div>
      </div>

      <div className="crm-panel">
        <LiveFeed
          endpoint="/api/live/activity"
          variant="activity"
          intervalMs={8000}
          windowLabel="last 24 hours"
          emptyText="No operational events in the last 24 hours. As website visits, calls, bookings, and signals arrive, they will stream in here."
        />
      </div>
    </>
  );
}
