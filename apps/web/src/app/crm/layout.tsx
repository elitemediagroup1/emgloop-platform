import Link from 'next/link';
import './crm.css';

// CRM layout — Sprint 5 (Phase 1) + Sprint 6 (Phase 2).
//
// Wraps every /crm page in the self-contained dark operations theme and a
// persistent top bar. This is an internal tool: minimal chrome, fast nav, no
// marketing. The theme is scoped under the .crm class so it never leaks into
// the existing light demo/dashboard pages. Sprint 6 adds Inbox and Pipeline to
// the nav.

export const metadata = {
  title: 'EMG Loop — CRM',
};

export default function CrmLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="crm">
      <header className="crm-topbar">
        <Link href="/crm/customers" className="crm-brand">
          <span className="dot" />
          EMG Loop
          <span className="crm-faint" style={{ fontWeight: 500 }}>
            / CRM
          </span>
        </Link>
        <nav className="crm-nav">
          <Link href="/crm/customers">Customers</Link>
          <Link href="/crm/pipeline">Pipeline</Link>
          <Link href="/crm/inbox">Inbox</Link>
          <Link href="/crm/search">Search</Link>
          <Link href="/dashboard">Dashboard</Link>
        </nav>
        <span className="spacer" />
        <Link href="/demo/intake" className="crm-btn-ghost crm-btn">
          New intake
        </Link>
      </header>
      <main className="crm-main">{children}</main>
    </div>
  );
}
