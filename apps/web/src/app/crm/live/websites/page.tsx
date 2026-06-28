import { requirePermission } from '../../../../auth/guard';
import LiveFeed from '../LiveFeed';

// Live Operations — Live Website Feed (Sprint 15).
//
// Website interactions grouped into live sessions (newest session first). Each
// session shows the visitor's path: page views, ZIP searches, CTA clicks, forms.
// Permission-gated by the 'intelligence' resource; polls /api/live/websites
// every 8s (no websockets). Derived from Brain events, real Neon data only.
//
// Rendering lives inside the LiveFeed client component (variant='websites').
// Server Components must not pass a render function to a Client Component.

export const dynamic = 'force-dynamic';

export default async function LiveWebsitesPage() {
  await requirePermission('intelligence', 'view');

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <h1 className="crm-h1">Live Website Feed</h1>
          <p className="crm-sub">Visitors moving across EMG properties right now, grouped into sessions. Newest first.</p>
        </div>
      </div>

      <div className="crm-panel">
        <LiveFeed
          endpoint="/api/live/websites"
          variant="websites"
          intervalMs={8000}
          emptyText="No website sessions yet. As visitors browse, search, and click across EMG properties, their live sessions will appear here."
        />
      </div>
    </>
  );
}
