import Link from 'next/link';

// Health / Status page. Shows platform + module status. In Sprint 1 everything
// downstream is intentionally "not configured".
const SERVICES = [
  { name: 'Web app shell', status: 'operational' },
  { name: 'Database (PostgreSQL)', status: 'not configured' },
  { name: 'AI provider', status: 'not configured' },
  { name: 'Voice provider', status: 'not configured' },
  { name: 'SMS provider', status: 'not configured' },
  { name: 'Email provider', status: 'not configured' },
  { name: 'Payment provider', status: 'not configured' },
  { name: 'Calendar provider', status: 'not configured' },
];

export default function StatusPage() {
  return (
    <div className="shell">
      <nav className="nav">
        <div className="container">
          <Link href="/" className="brand">
            EMG Loop
          </Link>
          <span className="muted">Status</span>
        </div>
      </nav>
      <main className="container">
        <h1>Health &amp; Status</h1>
        <p>
          <span className="dot-ok" />
          App shell operational. Machine-readable health at{' '}
          <Link href="/api/health">/api/health</Link>.
        </p>
        <div className="card" style={{ marginTop: '1rem' }}>
          {SERVICES.map((s) => (
            <div
              key={s.name}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '0.5rem 0',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <span>{s.name}</span>
              <span className="badge">{s.status}</span>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
