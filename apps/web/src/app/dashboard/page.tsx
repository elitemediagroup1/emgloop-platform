import Link from 'next/link';

// Dashboard PLACEHOLDER. No real data, no customer-facing features in Sprint 1.
const PANELS = [
  { title: 'Customers', note: 'Unified customer timeline (coming Phase 1)' },
  { title: 'Conversations', note: 'Omni-channel inbox (coming Phase 2)' },
  { title: 'Bookings', note: 'Appointment booking (coming Phase 2)' },
  { title: 'Orders', note: 'AI order taking (coming Phase 3)' },
  { title: 'AI Agents', note: 'Phone & SMS agents (coming Phase 3)' },
  { title: 'Workflows', note: 'Automation engine (coming Phase 5)' },
];

export default function DashboardPage() {
  return (
    <div className="shell">
      <nav className="nav">
        <div className="container">
          <Link href="/" className="brand">
            EMG Loop
          </Link>
          <span className="muted">Dashboard</span>
          <span style={{ marginLeft: 'auto' }}>
            <Link href="/status">Status</Link>
          </span>
        </div>
      </nav>
      <main className="container">
        <h1>Dashboard</h1>
        <p className="muted">
          Placeholder shell. Modules below are not implemented in Sprint 1.
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: '1rem',
            marginTop: '1.5rem',
          }}
        >
          {PANELS.map((p) => (
            <div className="card" key={p.title}>
              <h3 style={{ margin: '0 0 0.5rem' }}>{p.title}</h3>
              <p className="muted" style={{ margin: 0 }}>
                {p.note}
              </p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
