// The generic intelligence producer loop. Loop Intelligence PR 2 (the fabric), 2026-09-26.
//
//   claim -> resolve the ACTIVE producer -> gather governed context -> fingerprint
//         -> UNCHANGED? complete, no read, no model call
//         -> read (RULE: deterministic; MODEL: the governed AI runtime)
//         -> write the digest through the repository (which validates the participation contract,
//            the scope rules and, for a consent-bound source, the consent at the moment of the write)
//         -> complete / retry with backoff / hold
//
// NOTHING HERE RUNS WITHOUT AN ACTIVE PRODUCER. The loop claims only in domains an active producer
// exists for; with none active it claims nothing. A request for a domain with no active producer waits
// (it is not claimed), and a claimed request whose producer went away is held, never guessed at.
//
// ONE CYCLE IS BOUNDED: at most `limit` requests, each under a lease.

import type { IntelligenceDigestRepository, IntelligenceDigestWriteOutcome } from '../../repositories/intelligence/intelligence-digest.repository';
import type { IntelligenceRefreshClaim, IntelligenceRefreshQueueRepository } from '../../repositories/intelligence/intelligence-refresh-queue.repository';
import type { IntelligenceProducerRegistry } from './producer';

export interface ProducerLoopDeps {
  readonly queue: Pick<IntelligenceRefreshQueueRepository, 'claim' | 'complete' | 'retry' | 'hold'>;
  readonly digests: Pick<IntelligenceDigestRepository, 'storedFingerprint' | 'upsert' | 'upsertOrganization' | 'markTargetStale' | 'reaffirmTarget'>;
  readonly registry: IntelligenceProducerRegistry;
  readonly leaseOwner: string;
  readonly now: () => Date;
}

export interface ProducerLoopOptions {
  readonly limit: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  /** Backoff before attempt n+1, from the attempt count. Default: 1, 5, 15, 60 minutes. */
  readonly backoffMs?: (attempts: number) => number;
}

/** What one cycle did. Counts and outcome codes only -- never a target, a subject or content. */
export interface ProducerLoopReport {
  readonly claimed: number;
  readonly written: number;
  readonly unchanged: number;
  readonly skippedUnchangedBeforeRead: number;
  readonly noEvidence: number;
  readonly retried: number;
  readonly held: number;
  readonly outcomes: Readonly<Record<string, number>>;
}

const DEFAULT_BACKOFF = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const defaultBackoff = (attempts: number) => DEFAULT_BACKOFF[Math.min(Math.max(attempts - 1, 0), DEFAULT_BACKOFF.length - 1)]!;

/** Write refusals that will not change on retry: hold them for an operator. */
const HOLD_REFUSALS = new Set([
  'ORGANIZATION_SCOPE_RESERVED',
  'WRONG_SCOPE',
  'SCOPE_NOT_ALLOWED_FOR_DOMAIN',
  'PRIVATE_EVIDENCE',
  'INVALID_ENTITY_REFS',
  'INVALID_INPUT',
  'INVALID_CONTENT',
  'CONSENT_BASIS_MISMATCH',
  'CONSENT_NOT_IN_FORCE',
  'NOT_AN_ACTIVE_MEMBER',
  'EXPIRED_AT_WRITE',
]);

export async function runIntelligenceProducerCycle(deps: ProducerLoopDeps, options: ProducerLoopOptions): Promise<ProducerLoopReport> {
  const outcomes: Record<string, number> = {};
  const tally = { claimed: 0, written: 0, unchanged: 0, skippedUnchangedBeforeRead: 0, noEvidence: 0, retried: 0, held: 0 };
  const note = (code: string) => {
    outcomes[code] = (outcomes[code] ?? 0) + 1;
  };
  const domains = deps.registry.activeDomains();
  if (domains.length === 0) return { ...tally, outcomes };

  const claims = await deps.queue.claim({ leaseOwner: deps.leaseOwner, now: deps.now(), leaseMs: options.leaseMs, limit: options.limit, domains });
  tally.claimed = claims.length;
  const backoff = options.backoffMs ?? defaultBackoff;

  const ownerOf = (t: IntelligenceRefreshClaim['target']) =>
    t.scope === 'PRINCIPAL' ? ({ scope: 'PRINCIPAL', principal: { organizationId: t.organizationId, userId: t.userId } } as const) : ({ scope: 'ORGANIZATION', organizationId: t.organizationId } as const);
  // A refresh that ends without a reading (NO_EVIDENCE, HELD) means the prior one no longer stands: it
  // must be STALE from now on. FAIL CLOSED: the queue row is the freshness barrier while it exists, so it
  // is removed only AFTER the stale transition succeeded. A failed transition is never swallowed --
  //   NO_EVIDENCE  the request is retried (it stays PENDING, still blocking), never completed;
  //   HELD         the row is held regardless (still blocking), and purgeHeld moves the reading and
  //                deletes the row in one transaction, so cleanup can never expose a CURRENT reading.
  const staleTarget = async (claim: IntelligenceRefreshClaim): Promise<boolean> => {
    try {
      await deps.digests.markTargetStale(ownerOf(claim.target), claim.target);
      return true;
    } catch {
      note('STALE_TRANSITION_FAILED');
      return false;
    }
  };
  const hold = async (claim: IntelligenceRefreshClaim, code: string) => {
    note(code);
    // Stale first; the HELD row keeps blocking whether or not that succeeded.
    await staleTarget(claim);
    if (await deps.queue.hold(claim, code)) tally.held += 1;
  };
  const retry = async (claim: IntelligenceRefreshClaim, code: string) => {
    note(code);
    const now = deps.now();
    // If this retry would exhaust the attempts (HELD), the reading is marked stale first.
    if (claim.attempts >= options.maxAttempts) await staleTarget(claim);
    const r = await deps.queue.retry(claim, { outcome: code, retryAt: new Date(now.getTime() + backoff(claim.attempts)), maxAttempts: options.maxAttempts });
    if (r === 'RETRYING') tally.retried += 1;
    else if (r === 'HELD') tally.held += 1;
  };

  for (const claim of claims) {
    try {
      const producer = deps.registry.producerFor(claim.target);
      if (!producer) {
        await hold(claim, 'NO_ACTIVE_PRODUCER');
        continue;
      }
      const gathered = await producer.gather(claim.target, deps.now());
      if (gathered.status === 'NO_EVIDENCE') {
        tally.noEvidence += 1;
        note('NO_EVIDENCE');
        // The evidence behind any prior reading is gone: that reading no longer stands. Complete the request
        // (remove the barrier) only once the reading is out of CURRENT; otherwise retry, still blocking.
        if (!(await staleTarget(claim))) {
          await retry(claim, 'STALE_TRANSITION_FAILED');
          continue;
        }
        await deps.queue.complete(claim);
        continue;
      }
      if (gathered.status === 'NOT_PERMITTED') {
        await hold(claim, 'NOT_PERMITTED');
        continue;
      }
      if (gathered.status === 'UNAVAILABLE') {
        await retry(claim, 'GATHER_UNAVAILABLE');
        continue;
      }

      const t = claim.target;
      const owner = ownerOf(t);
      const stored = await deps.digests.storedFingerprint(owner, { domain: t.domain, subjectKind: t.subjectKind, subjectRef: t.subjectRef });
      if (stored && stored.fingerprint === gathered.fingerprint && (stored.status === 'CURRENT' || stored.status === 'STALE')) {
        // THE COST GATE: the input has not changed, so nothing is read and no model is called. A reading
        // marked STALE by an earlier unresolved refresh is re-affirmed: this refresh gathered exactly the
        // evidence it was made from.
        if (stored.status === 'STALE') await deps.digests.reaffirmTarget(owner, t, gathered.fingerprint);
        tally.skippedUnchangedBeforeRead += 1;
        note('UNCHANGED_BEFORE_READ');
        await deps.queue.complete(claim);
        continue;
      }

      const read = await producer.read(t, gathered.context, gathered.fingerprint, deps.now());
      if (read.status === 'NOT_READ') {
        if (read.retryable) await retry(claim, read.reason);
        else await hold(claim, read.reason);
        continue;
      }
      if (read.digest.fingerprint !== gathered.fingerprint) {
        // A producer must write the fingerprint it gathered, or the skip above could never fire.
        await hold(claim, 'FINGERPRINT_MISMATCH');
        continue;
      }
      if (read.digest.domain !== t.domain || read.digest.subjectKind !== t.subjectKind || (read.digest.subjectRef ?? 'domain') !== t.subjectRef) {
        await hold(claim, 'TARGET_MISMATCH');
        continue;
      }
      const written: IntelligenceDigestWriteOutcome =
        t.scope === 'PRINCIPAL'
          ? await deps.digests.upsert({ organizationId: t.organizationId, userId: t.userId }, { ...read.digest, scope: 'PRINCIPAL' })
          : await deps.digests.upsertOrganization(t.organizationId, { ...read.digest, scope: 'ORGANIZATION' });
      if (written.outcome === 'WRITTEN' || written.outcome === 'UNCHANGED') {
        if (written.outcome === 'WRITTEN') tally.written += 1;
        else tally.unchanged += 1;
        note(written.outcome);
        await deps.queue.complete(claim);
      } else if (HOLD_REFUSALS.has(written.refusal)) {
        await hold(claim, written.refusal);
      } else {
        await retry(claim, written.refusal);
      }
    } catch {
      // Never a message: an error's text can carry content. The code is enough to find it in logs.
      await retry(claim, 'PRODUCER_ERROR').catch(() => undefined);
    }
  }
  return { ...tally, outcomes };
}
