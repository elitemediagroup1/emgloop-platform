import Link from 'next/link';
import { ensureSeeded, getMetrics } from '../../demo/seed';

// Dashboard — Sprint 3 (First Customer Loop).
//
// Shows live demo metrics derived from the in-memory store after the mock loop
// has run for the seeded sample requests. All numbers are synthetic; nothing
// is persisted and no external provider is called.

export const dynamic = 'force-dynamic';

function pct(n: number): string {
  return (n * 100).toFixed(0) + '%';
}

const KIND_LABEL: Record<string, string> = {
  quote_request: 'Quote request',
  assignment: 'AI Employee assigned',
  outbound_message: 'SMS sent',
  inbound_message: 'Customer replied',
  booking_created: 'Booking created',
  booking_confirmed: 'Booking confirmed',
};

export default async function DashboardPage() {
  await ensureSeeded();
  const m = getMetrics();

  const cards = [
    { title: 'Total requests', value: String(m.totalRequests) },
    { title: 'Active interactions', value: String(m.activeInteractions) },
    { title: 'Booked appointments', value: String(m.bookedAppointments) },
    { title: 'Conversion rate', value: pct(m.conversionRate) },
  ];

  return (
    <div className="shell">
      <nav className="nav">
        <div className="container">
          <Link href="/" className="brand">
            EMG Loop
          </Link>
          <span className="muted">Dashboard</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: '1rem' }}>
            <Link href="/demo">Demo</Link>
            <Link href="/status">Status</Link>
          </span>
        </div>
      </nav>
      <main className="container">
        <h1>Dashboard</h1>
        <p className="muted">
          Sprint 3 demo metrics from the First Customer Loop. Seeded mock data —
          no real providers, no persistence.
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: '1rem',
            marginTop: '1.5rem',
          }}
        >
          {cards.map((c) => (
            <div className="card" key={c.title}>
              <div className="muted" style={{ fontSize: '0.85rem' }}>
                {c.title}
              </div>
              <div style={{ fontSize: '2rem', fontWeight: 700, marginTop: '0.25rem' }}>
                {c.value}
              </div>
            </div>
          ))}
        </div>

        <h2 style={{ marginTop: '2rem' }}>Recent timeline activity</h2>
        <div className="card" style={{ marginTop: '0.75rem' }}>
          {m.recentActivity.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>No activity yet.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {m.recentActivity.map((a, i) => (
                <li
                  key={i}
                  style={{
                    padding: '0.5rem 0',
                    borderBottom: '1px solid #eaeef2',
                  }}
                >
                  <strong>{a.customerName}</strong>{' — '}
                  {KIND_LABEL[a.kind] ?? a.kind}
                  <div className="muted" style={{ fontSize: '0.85rem' }}>
                    {a.summary}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="muted" style={{ marginTop: '1.25rem', fontSize: '0.85rem' }}>
          <Link href="/demo/intake">Submit a new quote request</Link> to run the
          loop again.
        </p>
      </main>
    </div>
  );
}
