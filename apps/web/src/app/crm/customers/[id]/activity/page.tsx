import Link from 'next/link';
import { loadOrFallback, DbNotConfigured } from '../../../../../demo/db-health';
import { crmRepos } from '../../../../../crm/crm-data';
import { requirePermission } from '../../../../../auth/guard';

// Per-customer activity / audit view — Sprint 8 (Conversations, Phase 3).
//
// Surfaces the immutable AuditLog and DomainEvent rows that concern a single
// customer, merged into one reverse-chronological stream. This is the record
// of WHO did WHAT to this customer (status changes, merges, assignments) and
// WHAT the platform observed (domain events). Read-only; guarded behind
// customers:view.

export const dynamic = 'force-dynamic';

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default async function CustomerActivityPage({
  params,
}: {
  params: { id: string };
}) {
  const { organizationId } = await requirePermission('customers', 'view');

  const result = await loadOrFallback(async () => {
    if (!organizationId) return { empty: true as const, rows: [], name: '' };
    const [rows, workspace] = await Promise.all([
      crmRepos.conversationsInbox.customerActivity(organizationId, params.id, 200),
      crmRepos.crm.getWorkspace(params.id),
    ]);
    // Fail closed: ignore a customer that is not in the caller's organization.
    if (workspace && workspace.customer.organizationId !== organizationId) {
      return { empty: true as const, rows: [], name: 'Customer' };
    }
    return { empty: false as const, rows, name: workspace ? workspace.name : 'Customer' };
  });

  if (!result.ok) return <DbNotConfigured />;
  const rows = result.data.empty ? [] : result.data.rows;
  const name = result.data.empty ? 'Customer' : result.data.name;

  return (
    <>
      <div className="crm-breadcrumb">
        <Link href={'/crm/customers/' + params.id}>← {name}</Link>
      </div>
      <h1 className="crm-h1">Activity & audit</h1>
      <p className="crm-sub">
        {rows.length} recorded action(s) and event(s) for this customer.
      </p>

      <div className="crm-panel">
        {rows.length === 0 ? (
          <div className="crm-empty">No recorded activity for this customer yet.</div>
        ) : (
          <ul className="crm-feed">
            {rows.map((r) => (
              <li key={r.kind + ':' + r.id} className="crm-feed-item">
                <span
                  className="crm-tl-dot"
                  style={{
                    background:
                      r.kind === 'audit' ? 'var(--crm-accent)' : 'var(--crm-blue)',
                  }}
                />
                <div className="crm-feed-body">
                  <div className="crm-feed-top">
                    <span className="crm-cell-name">{r.label}</span>
                    <span className="crm-feed-when">{fmt(r.at)}</span>
                  </div>
                  <div className="crm-tl-meta">
                    {r.kind === 'audit' ? 'Audit' : 'Domain event'} · {r.actor}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
