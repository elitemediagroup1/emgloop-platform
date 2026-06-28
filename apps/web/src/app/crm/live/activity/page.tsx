import { requirePermission } from '../../../../auth/guard';
import LiveFeed, { relativeTime } from '../LiveFeed';

// Live Operations — Live Activity Feed (Sprint 15).
//
// A real-time operational view across every Brain sense (website, calls,
// bookings, customers, integrations). Server component permission-gates the
// surface with the 'intelligence' resource, then mounts the LiveFeed client
// which polls /api/live/activity every 8s (no websockets). Newest events first.

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  website: 'Website',
  call: 'Call',
  workflow: 'Workflow',
  customer: 'Customer',
  booking: 'Booking',
  integration: 'Integration',
};

const KIND_COLOR: Record<string, string> = {
  website: 'var(--crm-blue, #3b82f6)',
  call: 'var(--crm-amber, #f59e0b)',
  workflow: 'var(--crm-purple, #8b5cf6)',
  customer: 'var(--crm-accent, #14b8a6)',
  booking: 'var(--crm-accent, #14b8a6)',
  integration: 'var(--crm-faint, #9ca3af)',
};

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
          intervalMs={8000}
          emptyText="The Brain is quiet. As website visits, calls, bookings, and signals arrive, they will stream in here."
          render={(items) => (
            <ul className="crm-timeline">
              {items.map((it) => {
                const kind = String(it.kind ?? 'integration');
                return (
                  <li key={String(it.id)}>
                    <span className="crm-tl-dot" style={{ background: KIND_COLOR[kind] ?? 'var(--crm-faint)' }} />
                    <div>
                      <div className="crm-tl-title">{String(it.label ?? 'Event')}</div>
                      {it.detail ? <div className="crm-tl-body">{String(it.detail)}</div> : null}
                      <div className="crm-tl-meta">
                        <span className="crm-tag">{KIND_LABEL[kind] ?? kind}</span>
                        {it.provider ? ' · ' + String(it.provider) : ''}
                        {it.status ? ' · ' + String(it.status) : ''}
                        {' · '}
                        {relativeTime(it.at)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        />
      </div>
    </>
  );
}
