// The worker's DERIVED-WORK RETENTION sweep: the §21.2 "voluntary disconnect: frozen, deleted at
// 30 days" row (docs/architecture/daily-loop-employee-intelligence.md), for the items a model derived
// from a background source's content (Telegram conversation triage).
//
// WHAT IT DOES. Discover, across every tenant, the connections that are NOT live and whose disconnect
// is older than the grace window; for each, ask the repository to delete that ONE principal's derived
// items -- and their domain-intelligence digests (Loop Intelligence PR A, 2026-09-24) -- for that ONE
// provider. The repository re-resolves the connection in scope inside its own
// transaction and refuses one that is live again (a reconnect inside the month keeps the frozen
// queue) or still inside the window -- and it applies the grace window itself from the shared
// constant, so this sweep cannot shorten it. The audit row is the repository's, with counts only.
//
// WHAT IT NEVER DOES. It never reads a credential, never opens a session, never touches the live
// observation cursor, the baseline checkpoint or the content cursor, and never sees a row: the ports
// return routing fields and counts. It logs counts only, never an id.
//
// Behind ports so it runs without a database (the test uses fakes).

import type { DerivedExpiryOutcome, DueDerivedExpiry } from '@emgloop/database';

export interface DerivedRetentionPorts {
  /** Connections disconnected past the grace window, platform-wide (routing fields only). */
  dueForDerivedExpiry(now: Date): Promise<readonly DueDerivedExpiry[]>;
  /** Delete one principal's derived items for one provider, if still past grace and not live; audited inside. */
  expireDerivedWork(due: DueDerivedExpiry, now: Date): Promise<DerivedExpiryOutcome>;
  now(): Date;
}

export interface DerivedRetentionSummary {
  /** Connections discovery returned. */
  readonly due: number;
  /** Principals whose derived items were deleted. */
  readonly principals: number;
  /** Items deleted, across all principals. */
  readonly deleted: number;
  /** Domain-intelligence digests deleted, across all principals. */
  readonly digests: number;
  /** Connections that discovery returned but the scoped delete refused (live again, inside the window, nothing to delete). */
  readonly skipped: number;
  /** Deletes that threw; the connection is retried on the next sweep. */
  readonly failed: number;
}

export async function runDerivedRetentionSweep(ports: DerivedRetentionPorts): Promise<DerivedRetentionSummary> {
  const now = ports.now();
  const due = await ports.dueForDerivedExpiry(now);
  let principals = 0;
  let deleted = 0;
  let digests = 0;
  let skipped = 0;
  let failed = 0;
  for (const connection of due) {
    try {
      const outcome = await ports.expireDerivedWork(connection, now);
      if (outcome.outcome === 'EXPIRED') {
        principals += 1;
        deleted += outcome.items;
        digests += outcome.digests;
      } else {
        skipped += 1;
      }
    } catch {
      // One principal's failure never stops the sweep; the row is still due next time.
      failed += 1;
    }
  }
  return { due: due.length, principals, deleted, digests, skipped, failed };
}
