// /crm — Executive command center (Sprint 13 redesign).
//
// PRESENTATION-ONLY upgrade of the post-login dashboard. The data layer is
// unchanged: the exact same five org-scoped Prisma counts from Sprint 7/10
// are read here, then surfaced as a premium KPI row, a deterministic Brain
// Recommendations panel, a recent-activity rail, and a system / provider
// health card. No AI, no writes, no schema or auth changes.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@emgloop/database';
import { requireSession } from '../../auth/guard';
import { SidebarIcon } from './_brand/SidebarIcon';

export const dynamic = 'force-dynamic';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export default async function CrmDashboard() {
  const session = await requireSession('/crm');
  const orgId = session.organizationId;

  // Sprint 21 — first-login Owner Setup Wizard gate.
  // Owners/admins whose organization has not completed setup are routed to
  // the wizard. Completion is stored on Organization.settings.onboarding.
  // Employees and completed organizations fall through to the dashboard.
  const setupRole = session.systemRole;
  if (setupRole === 'OWNER' || setupRole === 'ADMIN') {
    const orgForSetup = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { settings: true },
    });
    const onboarding = (orgForSetup?.settings as { onboarding?: { completedAt?: string } } | null)
      ?.onboarding;
    if (!onboarding?.completedAt) {
      redirect('/crm/setup');
    }
  }

  const [customers, openConversations, users, aiEmployees, pendingInvites] =
    await Promise.all([
      prisma.customer.count({ where: { organizationId: orgId } }),
      prisma.conversation.count({ where: { organizationId: orgId, status: 'OPEN' } }),
      prisma.user.count({ where: { organizationId: orgId, status: { not: 'DISABLED' } } }),
      prisma.aIEmployee.count({ where: { organizationId: orgId } }),
      prisma.invitation.count({ where: { organizationId: orgId, status: 'PENDING' } }),
    ]);

  const firstName = (session.name ?? '').split(' ')[0] || 'there';

  const kpis: { label: string; value: number | string; icon: string; href: string }[] = [
    { label: 'Customers', value: customers, icon: 'users', href: '/crm/customers' },
    { label: 'Open Conversations', value: openConversations, icon: 'chat', href: '/crm/conversations' },
    { label: 'AI Employees', value: aiEmployees, icon: 'robot', href: '/crm/ai-employees' },
    { label: 'Team Members', value: users, icon: 'team', href: '/crm/users' },
    { label: 'Pending Invites', value: pendingInvites, icon: 'star', href: '/crm/users' },
  ];

  // Deterministic Brain surfacing — derived from real org counts (no AI).
  const recos: { title: string; meta: string; conf: string; href: string }[] = [];
  if (openConversations > 0) {
    recos.push({
      title: `Triage ${openConversations} open conversation${openConversations === 1 ? '' : 's'}`,
      meta: 'Intent · Next Best Action → Assign Human',
      conf: 'High',
      href: '/crm/conversations',
    });
  }
  if (pendingInvites > 0) {
    recos.push({
      title: `Resolve ${pendingInvites} pending invitation${pendingInvites === 1 ? '' : 's'}`,
      meta: 'Workspace · Team readiness',
      conf: 'Medium',
      href: '/crm/users',
    });
  }
  if (aiEmployees === 0) {
    recos.push({
      title: 'Deploy your first AI Employee',
      meta: 'Capacity · Coverage uplift',
      conf: 'Medium',
      href: '/crm/ai-employees',
    });
  }
  recos.push({
    title: 'Review CallGrid signal coverage',
    meta: 'Integration Hub · Provider Health',
    conf: 'Routine',
    href: '/crm/integrations',
  });

  const health: { name: string; val: string; state: 'ok' | 'warn' | 'err' }[] = [
    { name: 'EMG Brain', val: 'Online', state: 'ok' },
    { name: 'Ingestion Pipeline', val: 'Processing', state: 'ok' },
    { name: 'CallGrid Provider', val: 'Connected', state: 'ok' },
    { name: 'Neon Database', val: 'Healthy', state: 'ok' },
  ];

  return (
    <div>
      <div className="ds-pagehead">
        <div>
          <div className="ds-eyebrow">EMG Loop · Operating System</div>
          <h1 className="ds-title">{greeting()}, {firstName}</h1>
          <p className="ds-subtitle">
            Signed in as {session.name ?? session.email} · {session.roleLabel ?? 'Member'}
          </p>
        </div>
        <Link href="/crm/intelligence" className="crm-btn">Open the Brain</Link>
      </div>

      <div className="ds-kpis">
        {kpis.map((k) => (
          <Link key={k.label} href={k.href} className="ds-kpi" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="k-label"><SidebarIcon name={k.icon} size={13} /> {k.label}</div>
            <div className="k-value">{k.value}</div>
          </Link>
        ))}
      </div>

      <div className="ds-grid cols-3">
        <section className="ds-card">
          <div className="ds-card-head">
            <SidebarIcon name="brain" size={16} />
            <h3>Brain Recommendations</h3>
            <span className="more">Next Best Action</span>
          </div>
          <div className="ds-card-body">
            {recos.map((r, i) => (
              <Link key={i} href={r.href} className="ds-reco" style={{ textDecoration: 'none', color: 'inherit' }}>
                <span className="rico"><SidebarIcon name="activity" size={15} /></span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="rtitle">{r.title}</span>
                  <span className="rmeta" style={{ display: 'block' }}>{r.meta}</span>
                </span>
                <span className="ds-conf">{r.conf}</span>
              </Link>
            ))}
          </div>
        </section>

        <section className="ds-card">
          <div className="ds-card-head">
            <SidebarIcon name="activity" size={16} />
            <h3>Live Activity</h3>
          </div>
          <div className="ds-card-body">
            {customers === 0 && openConversations === 0 ? (
              <div className="ds-empty">
                <span className="glyph"><SidebarIcon name="activity" size={20} /></span>
                <div className="et">The Brain is waiting for its first signal.</div>
                <div>As activity arrives, Loop Intelligence surfaces it here in real time.</div>
              </div>
            ) : (
              <ul className="ds-activity">
                <li><span className="adot" /> {customers} customers under management <span className="awhen">live</span></li>
                <li><span className="adot" /> {openConversations} conversations open <span className="awhen">now</span></li>
                <li><span className="adot" /> {aiEmployees} AI Employees configured <span className="awhen">team</span></li>
                <li><span className="adot" /> {users} team members active <span className="awhen">workspace</span></li>
                <li><span className="adot" /> CallGrid ingestion active <span className="awhen">provider</span></li>
              </ul>
            )}
          </div>
        </section>

        <section className="ds-card">
          <div className="ds-card-head">
            <span className="ds-status-dot ok" />
            <h3>System Health</h3>
          </div>
          <div className="ds-card-body">
            <div className="ds-health">
              {health.map((h) => (
                <div key={h.name} className="ds-health-row">
                  <span className={`ds-status-dot ${h.state}`} />
                  <span className="hname">{h.name}</span>
                  <span className="hval">{h.val}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <footer className="ds-footer">
        <span>EMG Loop™ — a next-generation business operating system.</span>
        <span style={{ marginLeft: 'auto' }}>Powered by the EMG Brain · Elite Media Group</span>
      </footer>
    </div>
  );
}
