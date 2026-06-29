import { requirePermission } from '../../../../auth/guard';
import LiveFeed from '../LiveFeed';

// Live Operations — Live Call Feed (Sprint 15), real-data hotfix.
//
// Every recent PHONE interaction (last 24h), attribution-enriched. Missing
// vendor/source/campaign show honestly as 'Unknown ...' (never a fake partner).
// Demo/QA/test records excluded. Rows are traceable (provider + event id).
// Permission-gated by 'intelligence'; polls /api/live/calls. Newest first.
// Rendering lives inside the LiveFeed client component (variant='calls').

export const dynamic = 'force-dynamic';

export default async function LiveCallsPage() {
  await requirePermission('intelligence', 'view');

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <h1 className="crm-h1">Live Calls</h1>
          <p className="crm-sub">Inbound calls as they land — vendor, source, qualification and next best action. Last 24 hours, newest first.</p>
        </div>
      </div>

      <div className="crm-panel">
        <LiveFeed
          endpoint="/api/live/calls"
          variant="calls"
          intervalMs={8000}
          windowLabel="last 24 hours"
          emptyText="No calls in the last 24 hours. As CallGrid routes inbound calls, they will appear here in real time."
        />
      </div>
    </>
  );
}
