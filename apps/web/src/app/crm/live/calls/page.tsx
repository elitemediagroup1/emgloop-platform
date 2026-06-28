import Link from 'next/link';
import { requirePermission } from '../../../../auth/guard';
import LiveFeed, { relativeTime } from '../LiveFeed';

// Live Operations — Live Call Feed (Sprint 15).
//
// Every PHONE interaction, attribution-enriched (vendor / source / campaign),
// with qualified flag, duration, AI/human assignment and next-best-action.
// Permission-gated by the 'intelligence' resource; polls /api/live/calls every
// 8s (no websockets). Newest calls first. Real Neon data only.

export const dynamic = 'force-dynamic';

function dur(seconds: unknown): string {
  const s = typeof seconds === 'number' ? seconds : Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '—';
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m > 0 ? m + 'm ' + r + 's' : r + 's';
}

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
          intervalMs={8000}
          emptyText="No calls yet. As CallGrid routes inbound calls, they will appear here in real time."
          render={(items) => (
            <div className="crm-table-wrap" style={{ overflowX: 'auto' }}>
              <table className="crm-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Caller</th>
                    <th>Customer</th>
                    <th>Vendor</th>
                    <th>Source</th>
                    <th>Campaign</th>
                    <th>Qualified</th>
                    <th>Duration</th>
                    <th>Status</th>
                    <th>Assigned</th>
                    <th>Next best action</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it) => {
                    const qualified = it.qualified;
                    const assigned = [it.assignedAi, it.assignedHuman].filter(Boolean).join(' / ') || '—';
                    return (
                      <tr key={String(it.id)}>
                        <td title={String(it.at ?? '')}>{relativeTime(it.at)}</td>
                        <td>{it.caller ? String(it.caller) : '—'}</td>
                        <td>
                          {it.customerId ? (
                            <Link href={'/crm/customers/' + String(it.customerId)} className="crm-link">
                              {String(it.customerName ?? 'View')}
                            </Link>
                          ) : (
                            String(it.customerName ?? '—')
                          )}
                        </td>
                        <td>{it.vendor ? String(it.vendor) : '—'}</td>
                        <td>{it.source ? String(it.source) : '—'}</td>
                        <td>{it.campaign ? String(it.campaign) : '—'}</td>
                        <td>
                          {qualified === true ? (
                            <span className="crm-tag" style={{ background: 'var(--crm-accent, #14b8a6)', color: '#fff' }}>Qualified</span>
                          ) : qualified === false ? (
                            <span className="crm-tag">Unqualified</span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{dur(it.durationSeconds)}</td>
                        <td>{it.status ? String(it.status) : '—'}</td>
                        <td>{assigned}</td>
                        <td>{it.nextBestAction ? String(it.nextBestAction) : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        />
      </div>
    </>
  );
}
