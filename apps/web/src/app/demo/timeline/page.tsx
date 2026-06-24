import Link from 'next/link';
import { ensureSeeded } from '../../../demo/seed';
import {
  getCustomer,
  getLatestCustomer,
  timelineFor,
  bookingFor,
} from '../../../demo/store';
import { loadOrFallback, DbNotConfigured } from '../../../demo/db-health';

// Customer interaction timeline — Sprint 4 (Real Data Layer).
//
// Renders the Interaction spine for one customer, read from the DATABASE via
// the repository layer: every step of the loop from quote request through
// booking confirmation. On a cold instance we ensure the demo org is seeded,
// then fall back to the most recently created customer if the requested id is
// not present.
//
// If no database is configured (e.g. a deploy preview) the page degrades to a
// clear internal notice instead of crashing.

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
  const requested = searchParams.customer;

  const result = await loadOrFallback(async () => {
    await ensureSeeded();
    const customer =
      (requested ? await getCustomer(requested) : null) ??
      (await getLatestCustomer());
    const events = customer ? await timelineFor(customer.id) : [];
    const booking = customer ? await bookingFor(customer.id) : null;
    return { customer, events, booking };
  });

  if (!result.ok) {
    return <DbNotConfigured />;
  }

  const { customer, events, booking } = result.data;

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
                      background: dot(String(e.loopKind)),
                    }}
                  />
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {KIND_LABEL[String(e.loopKind)] ?? String(e.loopKind)}
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
                      {e.channel} · {e.actorType} · {e.occurredAt}
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
