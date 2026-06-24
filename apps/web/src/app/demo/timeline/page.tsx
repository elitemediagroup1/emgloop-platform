import Link from 'next/link';
import { ensureSeeded } from '../../../demo/seed';
import { getStore, timelineFor } from '../../../demo/store';

// Customer interaction timeline — Sprint 3 (First Customer Loop).
//
// Renders the Interaction spine for one customer: every step of the loop from
// quote request through booking confirmation. The store is process-local, so on
// a cold serverless instance we seed first, then fall back to the most recent
// customer if the requested id is not present.

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  quote_request: 'Quote request submitted',
  assignment: 'AI Employee assigned',
  outbound_message: 'SMS sent',
  inbound_message: 'Customer replied',
  booking_created: 'Booking created',
  booking_confirmed: 'Booking confirmed',
  system_note: 'System note',
};

function dot(kind: string): string {
  if (kind === 'booking_confirmed') return '#1a7f37';
  if (kind === 'booking_created') return '#0969da';
  if (kind === 'inbound_message') return '#8250df';
  if (kind === 'outbound_message') return '#bf8700';
  if (kind === 'assignment') return '#6e7781';
  return '#57606a';
}

export default async function TimelinePage({
  searchParams,
}: {
  searchParams: { customer?: string };
}) {
  await ensureSeeded();
  const store = getStore();
  const requested = searchParams.customer;
  const customer =
    store.customers.find((c) => c.id === requested) ??
    store.customers[store.customers.length - 1];

  const events = customer ? timelineFor(customer.id) : [];
  const booking = customer
    ? store.bookings.find((b) => b.customerId === customer.id)
    : undefined;

  return (
    <div className="shell">
      <nav className="nav">
        <div className="container">
          <Link href="/" className="brand">
            EMG Loop
          </Link>
          <span className="muted">Demo · Timeline</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: '1rem' }}>
            <Link href="/demo/intake">New request</Link>
            <Link href="/dashboard">Dashboard</Link>
          </span>
        </div>
      </nav>
      <main className="container">
        {!customer ? (
          <p className="muted">No customer journeys yet.</p>
        ) : (
          <>
            <h1>{customer.name}</h1>
            <p className="muted">
              {customer.city}, {customer.state} · {customer.phone} ·{' '}
              {customer.email}
            </p>
            {booking ? (
              <div
                className="card"
                style={{ marginTop: '1rem', borderLeft: '4px solid #1a7f37' }}
              >
                <strong>Booking {booking.status}</strong> — {booking.serviceType}
                <div className="muted" style={{ fontSize: '0.85rem' }}>
                  Calendar event: {booking.calendarEventId ?? 'n/a'} (provider:{' '}
                  {booking.calendarProvider ?? 'n/a'})
                </div>
              </div>
            ) : null}
            <h2 style={{ marginTop: '1.5rem' }}>Interaction timeline</h2>
            <ol style={{ listStyle: 'none', padding: 0, marginTop: '1rem' }}>
              {events.map((e) => (
                <li
                  key={e.id}
                  style={{
                    display: 'flex',
                    gap: '0.85rem',
                    padding: '0.6rem 0',
                    borderBottom: '1px solid #eaeef2',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      flex: '0 0 12px',
                      width: '12px',
                      height: '12px',
                      marginTop: '0.3rem',
                      borderRadius: '50%',
                      background: dot(e.kind),
                    }}
                  />
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {KIND_LABEL[e.kind] ?? e.kind}
                    </div>
                    <div className="muted" style={{ fontSize: '0.9rem' }}>
                      {e.summary}
                    </div>
                    {e.body ? (
                      <div style={{ fontSize: '0.9rem', marginTop: '0.2rem' }}>
                        “{e.body}”
                      </div>
                    ) : null}
                    <div className="muted" style={{ fontSize: '0.78rem', marginTop: '0.2rem' }}>
                      {e.channel} · {e.actorType} · {e.createdAt}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </>
        )}
      </main>
    </div>
  );
}
