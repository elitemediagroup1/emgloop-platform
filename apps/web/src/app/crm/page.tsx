// /crm — Sprint 5 redirect, upgraded in Sprint 7 to the protected dashboard.
//
// The CRM home now requires an authenticated session (redirecting to the login
// page if absent) and renders an operations dashboard with org-scoped counts
// read from Neon plus quick links into each area. This is the post-login
// landing surface.

import Link from 'next/link';
import { prisma } from '@emgloop/database';
import { requireSession } from '../../auth/guard';

export const dynamic = 'force-dynamic';

export default async function CrmDashboard() {
  const session = await requireSession('/crm');
  const orgId = session.organizationId;

  const [customers, openConversations, users, aiEmployees, pendingInvites] =
    await Promise.all([
      prisma.customer.count({ where: { organizationId: orgId } }),
      prisma.conversation.count({ where: { organizationId: orgId, status: 'OPEN' } }),
      prisma.user.count({ where: { organizationId: orgId, status: { not: 'DISABLED' } } }),
      prisma.aIEmployee.count({ where: { organizationId: orgId } }),
      prisma.invitation.count({ where: { organizationId: orgId, status: 'PENDING' } }),
    ]);

  const tiles: { label: string; value: number; href: string }[] = [
    { label: 'Customers', value: customers, href: '/crm/customers' },
    { label: 'Open conversations', value: openConversations, href: '/crm/inbox' },
    { label: 'Team members', value: users, href: '/crm/users' },
    { label: 'AI Employees', value: aiEmployees, href: '/crm/ai-employees' },
    { label: 'Pending invitations', value: pendingInvites, href: '/crm/users' },
  ];

  return (
    <div className="crm-page">
      <div className="crm-page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Signed in as {session.name} · {session.roleLabel}</p>
        </div>
      </div>
      <div className="crm-grid">
        {tiles.map((t) => (
          <Link key={t.label} href={t.href} className="crm-card" style={{ textDecoration: 'none', color: 'inherit' }}>
            <h3 style={{ fontSize: 28, marginBottom: 2 }}>{t.value}</h3>
            <p>{t.label}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
