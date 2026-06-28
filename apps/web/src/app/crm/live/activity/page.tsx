import { requirePermission } from '../../../../auth/guard';
import LiveFeed from '../LiveFeed';

// Live Operations — Live Activity Feed (Sprint 15).
//
// A real-time operational view across every Brain sense (website, calls,
// bookings, customers, integrations). Server component permission-gates the
// surface with the 'intelligence' resource, then mounts the LiveFeed client
// which polls /api/live/activity every 8s (no websockets). Newest events first.
//
// Rendering lives inside the LiveFeed client component (variant='activity').
// Server Components must not pass a render function to a Client Component.

export const dynamic = 'force-dynamic';

export default async function LiveActivityPage() {
  await requirePermission('intelligence', 'view');

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <h1 className="crm-h1">Live Operations</h1>
          <p className="crm-sub">Every Brain sense in real time — newest first. Polled, deterministic, real Neon data only.</p>
        </div>
      </div>

      <div className="crm-panel">
        <LiveFeed
          endpoint="/api/live/activity"
          variant="activity"
          intervalMs={8000}
          emptyText="The Brain is quiet. As website visits, calls, bookings, and signals arrive, they will stream in here."
        />
      </div>
    </>
  );
}
