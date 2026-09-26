// HELD intelligence refresh requests past their governed retention window (Loop Intelligence).
//
// THE WINDOW IS THE POLICY'S. INTELLIGENCE_REFRESH_REQUESTS (@emgloop/shared work-state.ts, rule DAYS,
// anchored on a HELD request last changing) is the only source of the number; this step reads it and
// never carries its own. A policy that is missing or not day-counted purges nothing (fail closed: the
// HELD row is a freshness barrier, and keeping it is always the safe side).
//
// THE PURGE IS THE REPOSITORY'S. IntelligenceRefreshQueueRepository.purgeHeld moves each target's
// stored reading out of CURRENT and deletes its HELD row in ONE transaction, and answers zero before the
// queue's migration. This step only decides the cutoff and reports a count -- never an organization, a
// person, a domain or a subject. A failure is reported by name and never thrown: the sweep's other steps
// must run whatever happens here. Nothing about it depends on any intelligence feature being activated.

import { workRetentionCategory } from '@emgloop/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface HeldRefreshRetentionPorts {
  readonly purgeHeld: (cutoff: Date) => Promise<{ readonly purged: number }>;
  readonly now: () => Date;
  readonly log: (event: string, fields?: Record<string, unknown>) => void;
}

/** The cutoff the governed policy gives at `now`, or null when the policy does not define a day window. */
export function heldRefreshCutoff(now: Date): Date | null {
  const policy = workRetentionCategory('INTELLIGENCE_REFRESH_REQUESTS');
  if (!policy || policy.rule !== 'DAYS' || typeof policy.days !== 'number' || !Number.isFinite(policy.days) || policy.days <= 0) return null;
  return new Date(now.getTime() - policy.days * DAY_MS);
}

export async function runHeldRefreshRetention(ports: HeldRefreshRetentionPorts): Promise<{ readonly purged: number } | null> {
  const cutoff = heldRefreshCutoff(ports.now());
  if (!cutoff) {
    ports.log('refresh_purge_skipped', { reason: 'NO_DAY_WINDOW' });
    return null;
  }
  try {
    const { purged } = await ports.purgeHeld(cutoff);
    if (purged > 0) ports.log('refresh_purge', { purged });
    return { purged };
  } catch (err) {
    ports.log('refresh_purge_error', { name: (err as Error)?.name ?? 'error' });
    return null;
  }
}
