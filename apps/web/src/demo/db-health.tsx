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

/** Why a read did not produce data. The caller needs this to be honest on screen. */
export type LoadFailure =
  /** No DATABASE_URL in this environment — nothing was attempted. */
  | { ok: false; cause: 'not-configured'; message: string }
  /** A read was attempted and failed: unreachable host, missing migration, auth. */
  | { ok: false; cause: 'read-failed'; message: string };

export type LoadResult<T> = { ok: true; data: T } | LoadFailure;

/**
 * Run an async database operation without ever rejecting, so a server component
 * can render a fallback.
 *
 * It now reports WHY it failed. The previous version returned a bare
 * `{ ok: false }`, so every caller collapsed "the database is unreachable" and
 * "this organization has no data" into the same empty render — a total outage
 * was pixel-identical to a healthy, empty marketplace. A failure is not an
 * empty state, and a caller cannot tell the operator the difference unless this
 * function tells the caller first.
 */
export async function loadOrFallback<T>(fn: () => Promise<T>): Promise<LoadResult<T>> {
  if (!isDatabaseConfigured()) {
    return { ok: false, cause: 'not-configured', message: DB_NOT_CONFIGURED_MESSAGE };
  }
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return {
      ok: false,
      cause: 'read-failed',
      message:
        error instanceof Error
          ? `The database read did not complete: ${error.message}`
          : 'The database read did not complete.',
    };
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
