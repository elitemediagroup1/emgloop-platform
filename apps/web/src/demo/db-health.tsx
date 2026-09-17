// DB availability guard — Sprint 4 (Real Data Layer).
//
// CRM and admin pages read from PostgreSQL at request time. In non-production
// contexts (e.g. a Netlify deploy preview) there may be no DATABASE_URL and no
// reachable database. These helpers let those pages degrade gracefully instead
// of crashing. (The directory name is historical; nothing here is demo data.)
//
// Scope: presentation-only guarding. No providers, auth, or business logic.

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
 * The notice a page shows when it has no data to render: its read failed, the
 * environment has no database, or the read returned nothing the page can show.
 *
 * IT SAYS WHICH. This used to be `DataUnavailable`, and it told every visitor the
 * database was "not configured" whenever any read failed, in environments where
 * the database was configured and a query had simply failed. That is a false
 * statement about the system, and it sent operators to fix configuration that was
 * fine. Only an environment with no DATABASE_URL gets the setup notice; everywhere
 * else the page says its data could not be shown, and that this is not a finding.
 *
 * Rendered inside the Loop shell; it draws no chrome of its own.
 */
export function DataUnavailable() {
  if (!isDatabaseConfigured()) {
    return (
      <div className="ds-card crm-load-error" role="alert">
        <div className="ds-card-body">
          <h1 className="crm-load-error__title">{DB_NOT_CONFIGURED_MESSAGE}</h1>
          <p className="crm-load-error__desc">
            This page reads real data from PostgreSQL, and this environment has no
            database connection string, so nothing can be shown here.
          </p>
          <p className="crm-load-error__desc">
            To enable it: set <code>DATABASE_URL</code> and apply the schema with{' '}
            <code>prisma migrate deploy</code>.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="ds-card crm-load-error" role="alert">
      <div className="ds-card-body">
        <h1 className="crm-load-error__title">This page&apos;s data could not be shown</h1>
        <p className="crm-load-error__desc">
          Loop could not load or measure what this page needs right now. Nothing is shown
          rather than a partial or empty view, and this is not a finding that nothing
          exists. Try again shortly.
        </p>
      </div>
    </div>
  );
}
