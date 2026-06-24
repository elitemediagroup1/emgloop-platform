import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="shell">
      <nav className="nav">
        <div className="container">
          <span className="brand">EMG Loop</span>
          <span className="muted">AI-first operating system</span>
          <span style={{ marginLeft: 'auto' }}>
            <Link href="/login">Login</Link>
          </span>
        </div>
      </nav>
      <main className="container">
        <h1>EMG Loop</h1>
        <p className="muted">
          An AI-first operating system for customer-facing businesses. This is the
          Sprint 1 app shell &mdash; foundation only.
        </p>
        <div className="card" style={{ marginTop: '1.5rem' }}>
          <p>Available placeholders:</p>
          <ul>
            <li>
              <Link href="/login">Login</Link>
            </li>
            <li>
              <Link href="/dashboard">Dashboard</Link>
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
