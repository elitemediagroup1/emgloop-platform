import Link from 'next/link';

// Demo hub — Sprint 3 (First Customer Loop).
// Entry point that explains the demo and links to its pieces.

const STEPS = [
  'Customer submits an HVAC quote request',
  'Customer + Interaction + Signal + Event records created',
  'AI Employee assigned',
  'Mock AI decides the next action',
  'Mock SMS follow-up sent',
  'Mock customer reply received',
  'Booking created and confirmed (mock calendar)',
  'Timeline + dashboard reflect the completed loop',
];

export default function DemoHubPage() {
  return (
    <div className="shell">
      <nav className="nav">
        <div className="container">
          <Link href="/" className="brand">
            EMG Loop
          </Link>
          <span className="muted">Demo</span>
          <span style={{ marginLeft: 'auto' }}>
            <Link href="/dashboard">Dashboard</Link>
          </span>
        </div>
      </nav>
      <main className="container">
        <h1>First Customer Loop</h1>
        <p className="muted">
          One complete, end-to-end customer journey — built entirely on the
          platform's data model and provider abstractions, with every provider
          mocked. No real AI, SMS, voice, email, calendar, or payments.
        </p>
        <div className="card" style={{ marginTop: '1.5rem' }}>
          <h3 style={{ marginTop: 0 }}>What the loop does</h3>
          <ol>
            {STEPS.map((s) => (
              <li key={s} style={{ margin: '0.35rem 0' }}>
                {s}
              </li>
            ))}
          </ol>
        </div>
        <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem' }}>
          <Link
            href="/demo/intake"
            style={{
              padding: '0.6rem 1.1rem',
              borderRadius: '6px',
              background: '#1f6feb',
              color: '#fff',
              fontWeight: 600,
            }}
          >
            Start a quote request
          </Link>
          <Link
            href="/demo/timeline"
            style={{
              padding: '0.6rem 1.1rem',
              borderRadius: '6px',
              border: '1px solid #d0d7de',
              fontWeight: 600,
            }}
          >
            View latest timeline
          </Link>
        </div>
      </main>
    </div>
  );
}
