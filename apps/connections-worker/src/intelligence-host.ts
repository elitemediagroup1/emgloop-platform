// The connections worker's host for the Loop Intelligence producers. Phase E, 2026-09-26.
//
// OFF UNLESS NAMED. The pass is scheduled only when LOOP_INTELLIGENCE_PRODUCERS lists at least one
// producer id; unset (the default everywhere) schedules nothing, reads nothing, writes nothing. A listed
// producer then writes its RULE reading from Loop's own records; its MODEL reading additionally needs its
// task in LOOP_AI_TASKS (the same activation the gateway enforces), a provider policy for its data class,
// and -- for an organization reading -- a named acting operator (LOOP_INTELLIGENCE_ACTING_USERS).
//
// The worker hosts every producer that reads Loop's records. The Mail producers need the person's Gmail
// read-through and run from the operations runner instead; naming one here is reported, never guessed at.
//
// Logs counts and refusal codes only -- never a target, an organization, a person or content.

import type { PrismaClient } from '@prisma/client';

export interface IntelligenceHostConfig {
  readonly producers: readonly string[];
  readonly actingUsersRaw: string;
  readonly intervalMs: number;
}

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;

export function readIntelligenceHostConfig(env: Record<string, string | undefined>): IntelligenceHostConfig {
  const producers = [...new Set(String(env.LOOP_INTELLIGENCE_PRODUCERS ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
  const raw = Number(env.LOOP_INTELLIGENCE_INTERVAL_MS);
  const intervalMs = Number.isFinite(raw) && raw >= MIN_INTERVAL_MS ? Math.floor(raw) : DEFAULT_INTERVAL_MS;
  return { producers, actingUsersRaw: String(env.LOOP_INTELLIGENCE_ACTING_USERS ?? ''), intervalMs };
}

export interface IntelligenceHostRuntime {
  readonly runtime: unknown;
  readonly activatedTasks: readonly string[];
}

export interface IntelligenceHost {
  readonly scheduled: boolean;
  readonly unknownProducers: readonly string[];
  pass(): Promise<void>;
}

/** Build the host. With no producer named it is inert: `scheduled` false and `pass` a no-op. */
export async function createIntelligenceHost(
  prisma: PrismaClient,
  config: IntelligenceHostConfig,
  ai: IntelligenceHostRuntime,
  log: (event: string, fields?: Record<string, unknown>) => void,
): Promise<IntelligenceHost> {
  if (config.producers.length === 0) return { scheduled: false, unknownProducers: [], pass: async () => undefined };
  const db = await import('@emgloop/database');
  const now = () => new Date();
  const producers = db.loopProducers({
    prisma,
    work: db.repositories.work,
    // The same governed gateway the worker's triage uses; a task not activated is never called.
    reader: ai.runtime ? new db.DomainReadingService(ai.runtime as ConstructorParameters<typeof db.DomainReadingService>[0]) : null,
    modelEnabled: (taskId) => ai.activatedTasks.includes(taskId),
    actingUsers: db.parseActingUsers(config.actingUsersRaw),
    now,
  });
  const registry = new db.IntelligenceProducerRegistry(producers, config.producers);
  const queue = new db.IntelligenceRefreshQueueRepository(prisma);
  const digests = new db.IntelligenceDigestRepository(prisma);
  let running = false;
  return {
    scheduled: true,
    unknownProducers: registry.unknownActive,
    async pass() {
      if (running) return;
      running = true;
      try {
        const report = await db.runIntelligencePass(
          { registry, queue, digests, leaseOwner: `connections-worker:${process.pid}`, now },
          { limit: 25, leaseMs: 5 * 60 * 1000, maxAttempts: 4, discoverLimit: 200 },
        );
        log('intelligence_pass', { active: report.activeProducers, discovered: report.discovered, enqueued: report.enqueued, refused: report.refused, discoveryFailures: report.discoveryFailures, ...(report.cycle ? { claimed: report.cycle.claimed, written: report.cycle.written, unchanged: report.cycle.unchanged, skipped: report.cycle.skippedUnchangedBeforeRead, retried: report.cycle.retried, held: report.cycle.held } : {}) });
      } catch (err) {
        log('intelligence_pass_error', { name: (err as Error)?.name ?? 'error' });
      } finally {
        running = false;
      }
    },
  };
}
