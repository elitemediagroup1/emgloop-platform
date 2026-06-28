import { requirePermission } from '../../../../auth/guard';
import LiveFeed from '../LiveFeed';

// Live Operations — Live Call Feed (Sprint 15).
//
// Every PHONE interaction, attribution-enriched (vendor / source / campaign),
// with qualified flag, duration, AI/human assignment and next-best-action.
// Permission-gated by the 'intelligence' resource; polls /api/live/calls every
// 8s (no websockets). Newest calls first. Real Neon data only.
//
// Rendering lives inside the LiveFeed client component (variant='calls').
// Server Components must not pass a render function to a Client Component.

export const dynamic = 'force-dynamic';

export default async function LiveCallsPage() {
  await requirePermission('intelligence', 'view');

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <h1 className="crm-h1">Live Calls</h1>
          <p className="crm-sub">Inbound calls as they land — vendor, source, qualification and next best action. Newest first.</p>
        </div>
      </div>

      <div className="crm-panel">
        <LiveFeed
          endpoint="/api/live/calls"
          variant="calls"
          intervalMs={8000}
          emptyText="No calls yet. As CallGrid routes inbound calls, they will appear here in real time."
        />
      </div>
    </>
  );
}
