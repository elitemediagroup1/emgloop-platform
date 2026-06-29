import { requirePermission } from '../../../../auth/guard';
import { EMG_PROPERTIES } from '@emgloop/database';
import LiveFeed from '../LiveFeed';

// Live Operations — Live Website Feed (Sprint 15), real-data hotfix.
//
// Recent website sessions (last 60 min) across EMG properties, newest first,
// demo/QA/test records excluded. A property selector (the six EMG properties)
// filters the feed; empty properties show an honest 'awaiting events' message.
// Permission-gated by the 'intelligence' resource; polls /api/live/websites.
// Rendering lives inside the LiveFeed client component (variant='websites').

export const dynamic = 'force-dynamic';

const PROPERTIES = EMG_PROPERTIES.map((p) => ({ key: p.key, name: p.name }));

export default async function LiveWebsitesPage() {
  await requirePermission('intelligence', 'view');

  return (
    <>
      <div className="crm-wf-head">
        <div>
          <h1 className="crm-h1">Live Website Feed</h1>
          <p className="crm-sub">Visitors moving across EMG properties right now, grouped into sessions. Recent first — pick a property to focus.</p>
        </div>
      </div>

      <div className="crm-panel">
        <LiveFeed
          endpoint="/api/live/websites"
          variant="websites"
          intervalMs={8000}
          windowLabel="active sessions · last 60 min"
          properties={PROPERTIES}
          emptyText="No live website sessions in the last 60 minutes. As visitors browse, search, and click across EMG properties, their sessions will appear here."
        />
      </div>
    </>
  );
}
