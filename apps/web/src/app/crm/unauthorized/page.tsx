// CRM Unauthorized — Sprint 7. Shown when an authenticated user lacks the
// permission for a protected route or action (deny-by-default IAM resolver).

import Link from 'next/link';
import { getSession } from '../../../auth/auth';

export const dynamic = 'force-dynamic';

export default async function UnauthorizedPage({
  searchParams,
}: {
  searchParams: { resource?: string; action?: string };
}) {
  const session = await getSession();
  return (
    <div className="crm-auth-wrap">
      <div className="crm-auth-card">
        <h1>Access denied</h1>
        <p className="crm-auth-sub">
          Your role ({session ? session.roleLabel : 'unknown'}) does not have permission
          {searchParams.action && searchParams.resource
            ? ' to ' + searchParams.action + ' ' + searchParams.resource
            : ' for this area'}.
        </p>
        <div className="crm-auth-error">
          Contact an organization administrator if you believe you should have access.
        </div>
        <div className="crm-inline-actions">
          <Link className="crm-btn-sm" href="/crm">Back to dashboard</Link>
        </div>
      </div>
    </div>
  );
}
