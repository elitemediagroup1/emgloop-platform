// DB availability guard — Sprint 4 (Real Data Layer).
//
// The repository-backed pages (/dashboard, /demo/timeline) read from
// PostgreSQL at request time. In non-production contexts (e.g. a Netlify
// deploy preview) there may be no DATABASE_URL and no reachable database.
// These helpers let those pages degrade gracefully instead of crashing.
//
// Scope: presentation-only guarding. No providers, auth, or business logic.

import Link from 'next/link';

export const DB_NOT_CONFIGURED_MESSAGE =
  'Database is not configured for this environment yet.';

/** True when a database connection string is present in the environment. */
export function isDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Run an async database operation, returning { ok: true, data } on success or
 * { ok: false } if the database is not configured or the call throws (e.g. a
 * connection error). Never rejects, so server components can render a fallback.
 */
export async function loadOrFallback<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false }> {
  if (!isDatabaseConfigured()) return { ok: false };
  try {
    return { ok: true, data: await fn() };
  } catch {
    // Missing migration, unreachable host, auth failure, etc. — degrade.
    return { ok: false };
  }
}

/**
 * Internal notice shown when the database is unavailable. Explains, for
 * operators, exactly what production needs. Intentionally plain and honest.
 */
export function DbNotConfigured() {
  return (
    <div className="shell">
      <nav className="nav">
        <div className="container">
          <Link href="/" className="brand">
            EMG Loop
          </Link>
          <span className="muted">Database not configured</span>
        </div>
      </nav>
      <main className="container">
        <h1>{DB_NOT_CONFIGURED_MESSAGE}</h1>
        <p className="muted">
          This page reads real data from PostgreSQL. The current environment has
          no reachable database, so live metrics and timelines are unavailable.
        </p>
        <div className="card" style={{ marginTop: '1.25rem' }}>
          <strong>To enable this in production:</strong>
          <ol style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
            <li>
              Set <code>DATABASE_URL</code> to a PostgreSQL connection string.
            </li>
            <li>
              Apply the schema with <code>prisma migrate deploy</code>.
            </li>
            <li>
              Optionally run the seed (<code>npm run -w @emgloop/database seed</code>)
              for demo data.
            </li>
          </ol>
        </div>
      </main>
    </div>
  );
}
