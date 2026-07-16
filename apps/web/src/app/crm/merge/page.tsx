import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';
import { crmRepos } from '../../../crm/crm-data';
import { requirePermission } from '../../../auth/guard';
import { mergeCustomersAction } from '../../../crm/conversation-actions';

// Customer merge — Sprint 8 (Conversations, Phase 3).
//
// Detects duplicate customers (shared email or phone) and lets an operator
// merge a duplicate into a canonical record. The merge re-points all related
// conversations, interactions, bookings, orders, service requests and signals
// to the canonical customer, unions tags, and soft-archives the merged row —
// all in one transaction via the repository, with an audit entry. Guarded
// behind customers:delete because it consolidates records.

export const dynamic = 'force-dynamic';

export default async function MergePage() {
  const { organizationId } = await requirePermission('customers', 'delete');

  const result = await loadOrFallback(async () => {
    const groups = await crmRepos.conversationsInbox.findDuplicates(organizationId);
    return { empty: false as const, groups };
  });

  if (!result.ok) return <DbNotConfigured />;
  const groups = result.data.empty ? [] : result.data.groups;

  return (
    <>
      <h1 className="crm-h1">Customer merge</h1>
      <p className="crm-sub">
        {groups.length} potential duplicate group(s) detected by shared email or phone.
      </p>

      {groups.length === 0 ? (
        <div className="crm-panel">
          <div className="crm-empty">No duplicate customers detected.</div>
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.key} className="crm-panel crm-merge-group">
            <div className="crm-merge-head">
              <span className="crm-faint">Matched by {g.field}:</span>{' '}
              <strong>{g.value}</strong>
            </div>
            <form action={mergeCustomersAction} className="crm-merge-form">
              <table className="crm-table">
                <thead>
                  <tr>
                    <th>Keep (canonical)</th>
                    <th>Merge away</th>
                    <th>Customer</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {g.customers.map((c, idx) => (
                    <tr key={c.id}>
                      <td>
                        <input
                          type="radio"
                          name="canonicalId"
                          value={c.id}
                          defaultChecked={idx === 0}
                          required
                        />
                      </td>
                      <td>
                        <input type="radio" name="mergedId" value={c.id} required />
                      </td>
                      <td className="crm-cell-name">{c.name}</td>
                      <td className="crm-cell-muted">
                        {new Date(c.createdAt).toLocaleDateString('en-US')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="crm-merge-actions">
                <span className="crm-faint">
                  The canonical record is kept; the merged record is archived.
                </span>
                <button className="crm-btn" type="submit">Merge selected</button>
              </div>
            </form>
          </div>
        ))
      )}
    </>
  );
}
