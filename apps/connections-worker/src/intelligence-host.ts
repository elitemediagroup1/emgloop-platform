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
// SITUATIONS (Phase F) run from the same host, only when LOOP_INTELLIGENCE_SITUATIONS names a scope
// (`organization`, `private`): a deterministic clustering pass over stored readings, whose model steps
// additionally need situation.synthesis[.private] (and, for an independent check, situation.verify[.private])
// in LOOP_AI_TASKS. An organization pass runs as the named acting operator; a private pass as the person.
//
// THE BRIEFING (Phase G) is composed from the same host only when LOOP_INTELLIGENCE_BRIEFINGS is exactly
// `on`: each person's Briefing from their stored readings, situations and work, reused when unchanged. Its
// model step also needs loop.briefing.compose in LOOP_AI_TASKS; without it Loop's deterministic Briefing is
// written, marked as such.
//
// Logs counts and refusal codes only -- never a target, an organization, a person or content.

import type { PrismaClient } from '@prisma/client';

export interface IntelligenceHostConfig {
  readonly producers: readonly string[];
  readonly situations: readonly ('ORGANIZATION' | 'PRINCIPAL')[];
  readonly briefings: boolean;
  readonly actingUsersRaw: string;
  readonly intervalMs: number;
}

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;

export function readIntelligenceHostConfig(env: Record<string, string | undefined>): IntelligenceHostConfig {
  const producers = [...new Set(String(env.LOOP_INTELLIGENCE_PRODUCERS ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
  const raw = Number(env.LOOP_INTELLIGENCE_INTERVAL_MS);
  const intervalMs = Number.isFinite(raw) && raw >= MIN_INTERVAL_MS ? Math.floor(raw) : DEFAULT_INTERVAL_MS;
  const scopes = String(env.LOOP_INTELLIGENCE_SITUATIONS ?? '').split(',').map((s) => s.trim().toLowerCase());
  const situations = (['ORGANIZATION', 'PRINCIPAL'] as const).filter((s) => scopes.includes(s === 'ORGANIZATION' ? 'organization' : 'private'));
  return { producers, situations, briefings: env.LOOP_INTELLIGENCE_BRIEFINGS === 'on', actingUsersRaw: String(env.LOOP_INTELLIGENCE_ACTING_USERS ?? ''), intervalMs };
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
  if (config.producers.length === 0 && config.situations.length === 0 && !config.briefings) return { scheduled: false, unknownProducers: [], pass: async () => undefined };
  const db = await import('@emgloop/database');
  const now = () => new Date();
  const actingUsers = db.parseActingUsers(config.actingUsersRaw);
  const modelEnabled = (taskId: string) => ai.activatedTasks.includes(taskId);
  const principalFor = db.principalResolver(new db.DomainFactsRepository(prisma), actingUsers, now);
  const situations = new db.SituationService({
    prisma,
    runtime: ai.runtime ? (ai.runtime as ConstructorParameters<typeof db.DomainReadingService>[0]) : null,
    modelEnabled,
    principalFor: (owner) => principalFor(owner.scope === 'PRINCIPAL' ? { scope: 'PRINCIPAL', organizationId: owner.organizationId, userId: owner.userId, domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain' } : { scope: 'ORGANIZATION', organizationId: owner.organizationId, domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain' }),
    now,
  });
  const situationOwners = new db.SituationRepository(prisma);
  const producers = db.loopProducers({
    prisma,
    work: db.repositories.work,
    // The same governed gateway the worker's triage uses; a task not activated is never called.
    reader: ai.runtime ? new db.DomainReadingService(ai.runtime as ConstructorParameters<typeof db.DomainReadingService>[0]) : null,
    modelEnabled,
    actingUsers,
    now,
  });
  const registry = new db.IntelligenceProducerRegistry(producers, config.producers);
  // What this deployment observes, from its ACTIVE producers: the Briefing's expected coverage. A domain
  // observed with no current reading is a gap in the Briefing, never quiet.
  const active = registry.knownProducers().filter((p) => registry.isActive(p.id));
  const observed = {
    principal: [...new Set(active.filter((p) => p.scope === 'PRINCIPAL').map((p) => p.domain))],
    organization: [...new Set(active.filter((p) => p.scope === 'ORGANIZATION').map((p) => p.domain))],
  };
  const briefings = new db.BriefingComposer({ prisma, runtime: ai.runtime ? (ai.runtime as ConstructorParameters<typeof db.DomainReadingService>[0]) : null, modelEnabled, now, observed });
  log('intelligence_briefing_config', { enabled: config.briefings, modelTaskEnabled: modelEnabled('loop.briefing.compose') });
  const queue = new db.IntelligenceRefreshQueueRepository(prisma);
  const digests = new db.IntelligenceDigestRepository(prisma);
  let running = false;
  let pending = false;
  const host: IntelligenceHost = {
    scheduled: true,
    unknownProducers: registry.unknownActive,
    async pass() {
      if (running) { pending = true; return; }
      running = true;
      try {
        const report = await db.runIntelligencePass(
          { registry, queue, digests, leaseOwner: `connections-worker:${process.pid}`, now },
          { limit: 25, leaseMs: 5 * 60 * 1000, maxAttempts: 4, discoverLimit: 200 },
        ).catch(() => { log('intelligence_producer_error', { stage: 'PRODUCERS' }); return null; });
        const situationTally: Record<string, number> = {};
        if (config.situations.length > 0) await situationOwners.purgeStaleCandidates(now()).catch(() => { situationTally.ERROR = (situationTally.ERROR ?? 0) + 1; });
        for (const scope of config.situations) {
          for (const owner of await situationOwners.owners(scope, now(), 100).catch(() => { situationTally[`${scope}:ERROR`] = (situationTally[`${scope}:ERROR`] ?? 0) + 1; return []; })) {
            const r = await situations.pass(owner).catch(() => null);
            const k = r ? `${scope}:${r.state}` : `${scope}:ERROR`;
            situationTally[k] = (situationTally[k] ?? 0) + 1;
            for (const [d, n] of Object.entries(r?.decisions ?? {})) situationTally[`${scope}:${d}`] = (situationTally[`${scope}:${d}`] ?? 0) + n;
            // Clusters not read because their evidence rests on fewer than two distinct governed sources.
            if (r && r.sameSourceOnly > 0) situationTally[`${scope}:SAME_SOURCE_ONLY`] = (situationTally[`${scope}:SAME_SOURCE_ONLY`] ?? 0) + r.sameSourceOnly;
          }
        }
        const briefingTally: Record<string, number> = {};
        if (config.briefings) for (const [organizationId] of actingUsers) {
          const operator = await principalFor({ scope: 'ORGANIZATION', organizationId, domain: 'WORK', subjectKind: 'DOMAIN', subjectRef: 'domain' });
          if (!operator) continue;
          const news = await db.refreshPublicNews(prisma, organizationId, now()).catch(() => null);
          log('intelligence_public_news', news ?? { unavailable: true });
        }
        if (config.briefings) {
          for (const p of await briefings.people(now(), 200)) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 45_000);
            try {
              const bounded = new db.BriefingComposer({ prisma, runtime: ai.runtime ? (ai.runtime as ConstructorParameters<typeof db.DomainReadingService>[0]) : null, modelEnabled, now, observed, signal: controller.signal });
              const r = await bounded.compose({ organizationId: p.organizationId, userId: p.userId }, p.timeZone).catch(() => ({ outcome: 'ERROR' as const }));
              briefingTally[r.outcome] = (briefingTally[r.outcome] ?? 0) + 1;
              if ('reason' in r && r.reason) log('intelligence_briefing_stage', { outcome: r.outcome, reason: r.reason, ...('lengthIssues' in r && r.lengthIssues?.length ? { lengthIssues: r.lengthIssues } : {}) });
            } finally { clearTimeout(timer); }
          }
        }
        log('intelligence_pass', { situations: situationTally, briefings: briefingTally, active: report?.activeProducers ?? 0, discovered: report?.discovered ?? 0, enqueued: report?.enqueued ?? 0, refused: report?.refused ?? {}, discoveryFailures: report?.discoveryFailures ?? 0, ...(report?.cycle ? { claimed: report.cycle.claimed, written: report.cycle.written, unchanged: report.cycle.unchanged, skipped: report.cycle.skippedUnchangedBeforeRead, retried: report.cycle.retried, held: report.cycle.held, modelStages: report.cycle.modelStages } : {}) });
      } catch (err) {
        log('intelligence_pass_error', { name: (err as Error)?.name ?? 'error' });
      } finally {
        running = false;
        if (pending) { pending = false; queueMicrotask(() => void host.pass()); }
      }
    },
  };
  return host;
}
