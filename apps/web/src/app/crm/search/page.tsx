import Link from 'next/link';
import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';
import { crmRepos, resolveCrmOrganizationId } from '../../../crm/crm-data';

// Global customer search — Sprint 5 (Internal CRM, Phase 1).
//
// Searches across name, company, email, phone, address and external IDs by
// delegating to the repository layer's customer search (which queries Neon).
// No mock data; results link straight into the customer workspace.

export const dynamic = 'force-dynamic';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: { q?: string };
}) {
  const q = (searchParams?.q ?? '').trim();

  const result = await loadOrFallback(async () => {
    const organizationId = await resolveCrmOrganizationId();
    if (!organizationId || !q) {
      return { rows: [], total: 0, hasOrg: Boolean(organizationId) };
    }
    const list = await crmRepos.crm.listCustomers(organizationId, {
      search: q,
      pageSize: 50,
      page: 1,
    });
    return { rows: list.rows, total: list.total, hasOrg: true };
  });

  if (!result.ok) return <DbNotConfigured />;

  const { rows, total } = result.data;

  return (
    <>
      <h1 className="crm-h1">Search</h1>
      <p className="crm-sub">
        Global customer search across name, company, email, phone, address and
        external IDs.
      </p>

      <form className="crm-toolbar" method="get" action="/crm/search">
        <input
          className="crm-input crm-search"
          type="text"
          name="q"
          defaultValue={q}
          autoFocus
          placeholder="Search customers…"
        />
        <button className="crm-btn" type="submit">
          Search
        </button>
      </form>

      {!q ? (
        <div className="crm-panel crm-empty">Type a query to search.</div>
      ) : rows.length === 0 ? (
        <div className="crm-panel crm-empty">
          No customers match “{q}”.
        </div>
      ) : (
        <>
          <p className="crm-muted" style={{ fontSize: '0.8rem' }}>
            {total} result{total === 1 ? '' : 's'}
          </p>
          <div className="crm-panel">
            <table className="crm-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Company</th>
                  <th>Phone</th>
                  <th>Email</th>
                  <th>City / State</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={'/crm/customers/' + c.id} className="crm-cell-name">
                        {c.name}
                      </Link>
                    </td>
                    <td>{c.company || <span className="crm-faint">—</span>}</td>
                    <td>{c.phone || <span className="crm-faint">—</span>}</td>
                    <td>{c.email || <span className="crm-faint">—</span>}</td>
                    <td>
                      {c.city || c.state ? (
                        <>
                          {c.city}
                          {c.city && c.state ? ', ' : ''}
                          {c.state}
                        </>
                      ) : (
                        <span className="crm-faint">—</span>
                      )}
                    </td>
                    <td>
                      <span className={'crm-status ' + c.status}>{c.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
