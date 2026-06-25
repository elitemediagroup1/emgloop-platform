import Link from 'next/link';
import './crm.css';
import './sprint7.css';
import './sprint8.css';
import './sprint9.css';
import './sprint10.css';
import { getSession } from '../../auth/auth';
import { logoutAction } from '../../auth/actions';


// CRM layout — Sprint 5/6 + Sprint 7 (Identity) + Sprint 8 (Conversations)
// + Sprint 9 (Workflows) + Sprint 10 (Loop Intelligence Foundation).
//
// Wraps every /crm page in the self-contained dark operations theme and a
// persistent top bar. Sprint 10 adds Analytics, Integrations, and Loop
// Intelligence to the nav.


export const metadata = {
  title: 'EMG Loop — CRM',
};


const NAV: { href: string; label: string }[] = [
  { href: '/crm', label: 'Dashboard' },
  { href: '/crm/customers', label: 'Customers' },
  { href: '/crm/pipeline', label: 'Pipeline' },
  { href: '/crm/conversations', label: 'Conversations' },
  { href: '/crm/workflows', label: 'Workflows' },
  { href: '/crm/inbox', label: 'Inbox' },
  { href: '/crm/search', label: 'Search' },
  { href: '/crm/analytics', label: 'Analytics' },
  { href: '/crm/intelligence', label: 'Intelligence' },
  { href: '/crm/ai-employees', label: 'AI Employees' },
  { href: '/crm/integrations', label: 'Integrations' },
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
          <span>EMG Loop</span>
        </Link>
        <nav className="crm-nav">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="crm-nav-link">
              {item.label}
            </Link>
          ))}
        </nav>
        {session ? (
          <div className="crm-account">
            <span className="crm-account-name">{session.userEmail ?? 'Account'}</span>
            <form action={logoutAction}>
              <button type="submit" className="crm-signout">Sign out</button>
            </form>
          </div>
        ) : null}
      </header>
      <main className="crm-main">{children}</main>
    </div>
  );
}
