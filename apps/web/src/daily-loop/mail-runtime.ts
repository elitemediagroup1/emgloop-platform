// Gmail synchronization, bound to this runtime. SERVER ONLY.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6 (GM-1, GM-2).
//
// TWO OF THE THREE FRESHNESS PATHS LIVE HERE -- a visit, and a person asking by hand. The third
// is the scheduled cycle, which performs the SAME sync through the same assembly. What differs is
// only who decided to spend the call, and how often that is allowed.
//
// A REFUSAL IS NOT A FAILURE. `refreshEmployeeGmail` answers whether a read actually happened, so
// a caller can say how current Loop is; a refusal (too soon, unusable connection, one already in
// flight) leaves everything exactly as it was.

import 'server-only';

import { GMAIL_FRESHNESS_POLICY, shouldHonourManualRefresh } from '@emgloop/shared';
import { WorkSourceRepository, createEmployeeGmailSync, prisma, type WorkPrincipal } from '@emgloop/database';

import { googleSigningKeys } from '../google/google-runtime';
import { readGoogleEnvironment } from '../google/google-environment';

function gmailSync() {
  const env = readGoogleEnvironment();
  // A deployment with no Google client passes null and is refused as NOT_CONFIGURED by the same
  // token path as always.
  return createEmployeeGmailSync({ prisma, google: env.state === 'CONFIGURED' ? env : null, signingKeys: googleSigningKeys() });
}

/** Synchronize this employee's mailbox. Returns whether a read actually completed. */
export async function refreshEmployeeGmail(principal: WorkPrincipal): Promise<boolean> {
  try {
    const result = await gmailSync().syncGmail(principal);
    return result.outcome !== 'FAILED';
  } catch {
    // A refresh that could not happen changes how current Loop says it is, never what it shows.
    return false;
  }
}

/**
 * A person asking for a fresh read by hand. Honoured once every thirty seconds, for their own
 * mailbox only.
 *
 * The floor is not rate limiting for its own sake: a refresh spends this employee's Google quota,
 * and two clicks in a second cannot make a mailbox newer than one.
 */
export async function refreshMailByHand(principal: WorkPrincipal): Promise<boolean> {
  const sources = new WorkSourceRepository(prisma);
  const cursor = await sources.cursor(principal, 'GMAIL');
  if (!shouldHonourManualRefresh(cursor?.lastSyncStartedAt ?? null, new Date(), GMAIL_FRESHNESS_POLICY)) return false;
  return refreshEmployeeGmail(principal);
}
