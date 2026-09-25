// The intelligence producer contract and registry. Loop Intelligence PR 2 (the fabric), 2026-09-26.
//
// A PRODUCER turns a governed context into a domain digest. Every domain plugs into the same loop
// (`producer-loop.ts`) through this one interface:
//
//   gather(target)    read Loop's OWN governed copy of the evidence -- repositories, never a provider API,
//                     never a raw source payload -- and derive the deterministic context and its
//                     FINGERPRINT (everything that should change the reading). Authorization is
//                     re-checked here: a principal target is read as that person, an organization target
//                     only for a domain that admits organization scope.
//   read(context)     produce the digest input. A RULE producer derives it deterministically; a MODEL
//                     producer calls the governed AI runtime (through `DomainReadingService`), whose
//                     gateway enforces task activation, provider policy, kills, budgets and lanes.
//
// THE LOOP SKIPS UNCHANGED INPUT BEFORE `read`. A producer whose gathered fingerprint equals the stored
// digest's is never asked to read, so an unchanged domain costs no model call.
//
// ACTIVATION IS EXPLICIT. A producer exists in code and runs only when its id is listed in the
// registry's active set (the worker's LOOP_INTELLIGENCE_PRODUCERS). With none active, the loop claims
// nothing and does nothing. PR 2 ships NO domain producer.

import type { IntelligenceDomain, IntelligenceSubjectKind } from '@emgloop/shared';

import type { IntelligenceDigestInput } from '../../repositories/intelligence/intelligence-digest.repository';
import type { IntelligenceRefreshTarget } from '../../repositories/intelligence/intelligence-refresh-queue.repository';

export type IntelligenceGatherResult<C> =
  | { readonly status: 'READY'; readonly context: C; readonly fingerprint: string }
  /** Nothing to read: the target is complete with no digest written. */
  | { readonly status: 'NO_EVIDENCE' }
  /** The target may not be read (not a member, consent off, not an admissible scope). Held, not retried. */
  | { readonly status: 'NOT_PERMITTED'; readonly reason: string }
  /** A transient failure reading Loop's own records. Retried. */
  | { readonly status: 'UNAVAILABLE'; readonly reason: string };

export type IntelligenceReadResult =
  | { readonly status: 'READ'; readonly digest: IntelligenceDigestInput }
  /** The governed runtime refused or could not answer; `retryable` decides retry vs hold. */
  | { readonly status: 'NOT_READ'; readonly reason: string; readonly retryable: boolean };

export interface IntelligenceProducer<C = unknown> {
  /** Stable id, e.g. `callgrid.domain@1`. The activation list names these. */
  readonly id: string;
  readonly domain: IntelligenceDomain;
  readonly scope: 'PRINCIPAL' | 'ORGANIZATION';
  readonly subjectKinds: readonly IntelligenceSubjectKind[];
  /**
   * RULE: deterministic only. MODEL: calls a governed AI task in `read`. RULE_AND_MODEL: a rule reading
   * always, merged with the task's reading when that task is activated (the domain kit).
   */
  readonly kind: 'RULE' | 'MODEL' | 'RULE_AND_MODEL';
  /** For a MODEL producer, the task it calls (it must also be activated in the AI runtime). */
  readonly taskId: string | null;
  gather(target: IntelligenceRefreshTarget, now: Date): Promise<IntelligenceGatherResult<C>>;
  /**
   * Optional: the targets this producer should refresh now (a scheduled pass enqueues them; the loop's
   * fingerprint check keeps an unchanged target from costing anything). Loop's own records only.
   */
  discover?(now: Date): Promise<readonly IntelligenceRefreshTarget[]>;
  read(target: IntelligenceRefreshTarget, context: C, fingerprint: string, now: Date): Promise<IntelligenceReadResult>;
}

const PRODUCER_ID = /^[a-z][a-z0-9._-]{0,62}@[0-9]{1,4}$/;

export const PRODUCER_REGISTRY_REFUSALS = ['BAD_ID', 'DUPLICATE_ID', 'DUPLICATE_TARGET', 'MODEL_WITHOUT_TASK', 'RULE_WITH_TASK'] as const;

/**
 * The producers this process may run: every KNOWN producer, and the ACTIVE subset. A producer that is
 * known but not active never runs; an active id that is not known is reported, never guessed at.
 */
export class IntelligenceProducerRegistry {
  private readonly known = new Map<string, IntelligenceProducer<any>>();
  private readonly active = new Set<string>();
  readonly unknownActive: readonly string[];

  constructor(producers: readonly IntelligenceProducer<any>[], activeIds: readonly string[]) {
    const targets = new Set<string>();
    for (const p of producers) {
      if (!PRODUCER_ID.test(p.id)) throw new Error(`intelligence producer id is not well formed: ${p.id}`);
      if (this.known.has(p.id)) throw new Error(`intelligence producer id is registered twice: ${p.id}`);
      if ((p.kind === 'MODEL' || p.kind === 'RULE_AND_MODEL') && !p.taskId) throw new Error(`a MODEL producer names its task: ${p.id}`);
      if (p.kind === 'RULE' && p.taskId) throw new Error(`a RULE producer calls no task: ${p.id}`);
      this.known.set(p.id, p);
    }
    const unknown: string[] = [];
    for (const id of activeIds) {
      const p = this.known.get(id);
      if (!p) {
        unknown.push(id);
        continue;
      }
      // One ACTIVE producer per (domain, scope, subject kind): the loop never has to choose between two.
      for (const kind of p.subjectKinds) {
        const key = `${p.domain}/${p.scope}/${kind}`;
        if (targets.has(key)) throw new Error(`two active intelligence producers for ${key}`);
        targets.add(key);
      }
      this.active.add(id);
    }
    this.unknownActive = Object.freeze(unknown);
  }

  /** Every producer the code knows, active or not (for the status page). */
  knownProducers(): readonly IntelligenceProducer<any>[] {
    return [...this.known.values()];
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  /** The domains an active producer exists for: the only domains the loop claims requests in. */
  activeDomains(): string[] {
    return [...new Set([...this.active].map((id) => this.known.get(id)!.domain))];
  }

  /** The active producer for a target, or null. */
  producerFor(target: IntelligenceRefreshTarget): IntelligenceProducer<any> | null {
    for (const id of this.active) {
      const p = this.known.get(id)!;
      if (p.domain === target.domain && p.scope === target.scope && p.subjectKinds.includes(target.subjectKind)) return p;
    }
    return null;
  }
}

/** The activation list, from the environment's comma-separated value. Empty and whitespace mean none. */
export function parseProducerActivation(raw: string | undefined | null): string[] {
  return [...new Set(String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
}
