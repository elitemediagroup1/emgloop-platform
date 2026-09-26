import 'server-only';

// Intelligence execution status -- the reads (2026-09-24). SERVER ONLY.
//
// The page (/app/admin/intelligence-status) guards first: requireWorkspace('ADMIN') and
// requirePermission('intelligence', 'view'), the Executive Brain's gate. This loader is handed that
// session and reads, in the session's organization only:
//
//   THE AI LEDGER (ai_invocations), AGGREGATED. Grouped by task and outcome over 24 hours and 7
//   days; the latest route (provider, model) per task; a bounded latency sample. Every select and
//   every group-by names only: task, outcome, failure class, provider, requested/served model,
//   request time, latency, token counts, and the reserve cost estimate. NEVER the principal (so no
//   figure can say which employee a run was for), the invocation or provider request id, the
//   context manifest hash, the template, or the Brain job. The ledger stores no prompt and no
//   response at all.
//
//   THE VIEWER'S OWN RUNS. The same aggregates, filtered by the viewer's own user id from the
//   signed session -- the only per-person figures on the page.
//
//   PROVIDER POLICIES (ai_controls, scope PROVIDER_POLICY), through AiControlRepository: platform
//   records, one per provider -- state, ceiling, version, when. Not a tenant's data.
//
//   DOMAIN-INTELLIGENCE DIGESTS, through IntelligenceDigestRepository ONLY, which deliberately has
//   no organization-wide read. The viewer's own digests' METADATA, and organization COUNTS, are
//   shown only if that repository exposes a metadata-only read (`metadataFor`) and a counts-only
//   aggregate (`organizationCounts`). Until it does, the page says the read is not exposed; it never
//   falls back to a read that loads digest content (`forDomain` returns content, so it is not used).
//
//   AI CAPACITY (PR 1): this organization's spend today per lane and over the trailing 24 hours, read
//   through the SAME durable ledger and controls reader the gateway admits against, beside the recorded
//   operating budget (or its absence) and the stored KILLED switches that apply here. Organization totals
//   only; the trailing figure is this organization's, never the platform's.
//
//   THE INTELLIGENCE FABRIC (PR 2): the registered domains (the shared registry, code), the producers
//   the code knows (a metadata catalog; activation is the worker's), and the refresh queue's COUNTS per
//   (scope, domain, state) through IntelligenceRefreshQueueRepository.organizationCounts -- never a
//   subject reference, a target, a user id or content. Before the queue migration it says so.
//
// Each section fails on its own: a read that throws is UNAVAILABLE, never empty. No model is called.

import type { PrismaClient } from '@prisma/client';
import {
  AiControlRepository,
  DurableAiUsageLedger,
  INTELLIGENCE_PRODUCER_CATALOG,
  IntelligenceDigestRepository,
  IntelligenceRefreshQueueRepository,
  aiRuntimeControlsReader,
  prisma,
  refreshQueuePresent,
} from '@emgloop/database';
import { AI_PROVIDER_IDS } from '@emgloop/shared';
import type { AuthSession } from '../../../../auth/auth';
import {
  IN_FLIGHT,
  LATENCY_SAMPLE,
  STATUS_WINDOWS,
  digestCountsOnly,
  digestMetadataOnly,
  fabricQueueCountsOnly,
  projectFabric,
  projectCapacity,
  projectProviderPolicies,
  projectTaskStatus,
  type CapacityRead,
  type CapacityStatus,
  type DigestCount,
  type DigestMetadata,
  type FabricRead,
  type FabricStatus,
  type IntelligenceStatus,
  type OutcomeGroup,
  type OwnGroup,
  type ProviderPolicyRow,
  type Section,
  type StatusWindowKey,
} from './status';

/** The one table this loader reads directly, narrowed so a test can record every argument. */
export type LedgerDb = Pick<PrismaClient, 'aiInvocation'>;

/** What the page may read from the digest authority. Both optional: absent means not exposed. */
export interface DigestReader {
  metadataFor?(principal: { readonly organizationId: string; readonly userId: string }, options?: { readonly now?: Date }): Promise<readonly Record<string, unknown>[]>;
  organizationCounts?(organizationId: string, options?: { readonly now?: Date }): Promise<readonly Record<string, unknown>[]>;
}

export interface StatusDeps {
  readonly ledger: LedgerDb;
  readonly providerPolicies: () => Promise<readonly { providerId: string; state: 'ACTIVE' | 'KILLED'; ceiling: string | null; version: number; recordedAtMs: number }[]>;
  readonly digests: DigestReader;
  /** PR 1. The capacity read. Absent: the section is NOT_EXPOSED. */
  readonly capacity?: (organizationId: string, now: Date) => Promise<CapacityRead>;
  /** PR 2. The fabric's producers and queue counts (digest counts come from `digests`). Absent: NOT_EXPOSED. */
  readonly fabric?: (organizationId: string) => Promise<Omit<FabricRead, 'digests'>>;
}

/** The known producers (code), and the refresh queue's counts for one organization, or NOT_MIGRATED. */
async function readFabric(organizationId: string): Promise<Omit<FabricRead, 'digests'>> {
  const producers = INTELLIGENCE_PRODUCER_CATALOG.map((p) => ({ id: p.id, domain: p.domain, scope: p.scope, kind: p.kind, taskId: p.taskId }));
  if (!(await refreshQueuePresent(prisma))) return { producers, queue: { state: 'NOT_MIGRATED' } };
  const counts = await new IntelligenceRefreshQueueRepository(prisma).organizationCounts(organizationId);
  return { producers, queue: { state: 'READ', counts: fabricQueueCountsOnly(counts as unknown as Record<string, unknown>[]) } };
}

/** The same ledger windows and recorded controls the gateway admits against, for one organization. */
async function readCapacity(organizationId: string, now: Date): Promise<CapacityRead> {
  const reader = aiRuntimeControlsReader(prisma, { ttlMs: 0 });
  const budget = await reader.operatingBudget();
  const operating = budget.state === 'RECORDED' ? budget.budget : null;
  // The task only selects the task window, which this page does not show; `[organizationId]` keeps the
  // trailing-day figure to this organization.
  const spend = await new DurableAiUsageLedger(prisma).spend(organizationId, 'intelligence-status', now, [organizationId], operating);
  if (!spend.cost) throw new Error('the ledger reported no cost');
  return {
    budget: budget.state === 'RECORDED' ? { state: 'RECORDED', budget: budget.budget, version: budget.version, recordedAtMs: budget.recordedAtMs } : budget,
    cost: spend.cost,
    storedKills: await reader.storedKillSwitches(organizationId),
  };
}

function defaultDeps(): StatusDeps {
  const controls = new AiControlRepository(prisma);
  return {
    ledger: prisma,
    providerPolicies: () => controls.providerPolicies(),
    digests: new IntelligenceDigestRepository(prisma) as unknown as DigestReader,
    capacity: readCapacity,
    fabric: readFabric,
  };
}

async function section<T>(read: () => Promise<T>): Promise<Section<T>> {
  try {
    return { state: 'READ', value: await read() };
  } catch {
    return { state: 'UNAVAILABLE' };
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * A group's count. Prisma always returns one; anything else means the aggregate could not be
 * understood, and the whole section becomes UNAVAILABLE rather than a count dressed as zero.
 */
function count(v: unknown): number {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  throw new Error('unreadable ledger aggregate');
}

/** The ledger's aggregates for one organization. Only the allowlisted columns are ever named. */
async function readTasks(db: LedgerDb, organizationId: string, userId: string, now: Date) {
  const since = (hours: number) => new Date(now.getTime() - hours * 3600_000);
  const outcomes = {} as Record<StatusWindowKey, OutcomeGroup[]>;
  const own = {} as Record<StatusWindowKey, OwnGroup[]>;
  const week = since(24 * 7);

  const [outcomeGroups, ownGroups, routes, latency] = await Promise.all([
    Promise.all(
      STATUS_WINDOWS.map((w) =>
        db.aiInvocation.groupBy({
          by: ['taskId', 'outcome', 'failureClass'],
          where: { organizationId, requestedAt: { gte: since(w.hours) } },
          _count: { _all: true, inputTokens: true, outputTokens: true, estimatedCostMicros: true },
          _sum: { inputTokens: true, outputTokens: true, estimatedCostMicros: true },
          _max: { requestedAt: true },
        }),
      ),
    ),
    Promise.all(
      STATUS_WINDOWS.map((w) =>
        db.aiInvocation.groupBy({
          by: ['taskId'],
          where: { organizationId, principalUserId: userId, requestedAt: { gte: since(w.hours) } },
          _count: { _all: true },
          _max: { requestedAt: true },
        }),
      ),
    ),
    db.aiInvocation.groupBy({
      by: ['taskId', 'providerId', 'requestedModelId', 'servedModel'],
      where: { organizationId, requestedAt: { gte: week } },
      _max: { requestedAt: true },
    }),
    db.aiInvocation.findMany({
      where: { organizationId, requestedAt: { gte: week }, latencyMs: { not: null }, outcome: { not: IN_FLIGHT } },
      select: { taskId: true, latencyMs: true, requestedAt: true },
      orderBy: { requestedAt: 'desc' },
      take: LATENCY_SAMPLE,
    }),
  ]);

  STATUS_WINDOWS.forEach((w, i) => {
    outcomes[w.key] = (outcomeGroups[i] ?? []).map((g) => ({
      taskId: g.taskId,
      outcome: g.outcome,
      failureClass: g.failureClass ?? null,
      runs: count(g._count?._all),
      inputReported: count(g._count?.inputTokens),
      outputReported: count(g._count?.outputTokens),
      costRecorded: count(g._count?.estimatedCostMicros),
      inputTokens: num(g._sum?.inputTokens),
      outputTokens: num(g._sum?.outputTokens),
      estimatedCostMicros: num(g._sum?.estimatedCostMicros),
      lastRequestedAt: g._max?.requestedAt ?? null,
    }));
    own[w.key] = (ownGroups[i] ?? []).map((g) => ({ taskId: g.taskId, runs: count(g._count?._all), lastRequestedAt: g._max?.requestedAt ?? null }));
  });

  return {
    rows: projectTaskStatus({
      now,
      outcomes,
      own,
      routes: routes.map((r) => ({ taskId: r.taskId, providerId: r.providerId, requestedModelId: r.requestedModelId, servedModel: r.servedModel ?? null, lastRequestedAt: r._max?.requestedAt ?? null })),
      latency: latency.filter((l) => typeof l.latencyMs === 'number').map((l) => ({ taskId: l.taskId, latencyMs: l.latencyMs as number, requestedAt: l.requestedAt })),
    }),
    latencySampled: latency.length >= LATENCY_SAMPLE,
  };
}

export async function loadIntelligenceStatus(
  session: Pick<AuthSession, 'organizationId' | 'userId'>,
  now: Date,
  deps: StatusDeps = defaultDeps(),
): Promise<IntelligenceStatus> {
  const { organizationId, userId } = session;
  const principal = { organizationId, userId };
  const metadataFor = deps.digests.metadataFor?.bind(deps.digests);
  const organizationCounts = deps.digests.organizationCounts?.bind(deps.digests);

  const capacityRead = deps.capacity;
  const fabricRead = deps.fabric;
  const [tasks, providers, yourDigests, organizationDigests, capacity, fabricBase] = await Promise.all([
    section(() => readTasks(deps.ledger, organizationId, userId, now)),
    section<readonly ProviderPolicyRow[]>(async () => projectProviderPolicies(AI_PROVIDER_IDS, await deps.providerPolicies())),
    metadataFor
      ? section<readonly DigestMetadata[]>(async () => digestMetadataOnly(await metadataFor(principal, { now })))
      : Promise.resolve<Section<readonly DigestMetadata[]>>({ state: 'NOT_EXPOSED' }),
    organizationCounts
      ? section<readonly DigestCount[]>(async () => digestCountsOnly(await organizationCounts(organizationId, { now })))
      : Promise.resolve<Section<readonly DigestCount[]>>({ state: 'NOT_EXPOSED' }),
    capacityRead
      ? section<CapacityStatus>(async () => projectCapacity(await capacityRead(organizationId, now)))
      : Promise.resolve<Section<CapacityStatus>>({ state: 'NOT_EXPOSED' }),
    fabricRead ? section(() => fabricRead(organizationId)) : Promise.resolve<Section<Omit<FabricRead, 'digests'>>>({ state: 'NOT_EXPOSED' }),
  ]);

  const fabric: Section<FabricStatus> =
    fabricBase.state === 'READ'
      ? { state: 'READ', value: projectFabric({ ...fabricBase.value, digests: organizationDigests.state === 'READ' ? organizationDigests.value : null }) }
      : fabricBase;

  return { generatedAt: now, tasks, providers, yourDigests, organizationDigests, capacity, fabric };
}
