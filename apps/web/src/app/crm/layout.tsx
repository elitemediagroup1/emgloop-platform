import Link from 'next/link';
import { headers } from 'next/headers';
import './crm.css';
import './sprint7.css';
import './sprint8.css';
import './sprint9.css';
import './sprint10.css';
import './design-system.css';
import './sprint16.css';
import { getSession } from '../../auth/auth';
import { logoutAction } from '../../auth/actions';
import { EmgLoopWordmark } from './_brand/Logos';
import { SidebarIcon } from './_brand/SidebarIcon';

// CRM layout — Sprint 13 Operating System design language.
//
// Sprint 13 replaces the horizontal top-bar with a premium left sidebar
// (Brain-first information architecture), a sticky command bar with a
// ⌘K affordance, and a System Health / Brain Status footer. This is a
// PRESENTATION-ONLY change: the session read and logout action below are
// unchanged from Sprint 10/11, and every existing route still renders in
// the same content slot. No business logic, data, routing, or auth changes.
//
// Sprint 15 adds Live Operations (Live Activity / Calls / Website Feed) and
// Traffic & Revenue Intelligence nav links — presentation only. Each linked
// page enforces its own permission gate server-side (intelligence / analytics).
//
// Sprint 17.1 (UX): public auth screens (login, forgot/reset password,
// accept-invite, unauthorized) render standalone — inside the .crm theme
// wrapper but WITHOUT the sidebar/app-shell — so the redesigned login is a
// true edge-to-edge front door for logged-out visitors. This is a
// presentation-only branch; the session read and auth behavior are UNCHANGED.

export const metadata = {
  title: 'EMG Loop — Operating System',
};

type NavItem = { href: string; label: string; icon: string; soon?: boolean };
type NavGroup = { label: string; items: NavItem[] };

// Public routes that render without the authenticated app shell.
const STANDALONE_PREFIXES = [
  '/crm/login',
  '/crm/forgot-password',
  '/crm/reset-password',
  '/crm/accept-invite',
  '/crm/unauthorized',
];

function isStandalonePath(pathname: string | null): boolean {
  if (!pathname) return false;
  return STANDALONE_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + '/'),
  );
}

const NAV: NavGroup[] = [
  {
    label: 'Intelligence',
    items: [
      { href: '/crm', label: 'Overview', icon: 'grid' },
      { href: '/crm/intelligence', label: 'Brain', icon: 'brain' },
      { href: '/crm/analytics', label: 'Analytics', icon: 'chart' },
      { href: '/crm/integrations', label: 'Integration OS', icon: 'plug' },
    ],
  },
  {
    label: 'Live Operations',
    items: [
      { href: '/crm/live/activity', label: 'Live Activity', icon: 'activity' },
      { href: '/crm/live/calls', label: 'Live Calls', icon: 'chat' },
      { href: '/crm/live/websites', label: 'Live Website Feed', icon: 'grid' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { href: '/crm/customers', label: 'Customers', icon: 'users' },
      { href: '/crm/conversations', label: 'Conversations', icon: 'chat' },
      { href: '/crm/pipeline', label: 'Pipeline', icon: 'columns' },
      { href: '/crm/inbox', label: 'Calendar', icon: 'calendar' },
      { href: '/crm/ai-employees', label: 'AI Employees', icon: 'robot' },
      { href: '/crm/workflows', label: 'Workflows', icon: 'flow' },
    ],
  },
  {
    label: 'Growth',
    items: [
      { href: '/crm/revenue', label: 'Revenue', icon: 'revenue' },
      { href: '/crm/traffic', label: 'Traffic', icon: 'chart' },
      { href: '/crm/organizations', label: 'Organizations', icon: 'building' },
      { href: '#', label: 'Creators', icon: 'star', soon: true },
      { href: '#', label: 'Business Portal', icon: 'portal', soon: true },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { href: '/crm/users', label: 'Team', icon: 'team' },
      { href: '/crm/settings', label: 'Settings', icon: 'cog' },
    ],
  },
];

function initials(name?: string | null, email?: string | null): string {
  const src = (name || email || '?').trim();
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  const a = parts[0]?.charAt(0) ?? '';
  const b = parts.length > 1 ? (parts[1]?.charAt(0) ?? '') : '';
  const combined = (a + b).toUpperCase();
  return combined || src.slice(0, 2).toUpperCase();
}

export default async function CrmLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  const pathname = headers().get('x-pathname');

  // Public auth screens: standalone, no app shell (keeps the .crm theme wrapper
  // so scoped auth styles still apply). Auth behavior is unchanged.
  if (isStandalonePath(pathname)) {
    return <div className="crm crm--standalone">{children}</div>;
  }

  return (
    <div className="crm">
      <div className="crm-shell">
        <aside className="crm-sidebar">
          <div className="crm-sb-brand">
            <Link href="/crm" aria-label="EMG Loop home">
              <EmgLoopWordmark height={24} />
            </Link>
            <span className="badge">OS</span>
          </div>

          <nav className="crm-sb-scroll" aria-label="Primary">
            {NAV.map((group) => (
              <div key={group.label}>
                <div className="crm-sb-group-label">{group.label}</div>
                {group.items.map((item) =>
                  item.soon ? (
                    <span key={item.label} className="crm-sb-link soon" aria-disabled="true">
                      <span className="ico"><SidebarIcon name={item.icon} /></span>
                      <span className="lbl">{item.label}</span>
                      <span className="crm-sb-pill">Soon</span>
                    </span>
                  ) : (
                    <Link key={item.label} href={item.href} className="crm-sb-link">
                      <span className="ico"><SidebarIcon name={item.icon} /></span>
                      <span className="lbl">{item.label}</span>
                    </Link>
                  )
                )}
              </div>
            ))}
          </nav>

          <div className="crm-sb-foot">
            <div className="crm-sb-stat">
              <span className="crm-dot-live" />
              <span className="label">Brain Status</span>
              <span className="val">Online</span>
            </div>
            <div className="crm-sb-stat">
              <span className="ds-status-dot ok" />
              <span className="label">System Health</span>
              <span className="val">Operational</span>
            </div>
            {session ? (
              <div className="crm-sb-user">
                <span className="crm-sb-avatar">{initials(session.name, session.email)}</span>
                <span className="who">
                  <div className="nm">{session.name ?? session.email ?? 'Account'}</div>
                  <div className="rl">{session.roleLabel ?? 'Member'}</div>
                </span>
                <form action={logoutAction}>
                  <button type="submit" className="crm-signout">Exit</button>
                </form>
              </div>
            ) : null}
          </div>
        </aside>

        <div className="crm-content">
          <header className="crm-appbar">
            <div className="crm-cmdk" role="button" aria-label="Search (Command K)">
              <SidebarIcon name="search" />
              <span>Search customers, signals, knowledge…</span>
              <span className="kbd"><span className="crm-kbd">⌘</span><span className="crm-kbd">K</span></span>
            </div>
            <div className="crm-appbar-right">
              <span className="crm-icon-btn" aria-label="Notifications"><SidebarIcon name="bell" /></span>
              <span className="crm-icon-btn" aria-label="Activity"><SidebarIcon name="activity" /></span>
            </div>
          </header>
          <main className="crm-main">{children}</main>
        </div>
      </div>
    </div>
  );
}
