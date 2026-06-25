import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="shell">
      <nav className="nav">
        <div className="container">
          <span className="brand">EMG Loop</span>
          <span className="muted">AI-first operating system</span>
          <span style={{ marginLeft: 'auto' }}>
            <Link href="/crm">CRM</Link>
            {' · '}
            <Link href="/login">Login</Link>
          </span>
        </div>
      </nav>
      <main className="container">
        <h1>EMG Loop</h1>
        <p className="muted">
          An AI-first operating system for customer-facing businesses. Sprint 3
          ships the first end-to-end customer loop, running entirely on mock
          providers.
        </p>
        <div className="card" style={{ marginTop: '1.5rem' }}>
          <p>Explore:</p>
          <ul>
            <li>
              <Link href="/crm">Internal CRM (operations console)</Link>
            </li>
            <li>
              <Link href="/demo">First Customer Loop (demo)</Link>
            </li>
            <li>
              <Link href="/dashboard">Dashboard</Link>
            </li>
            <li>
              <Link href="/login">Login</Link>
            </li>
            <li>
              <Link href="/status">Health / Status</Link>
            </li>
          </ul>
        </div>
      </main>
    </div>
  );
}
