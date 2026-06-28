import Link from 'next/link';
import { requirePermission } from '../../../../auth/guard';
import LiveFeed, { relativeTime } from '../LiveFeed';

// Live Operations — Live Website Feed (Sprint 15).
//
// Website interactions grouped into live sessions (newest session first). Each
// session shows the visitor's path: page views, ZIP searches, CTA clicks, forms.
// Permission-gated by the 'intelligence' resource; polls /api/live/websites
// every 8s (no websockets). Derived from Brain events, real Neon data only.

export const dynamic = 'force-dynamic';

interface WebEvent {
  id?: unknown;
  eventType?: unknown;
  label?: unknown;
  journeyStage?: unknown;
  at?: unknown;
}

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
          intervalMs={8000}
          emptyText="No website sessions yet. As visitors browse, search, and click across EMG properties, their live sessions will appear here."
          render={(items) => (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              {items.map((s) => {
                const events = Array.isArray(s.events) ? (s.events as WebEvent[]) : [];
                return (
                  <div key={String(s.sessionKey)} className="crm-card" style={{ margin: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '0.5rem' }}>
                      <div className="crm-tl-title">
                        {s.website ? String(s.website) : 'Website session'}
                        {s.customerId ? (
                          <>
                            {' · '}
                            <Link href={'/crm/customers/' + String(s.customerId)} className="crm-link">
                              {String(s.customerName ?? 'View customer')}
                            </Link>
                          </>
                        ) : s.customerName ? ' · ' + String(s.customerName) : ''}
                      </div>
                      <span className="crm-tl-meta">{events.length} event{events.length === 1 ? '' : 's'} · {relativeTime(s.lastAt)}</span>
                    </div>
                    <ul className="crm-timeline" style={{ marginTop: '0.6rem' }}>
                      {events.map((e) => (
                        <li key={String(e.id)}>
                          <span className="crm-tl-dot" style={{ background: 'var(--crm-blue, #3b82f6)' }} />
                          <div>
                            <div className="crm-tl-title">{String(e.label ?? e.eventType ?? 'Website activity')}</div>
                            <div className="crm-tl-meta">
                              {e.eventType ? String(e.eventType).replace(/^web\./, '') : 'event'}
                              {e.journeyStage ? ' · ' + String(e.journeyStage) : ''}
                              {' · '}
                              {relativeTime(e.at)}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        />
      </div>
    </>
  );
}
