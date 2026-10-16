// Continuous API reads in the existing process. The canonical poller owns all
// mapping, ingestion, fact convergence and durable checkpoint advancement.
import { CALLGRID_FRONTIER_POLICY, CallGridRoutinePollService, checkpointMayAdvance, repositories } from '@emgloop/database';
import type { PrismaClient } from '@prisma/client';
import type { RoutinePollResult } from '@emgloop/database';

export const CALLGRID_TICK_MS = 30_000;
export interface CallGridHostConfig { organizationSlug: string | null; apiKey: string; }
export function readCallGridHostConfig(env: Record<string, string | undefined>): CallGridHostConfig {
  const slug = env.LOOP_CALLGRID_ORGANIZATION?.trim() || null;
  if (slug && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new Error('INVALID_LOOP_CALLGRID_ORGANIZATION');
  if (slug && !env.CALLGRID_API_KEY?.trim()) throw new Error('MISSING_CALLGRID_API_KEY');
  return { organizationSlug: slug, apiKey: slug ? env.CALLGRID_API_KEY!.trim() : '' };
}
export interface CallGridHostPorts {
  organization(slug: string): Promise<{ id: string; status: string } | null>;
  poll(input: { organizationId: string; apiKey: string; now: Date; mode: 'frontier'; policy: typeof CALLGRID_FRONTIER_POLICY }): Promise<RoutinePollResult>;
  changed(): void;
  now(): Date;
  log(event: string, fields: Record<string, unknown>): void;
}
export function callGridHost(config: CallGridHostConfig, ports: CallGridHostPorts) {
  let active: Promise<void> | null = null;
  let stopped = false;
  let failures = 0;
  let nextAttemptAt = 0;
  return {
    scheduled: config.organizationSlug !== null,
    pass(): Promise<void> {
      if (stopped || !config.organizationSlug || ports.now().getTime() < nextAttemptAt) return Promise.resolve();
      if (active) return active;
      active = (async () => {
        const start = ports.now();
        try {
          const org = await ports.organization(config.organizationSlug!);
          if (!org || ['SUSPENDED', 'CANCELED'].includes(org.status)) throw new Error('ORGANIZATION_NOT_AVAILABLE');
          const result = await ports.poll({ organizationId: org.id, apiKey: config.apiKey, now: start, mode: 'frontier', policy: { ...CALLGRID_FRONTIER_POLICY, safetyLagMs: 0 } });
          const e = result.execution;
          const proven = result.plan.plan === 'POLL' && e !== null && checkpointMayAdvance(e.outcome) &&
            result.checkpointAfter !== null && result.checkpointAfter >= result.plan.until;
          failures = proven ? 0 : failures + 1;
          nextAttemptAt = proven ? 0 : ports.now().getTime() + Math.min(300_000, 30_000 * 2 ** Math.min(failures, 4));
          ports.log('callgrid_api_pass', {
            outcome: e?.outcome ?? 'NOT_PROVEN', proven, elapsedMs: ports.now().getTime() - start.getTime(),
            coverageThrough: result.checkpointAfter?.toISOString() ?? null,
            coverageLagMs: result.checkpointAfter ? Math.max(0, ports.now().getTime() - result.checkpointAfter.getTime()) : null,
            fetched: e?.providerRecordsFetched ?? 0, created: e?.newEvents ?? 0,
            strengthened: e?.strengthenedCalls ?? 0, conflicts: e?.conflicts ?? 0,
          });
          // A partial apply can have changed records even without proving coverage.
          // Request synthesis asynchronously: model latency never blocks ingestion.
          if ((e?.newEvents ?? 0) + (e?.strengthenedCalls ?? 0) > 0 && !stopped) ports.changed();
        } catch {
          failures++;
          nextAttemptAt = ports.now().getTime() + Math.min(300_000, 30_000 * 2 ** Math.min(failures, 4));
          ports.log('callgrid_api_error', { failures, retryInMs: nextAttemptAt - ports.now().getTime() });
        }
      })().finally(() => { active = null; });
      return active;
    },
    async stop() { stopped = true; await active; },
  };
}
export function createCallGridHost(prisma: PrismaClient, config: CallGridHostConfig,
  changed: () => void, log: CallGridHostPorts['log']) {
  const poller = new CallGridRoutinePollService(prisma);
  return callGridHost(config, {
    organization: (slug) => repositories.organizations.findBySlug(slug),
    poll: (input) => poller.run(input), changed, now: () => new Date(), log,
  });
}
