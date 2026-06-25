// CRM Audit & Security — Sprint 7 (Identity, Authentication & Organizations).
//
// Read-only security log: every identity-relevant action (login, logout, user
// created/updated/disabled/removed, permission changes, AI Employee changes,
// organization changes) recorded via the AuditRepository, newest first, with
// category filter chips. Protected by audit:view. Persisted to Neon.

import Link from 'next/link';
import { requirePermission } from '../../../auth/guard';
import { repositories } from '@emgloop/database';

export const dynamic = 'force-dynamic';

function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: { category?: string };
}) {
  const session = await requirePermission('audit', 'view');
  const category = searchParams.category;
  const [entries, categories] = await Promise.all([
    repositories.audit.list(session.organizationId, {
      actionPrefix: category ? category + '.' : undefined,
      take: 200,
    }),
    repositories.audit.actionCategories(session.organizationId),
  ]);

  return (
    <div className="crm-page">
      <div className="crm-page-head">
        <div>
          <h1>Audit &amp; Security</h1>
          <p>{entries.length} recent event(s)</p>
        </div>
      </div>

      <div className="crm-inline-actions" style={{ marginBottom: 14 }}>
        <Link className={'crm-btn-sm' + (!category ? ' crm-badge role' : '')} href="/crm/audit">All</Link>
        {categories.map((c) => (
          <Link key={c} className={'crm-btn-sm' + (category === c ? ' crm-badge role' : '')} href={'/crm/audit?category=' + c}>{c}</Link>
        ))}
      </div>

      {entries.length === 0 ? (
        <p className="crm-faint">No audit events yet. Identity actions will appear here as they happen.</p>
      ) : (
        <div>
          {entries.map((e) => (
            <div className="crm-audit-row" key={e.id}>
              <span className="when">{fmt(e.createdAt)}</span>
              <span className="act">{e.action}</span>
              <span className="crm-faint">by {e.actorName}{e.entityType ? ' · ' + e.entityType : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
