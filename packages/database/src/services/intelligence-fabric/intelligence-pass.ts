// One scheduled intelligence pass: discover -> enqueue -> run the producer loop. Loop Intelligence Phase E.
//
// The ONE entry point every host calls (the connections worker on its timer; the operations runner for
// the Mail producers), so a pass behaves the same wherever it runs:
//
//   1. each ACTIVE producer that can discover names the targets it should refresh now (Loop's records
//      only; ids, never content), bounded per producer;
//   2. each target is enqueued as SCHEDULED -- the queue coalesces a target already pending, so a pass
//      that runs twice costs one request;
//   3. the producer loop claims (only in active domains), gathers, and skips an unchanged fingerprint
//      BEFORE any read -- so a scheduled pass over an unchanged organization makes no model call.
//
// Returns counts only. With no active producer it discovers nothing, enqueues nothing, claims nothing.

import type { IntelligenceDigestRepository } from '../../repositories/intelligence/intelligence-digest.repository';
import type { IntelligenceRefreshQueueRepository } from '../../repositories/intelligence/intelligence-refresh-queue.repository';
import type { IntelligenceProducerRegistry } from './producer';
import { runIntelligenceProducerCycle, type ProducerLoopOptions, type ProducerLoopReport } from './producer-loop';

export interface IntelligencePassDeps {
  readonly registry: IntelligenceProducerRegistry;
  readonly queue: Pick<IntelligenceRefreshQueueRepository, 'enqueue' | 'claim' | 'complete' | 'retry' | 'hold'>;
  readonly digests: Pick<IntelligenceDigestRepository, 'storedFingerprint' | 'upsert' | 'upsertOrganization' | 'markTargetStale' | 'reaffirmTarget'>;
  readonly leaseOwner: string;
  readonly now: () => Date;
}

export interface IntelligencePassReport {
  readonly activeProducers: number;
  readonly discovered: number;
  readonly enqueued: number;
  readonly refused: Readonly<Record<string, number>>;
  readonly discoveryFailures: number;
  readonly cycle: ProducerLoopReport | null;
}

export async function runIntelligencePass(deps: IntelligencePassDeps, options: ProducerLoopOptions & { readonly discoverLimit: number }): Promise<IntelligencePassReport> {
  const active = deps.registry.knownProducers().filter((p) => deps.registry.isActive(p.id));
  if (active.length === 0) return { activeProducers: 0, discovered: 0, enqueued: 0, refused: {}, discoveryFailures: 0, cycle: null };
  let discovered = 0;
  let enqueued = 0;
  let discoveryFailures = 0;
  const refused: Record<string, number> = {};
  for (const producer of active) {
    if (!producer.discover) continue;
    let targets;
    try {
      targets = (await producer.discover(deps.now())).slice(0, options.discoverLimit);
    } catch {
      discoveryFailures += 1;
      continue;
    }
    discovered += targets.length;
    for (const target of targets) {
      const outcome = await deps.queue.enqueue(target, { reason: 'SCHEDULED' }, deps.now());
      if (outcome.outcome === 'REFUSED') refused[outcome.refusal] = (refused[outcome.refusal] ?? 0) + 1;
      else enqueued += 1;
    }
  }
  const cycle = await runIntelligenceProducerCycle({ queue: deps.queue, digests: deps.digests, registry: deps.registry, leaseOwner: deps.leaseOwner, now: deps.now }, options);
  return { activeProducers: active.length, discovered, enqueued, refused, discoveryFailures, cycle };
}
