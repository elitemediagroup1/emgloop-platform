import Link from 'next/link';
import './crm.css';
import './sprint7.css';
import './sprint8.css';
import { getSession } from '../../auth/auth';
import { logoutAction } from '../../auth/actions';

// CRM layout — Sprint 5/6 + Sprint 7 (Identity) + Sprint 8 (Conversations).
//
// Wraps every /crm page in the self-contained dark operations theme and a
// persistent top bar. This is an internal tool: minimal chrome, fast nav, no
// marketing. The theme is scoped under the .crm class so it never leaks into
// the existing light demo/dashboard pages. Sprint 7 expanded the nav to the
// full operating-system surface; Sprint 8 adds the unified Conversations
// inbox. The layout reads the session optionally so the auth screens
// (login / reset) still render when unauthenticated.

export const metadata = {
  title: 'EMG Loop — CRM',
};

const NAV: { href: string; label: string }[] = [
  { href: '/crm', label: 'Dashboard' },
  { href: '/crm/customers', label: 'Customers' },
  { href: '/crm/pipeline', label: 'Pipeline' },
  { href: '/crm/conversations', label: 'Conversations' },
  { href: '/crm/inbox', label: 'Inbox' },
  { href: '/crm/search', label: 'Search' },
  { href: '/crm/ai-employees', label: 'AI Employees' },
  { href: '/crm/users', label: 'Users' },
  { href: '/crm/organizations', label: 'Organizations' },
  { href: '/crm/settings', label: 'Settings' },
  { href: '/crm/audit', label: 'Audit' },
];

export default async function CrmLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  return (
    <div className="crm">
      <header className="crm-topbar">
        <Link href="/crm" className="crm-brand">
          <span className="dot" />
          EMG Loop
          <span className="crm-faint" style={{ fontWeight: 500 }}>
            / CRM
          </span>
        </Link>
        {session ? (
          <nav className="crm-nav">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href}>{n.label}</Link>
            ))}
          </nav>
        ) : null}
        <span className="spacer" />
        {session ? (
          <div className="crm-account">
            <span className="who">{session.name}</span>
            <span>· {session.roleLabel}</span>
            <form action={logoutAction}>
              <button className="crm-btn-sm" type="submit">Sign out</button>
            </form>
          </div>
        ) : (
          <Link href="/crm/login" className="crm-btn-ghost crm-btn">Sign in</Link>
        )}
      </header>
      <main className="crm-main">{children}</main>
    </div>
  );
}
