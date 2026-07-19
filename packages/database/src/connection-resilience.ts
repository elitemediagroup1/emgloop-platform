// Connection resilience for serverless Postgres.
//
// THE FAILURE THIS EXISTS FOR
//
// Netlify function log, production:
//   prisma:error  Error in PostgreSQL connection: Error { kind: Closed, cause: None }
//
// `kind: Closed` is the query engine reporting that the TCP socket to Postgres
// was ALREADY closed when a query was issued. It is not a timeout, not a refused
// connection, and not a missing credential — the connection existed and then
// went away underneath a client that still believed it was live.
//
// WHY IT HAPPENS HERE, SPECIFICALLY
//
// `prisma` is a module-scoped singleton (packages/database/src/index.ts). A
// Netlify function container stays warm between invocations, so that client —
// and the socket it holds — outlives a single request. Neon suspends an idle
// compute after a few minutes and drops its connections. The next invocation
// reuses the warm container, issues a query on the dead socket, and gets
// `kind: Closed` on the FIRST database call, before any application logic runs.
//
// That matches the observed symptom exactly: the reconciliation route failed
// before CallGrid was ever contacted, because `can()` is the first thing it does
// and `can()` reads the session from Postgres.
//
// WHY IT IS NOT THE OTHER CANDIDATES
//
//   • Not a premature $disconnect(): the only $disconnect() in the repository is
//     in prisma/seed.ts, a script that never runs in a request.
//   • Not a missing DATABASE_URL: a missing variable raises
//     PrismaClientInitializationError ("Environment variable not found"), not a
//     connection error. `kind: Closed` proves the URL was present and parseable
//     and that a connection was established at some point.
//   • Not multiple clients: there is exactly one `new PrismaClient` in the repo.
//
// THE FIX
//
// A closed socket is recoverable: drop it and reconnect. This is applied once,
// as a client extension over every operation, rather than at call sites — a
// per-route guard would leave every other route exposed to the same failure.
//
// This is a mitigation for a real infrastructure behaviour, not a substitute for
// correct configuration. The durable fix is a POOLED connection string, so the
// pooler absorbs compute suspension instead of each container holding a raw
// socket. See docs/DATABASE_CONNECTIONS.md.

/**
 * Whether an error means "the connection went away", as opposed to a genuine
 * query failure. Deliberately narrow: retrying a constraint violation or a
 * malformed query would hide real bugs behind a retry.
 */
export function isConnectionClosedError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? `${error.message} ${(error as { code?: string }).code ?? ''}`
      : String(error);

  return (
    // Prisma query-engine wording for a socket that is already closed.
    /kind:\s*Closed/i.test(message) ||
    /Connection closed/i.test(message) ||
    /connection is closed/i.test(message) ||
    /Server has closed the connection/i.test(message) ||
    // Node/TLS level resets seen when a suspended compute drops the socket.
    /ECONNRESET/i.test(message) ||
    /EPIPE/i.test(message) ||
    // Prisma's initialisation/connection error codes.
    /\bP1001\b/.test(message) || // can't reach database server
    /\bP1017\b/.test(message) // server has closed the connection
  );
}

/**
 * Run a database operation, recovering once from a dropped connection.
 *
 * Exported separately from the client so the recovery rule is unit-testable
 * without a live database — the behaviour that matters (retry exactly once, and
 * only for connection loss) is verified in test rather than asserted in a comment.
 *
 * @param operation  the query to run
 * @param reconnect  drops the dead socket and establishes a new one
 */
export async function runWithReconnect<T>(
  operation: () => Promise<T>,
  reconnect: () => Promise<void>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isConnectionClosedError(error)) throw error;

    // One attempt only. If the second try also fails the database is genuinely
    // unreachable, and a retry loop would turn an outage into a pile-up.
    await reconnect();
    return operation();
  }
}
