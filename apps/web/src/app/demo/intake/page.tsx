import Link from 'next/link';
import { submitQuoteRequest } from '../../../demo/actions';

// Force this route to be server-rendered so the form's Server Action POST is
// handled by the SSR function (Netlify won't route POSTs to a static page).
export const dynamic = 'force-dynamic';

// Internal demo intake form — Sprint 3 (First Customer Loop).
//
// Represents a ServicesInMyCity HVAC quote request. Submitting it runs the
// full mock loop server-side and redirects to the customer timeline. This is
// NOT wired to the real ServicesInMyCity site yet (out of scope for Sprint 3).

const field = {
  display: 'block',
  width: '100%',
  padding: '0.5rem 0.6rem',
  marginTop: '0.25rem',
  borderRadius: '6px',
  border: '1px solid #d0d7de',
  fontSize: '0.95rem',
} as const;

const label = { display: 'block', marginTop: '0.85rem', fontWeight: 600 } as const;

export default function IntakePage() {
  return (
    <div className="shell">
      <nav className="nav">
        <div className="container">
          <Link href="/" className="brand">
            EMG Loop
          </Link>
          <span className="muted">Demo · Intake</span>
          <span style={{ marginLeft: 'auto' }}>
            <Link href="/dashboard">Dashboard</Link>
          </span>
        </div>
      </nav>
      <main className="container">
        <h1>HVAC Quote Request</h1>
        <p className="muted">
          Internal demo intake (ServicesInMyCity → EMG Loop). Submitting runs the
          full mock customer loop and opens the live timeline.
        </p>
        <form
          action={submitQuoteRequest}
          className="card"
          style={{ marginTop: '1.5rem', maxWidth: '560px' }}
        >
          <label style={label}>
            Customer name
            <input style={field} name="name" defaultValue="Dana Rivera" required />
          </label>
          <label style={label}>
            Phone
            <input style={field} name="phone" defaultValue="+15125550123" required />
          </label>
          <label style={label}>
            Email
            <input
              style={field}
              name="email"
              type="email"
              defaultValue="dana@example.com"
              required
            />
          </label>
          <label style={label}>
            Service type
            <input
              style={field}
              name="serviceType"
              defaultValue="AC repair"
              required
            />
          </label>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <label style={{ ...label, flex: 2 }}>
              City
              <input style={field} name="city" defaultValue="Austin" required />
            </label>
            <label style={{ ...label, flex: 1 }}>
              State
              <input style={field} name="state" defaultValue="TX" required />
            </label>
          </div>
          <label style={label}>
            Preferred appointment window
            <input
              style={field}
              name="preferredWindow"
              defaultValue="Tomorrow morning"
            />
          </label>
          <label style={label}>
            Notes
            <textarea
              style={{ ...field, minHeight: '70px' }}
              name="notes"
              defaultValue="Upstairs unit not cooling."
            />
          </label>
          <button
            type="submit"
            style={{
              marginTop: '1.25rem',
              padding: '0.6rem 1.1rem',
              borderRadius: '6px',
              border: 'none',
              background: '#1f6feb',
              color: '#fff',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Submit quote request
          </button>
        </form>
        <p className="muted" style={{ marginTop: '1rem', fontSize: '0.85rem' }}>
          All providers (AI, SMS, calendar) are mocked. No real messages are sent.
        </p>
      </main>
    </div>
  );
}
