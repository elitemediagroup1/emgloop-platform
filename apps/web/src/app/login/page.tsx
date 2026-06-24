import Link from 'next/link';

// Login PLACEHOLDER. Real authentication (provider-agnostic) lands in Phase 1.
// No auth logic, no credentials handled here in Sprint 1.
export default function LoginPage() {
  return (
    <div className="shell">
      <nav className="nav">
        <div className="container">
          <Link href="/" className="brand">
            EMG Loop
          </Link>
        </div>
      </nav>
      <main className="container" style={{ maxWidth: 420 }}>
        <h1>Sign in</h1>
        <p className="muted">
          Placeholder only &mdash; authentication is not implemented in Sprint 1.
        </p>
        <div className="card" style={{ marginTop: '1rem' }}>
          <label>
            Email
            <input className="input" type="email" placeholder="you@business.com" disabled />
          </label>
          <label style={{ display: 'block', marginTop: '1rem' }}>
            Password
            <input className="input" type="password" placeholder="********" disabled />
          </label>
          <button className="btn" style={{ marginTop: '1.25rem' }} disabled>
            Continue (disabled)
          </button>
        </div>
        <p className="muted" style={{ marginTop: '1rem' }}>
          <Link href="/dashboard">Skip to dashboard placeholder</Link>
        </p>
      </main>
    </div>
  );
}
