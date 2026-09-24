// Read Telegram state -- one organization's Telegram commissioning state, from production rows.
//
// READ-ONLY. Before and after each production commissioning step, an operator needs to know what
// state Telegram is in for one organization, from the database alone. This prints: every Telegram
// connection (state, background capability, whether a credential and a cursor are HELD, failure
// class, lifecycle dates); the content-free observations as counts and edge times; each baseline
// checkpoint and each content authorization (state, window, failure class, backoff, whether a
// cursor is held); the AI-derived work items as counts by state and outcome; and the AI ledger for
// the Telegram triage task over the last seven days, as counts and summed usage. It writes nothing:
// the reader runs on a client that can only read (`readOnlyClient`), and nothing here names a write.
//
// WHAT IT NEVER PRINTS: a message body, a conversation label or key, a provider event id, a cursor
// value, a sealed secret, a user id, an email, a name, a phone number, or any organization id or
// name other than the slug the operator typed. A connection is `#n`, its position by createdAt.
// Cursors and the sealed secret are reported as HELD or not, from a scoped `not null` query: the
// values never enter this process. Every other value is a code-vocabulary token (a state, a class)
// or a count or an instant; anything that is not one prints as UNRECOGNIZED rather than as itself.
//
// WHAT IT CANNOT ANSWER: whether the worker is running, whether Telegram is reachable, or why a
// failure class was recorded. Those are in the worker's logs and the provider, not in these rows.
//
// NO SCHEDULE, NO PUSH, NO PULL_REQUEST, NO WORKFLOW_CALL. Reading production is still touching
// production, and a human should be the one asking.

import type { PrismaClient } from '@prisma/client';
import { AI_TASK_TELEGRAM_CONTENT_TRIAGE, DERIVED_WORK_SUBJECT_PREFIXES, WORK_ITEM_OUTCOMES, WORK_ITEM_STATES, connectionIsLive } from '@emgloop/shared';
import { token } from './read-intelligence-state';

/** The one provider this probe reads. */
export const PROVIDER = 'TELEGRAM';
/** The `subjectRef` prefix the worker gives a Telegram-derived work item (content-orchestrator.ts). */
/** The producers' own prefix (shared, so the probe and the worker cannot drift). */
export const TELEGRAM_SUBJECT_REF_PREFIX: string = DERIVED_WORK_SUBJECT_PREFIXES.TELEGRAM;
/** The AI task the worker records triage under. Read from the shared definition, never retyped. */
export const TRIAGE_TASK_ID = AI_TASK_TELEGRAM_CONTENT_TRIAGE.taskId;
/** How far back the ledger is summed. A commissioning week, not a history dump. */
export const LEDGER_LOOKBACK_DAYS = 7;
/** More connections than this are reported as bounded, not listed. */
export const MAX_CONNECTIONS = 200;

// --- What the reader returns: states, classes, instants, counts and HELD flags. Never a value. ---

export interface TelegramConnectionRow {
  /** Internal join key for the baseline and authorization rows. NEVER printed. */
  readonly userId: string;
  readonly state: string;
  readonly backgroundObservation: string;
  readonly credentialHeld: boolean;
  readonly cursorHeld: boolean;
  readonly lastFailureClass: string | null;
  readonly createdAt: Date;
  readonly connectingStartedAt: Date | null;
  readonly connectedAt: Date | null;
  readonly lastObservedAt: Date | null;
  readonly reconnectRequiredAt: Date | null;
  readonly disconnectedAt: Date | null;
  readonly observations: number;
}

export interface TelegramBaselineRow {
  readonly userId: string;
  readonly state: string;
  readonly windowDays: number;
  readonly windowFloorAt: Date;
  readonly consentAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly lastRunAt: Date | null;
  readonly oldestReachedAt: Date | null;
  readonly lastFailureClass: string | null;
  readonly backoffUntil: Date | null;
  readonly revokedAt: Date | null;
  readonly checkpointHeld: boolean;
}

export interface TelegramAuthorizationRow {
  readonly userId: string;
  readonly authorizedAt: Date;
  readonly revokedAt: Date | null;
  readonly lastRunAt: Date | null;
  readonly lastFailureClass: string | null;
  readonly backoffUntil: Date | null;
  readonly cursorHeld: boolean;
  readonly historicalState: string;
  readonly historicalWindowFloorAt: Date | null;
  readonly historicalOldestReachedAt: Date | null;
  readonly historicalLastRunAt: Date | null;
  readonly historicalLastFailureClass: string | null;
  readonly historicalBackoffUntil: Date | null;
  readonly historicalFailedItems: number;
  readonly historicalCursorHeld: boolean;
}

export interface TelegramLedgerOutcome {
  readonly outcome: string;
  readonly count: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
  /** Loop's RESERVE estimate (estimatedCostMicros), never a cost of record. */
  readonly reserveCostMicros: number | null;
}

export interface TelegramState {
  readonly connections: readonly TelegramConnectionRow[];
  readonly connectionsBounded: boolean;
  readonly observations: {
    readonly total: number;
    readonly oldestObservedAt: Date | null;
    readonly newestObservedAt: Date | null;
    readonly last24h: number;
    readonly last7d: number;
  };
  readonly baselines: readonly TelegramBaselineRow[];
  readonly authorizations: readonly TelegramAuthorizationRow[];
  readonly workItems: {
    readonly total: number;
    readonly byState: readonly { readonly state: string; readonly count: number }[];
    readonly byOutcome: readonly { readonly outcome: string | null; readonly count: number }[];
    readonly oldestFirstDetectedAt: Date | null;
    readonly newestLastDetectedAt: Date | null;
  };
  readonly ledger: {
    readonly since: Date;
    readonly total: number;
    readonly byOutcome: readonly TelegramLedgerOutcome[];
    readonly byFailureClass: readonly { readonly failureClass: string; readonly count: number }[];
    /** ANSWERED rows the provider never reported usage for: reserved, never reconciled. */
    readonly answeredWithoutUsage: number;
  };
}

export interface TelegramStateReader {
  organizationBySlug(slug: string): Promise<{ id: string; slug: string } | null>;
  read(organizationId: string, now: Date): Promise<TelegramState>;
}

export interface TelegramStateDeps {
  reader: TelegramStateReader;
  now: () => Date;
  log: (line: string) => void;
}

export interface TelegramStateResult {
  readonly overall: 'READ' | 'FAILED_PRECONDITION';
  readonly connections: number;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

type Field = string | number | boolean | null;

function line(fields: Record<string, Field>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '-' : String(v)}`)
    .join(' ');
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function parseArgs(argv: readonly string[]): { organization: string } {
  let organization = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--organization' || argv[i] === '--org') {
      organization = (argv[i + 1] ?? '').trim();
      i += 1;
    }
  }
  return { organization };
}

export function readEnvironment(env: NodeJS.ProcessEnv): { ok: true } | { ok: false; missing: string[] } {
  return env.DATABASE_URL?.trim() ? { ok: true } : { ok: false, missing: ['DATABASE_URL'] };
}

// --- The reader: scoped, minimized queries on a client that can only read ----------------------

/** Pass `readOnlyClient(prisma)`. Every query is scoped to the organization and the provider. */
export class PrismaTelegramStateReader implements TelegramStateReader {
  constructor(private readonly prisma: PrismaClient) {}

  async organizationBySlug(slug: string): Promise<{ id: string; slug: string } | null> {
    return this.prisma.organization.findUnique({ where: { slug }, select: { id: true, slug: true } });
  }

  async read(organizationId: string, now: Date): Promise<TelegramState> {
    const scope = { organizationId, provider: PROVIDER };
    const dayAgo = new Date(now.getTime() - 86_400_000);
    const weekAgo = new Date(now.getTime() - LEDGER_LOOKBACK_DAYS * 86_400_000);

    // Connections. The sealed secret and the cursor are never selected: whether each is HELD comes
    // from a scoped `not null` query, so the value never enters this process.
    const listed = await this.prisma.sourceConnection.findMany({
      where: scope,
      orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
      take: MAX_CONNECTIONS + 1,
      select: {
        userId: true,
        state: true,
        backgroundObservation: true,
        lastFailureClass: true,
        createdAt: true,
        connectingStartedAt: true,
        connectedAt: true,
        lastObservedAt: true,
        reconnectRequiredAt: true,
        disconnectedAt: true,
      },
    });
    const connectionsBounded = listed.length > MAX_CONNECTIONS;
    const rows = listed.slice(0, MAX_CONNECTIONS);
    const held = async (where: object): Promise<Set<string>> =>
      new Set((await this.prisma.sourceConnection.findMany({ where: { ...scope, ...where }, select: { userId: true } })).map((r) => r.userId));
    const withCredential = await held({ secretSealed: { not: null } });
    const withCursor = await held({ cursor: { not: null } });
    const connections: TelegramConnectionRow[] = [];
    for (const r of rows) {
      connections.push({
        userId: r.userId,
        state: r.state,
        backgroundObservation: r.backgroundObservation,
        credentialHeld: withCredential.has(r.userId),
        cursorHeld: withCursor.has(r.userId),
        lastFailureClass: r.lastFailureClass,
        createdAt: r.createdAt,
        connectingStartedAt: r.connectingStartedAt,
        connectedAt: r.connectedAt,
        lastObservedAt: r.lastObservedAt,
        reconnectRequiredAt: r.reconnectRequiredAt,
        disconnectedAt: r.disconnectedAt,
        observations: await this.prisma.sourceObservation.count({ where: { ...scope, userId: r.userId } }),
      });
    }

    // Observations: counts and edge instants only. No row is ever selected.
    const edges = await this.prisma.sourceObservation.aggregate({ where: scope, _min: { observedAt: true }, _max: { observedAt: true } });
    const observations = {
      total: await this.prisma.sourceObservation.count({ where: scope }),
      oldestObservedAt: edges._min.observedAt,
      newestObservedAt: edges._max.observedAt,
      last24h: await this.prisma.sourceObservation.count({ where: { ...scope, observedAt: { gte: dayAgo } } }),
      last7d: await this.prisma.sourceObservation.count({ where: { ...scope, observedAt: { gte: weekAgo } } }),
    };

    // Baselines. The checkpoint cursor is never selected.
    const checkpointHeld = new Set(
      (await this.prisma.sourceBaselineCheckpoint.findMany({ where: { ...scope, checkpointCursor: { not: null } }, select: { userId: true } })).map((r) => r.userId),
    );
    const baselines: TelegramBaselineRow[] = (
      await this.prisma.sourceBaselineCheckpoint.findMany({
        where: scope,
        orderBy: { createdAt: 'asc' },
        select: {
          userId: true,
          state: true,
          windowDays: true,
          windowFloorAt: true,
          consentAt: true,
          startedAt: true,
          completedAt: true,
          lastRunAt: true,
          oldestReachedAt: true,
          lastFailureClass: true,
          backoffUntil: true,
          revokedAt: true,
        },
      })
    ).map((r) => ({ ...r, checkpointHeld: checkpointHeld.has(r.userId) }));

    // Content authorizations. Neither the forward nor the historical cursor is ever selected.
    const contentCursorHeld = new Set(
      (await this.prisma.sourceContentAuthorization.findMany({ where: { ...scope, contentCursor: { not: null } }, select: { userId: true } })).map((r) => r.userId),
    );
    const historicalCursorHeld = new Set(
      (await this.prisma.sourceContentAuthorization.findMany({ where: { ...scope, historicalCursor: { not: null } }, select: { userId: true } })).map((r) => r.userId),
    );
    const authorizations: TelegramAuthorizationRow[] = (
      await this.prisma.sourceContentAuthorization.findMany({
        where: scope,
        orderBy: { createdAt: 'asc' },
        select: {
          userId: true,
          authorizedAt: true,
          revokedAt: true,
          lastRunAt: true,
          lastFailureClass: true,
          backoffUntil: true,
          historicalState: true,
          historicalWindowFloorAt: true,
          historicalOldestReachedAt: true,
          historicalLastRunAt: true,
          historicalLastFailureClass: true,
          historicalBackoffUntil: true,
          historicalFailedItems: true,
        },
      })
    ).map((r) => ({ ...r, cursorHeld: contentCursorHeld.has(r.userId), historicalCursorHeld: historicalCursorHeld.has(r.userId) }));

    // Derived work items: counts only. The row (its title, its evidence, its subject) is never selected.
    const itemScope = { organizationId, producerKind: 'MODEL', subjectRef: { startsWith: TELEGRAM_SUBJECT_REF_PREFIX } };
    const itemEdges = await this.prisma.workItem.aggregate({ where: itemScope, _count: { _all: true }, _min: { firstDetectedAt: true }, _max: { lastDetectedAt: true } });
    const workItems = {
      total: itemEdges._count._all,
      byState: (await this.prisma.workItem.groupBy({ by: ['state'], where: itemScope, _count: { _all: true } })).map((g) => ({ state: g.state, count: g._count._all })),
      byOutcome: (await this.prisma.workItem.groupBy({ by: ['outcome'], where: itemScope, _count: { _all: true } })).map((g) => ({ outcome: g.outcome, count: g._count._all })),
      oldestFirstDetectedAt: itemEdges._min.firstDetectedAt,
      newestLastDetectedAt: itemEdges._max.lastDetectedAt,
    };

    // The AI ledger for the triage task: counts and summed usage. No prompt, no response, no id.
    const ledgerScope = { organizationId, taskId: TRIAGE_TASK_ID, requestedAt: { gte: weekAgo } };
    const byOutcome = await this.prisma.aiInvocation.groupBy({
      by: ['outcome'],
      where: ledgerScope,
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, cachedInputTokens: true, reasoningTokens: true, estimatedCostMicros: true },
    });
    const byFailureClass = await this.prisma.aiInvocation.groupBy({
      by: ['failureClass'],
      where: { ...ledgerScope, failureClass: { not: null } },
      _count: { _all: true },
    });
    const ledger = {
      since: weekAgo,
      total: byOutcome.reduce((n, g) => n + g._count._all, 0),
      byOutcome: byOutcome.map((g) => ({
        outcome: g.outcome,
        count: g._count._all,
        inputTokens: g._sum.inputTokens,
        outputTokens: g._sum.outputTokens,
        cachedInputTokens: g._sum.cachedInputTokens,
        reasoningTokens: g._sum.reasoningTokens,
        reserveCostMicros: g._sum.estimatedCostMicros,
      })),
      byFailureClass: byFailureClass.flatMap((g) => (g.failureClass === null ? [] : [{ failureClass: g.failureClass, count: g._count._all }])),
      answeredWithoutUsage: await this.prisma.aiInvocation.count({ where: { ...ledgerScope, outcome: 'ANSWERED', inputTokens: null } }),
    };

    return { connections, connectionsBounded, observations, baselines, authorizations, workItems, ledger };
  }
}

// --- The report ------------------------------------------------------------------------------

export async function runTelegramState(request: { organizationSlug: string }, deps: TelegramStateDeps): Promise<TelegramStateResult> {
  const refuse = (reason: string): TelegramStateResult => {
    deps.log(line({ event: 'PRECONDITION_FAILED', reason }));
    return { overall: 'FAILED_PRECONDITION', connections: 0 };
  };
  if (!SLUG.test(request.organizationSlug)) return refuse('--organization must be lowercase letters, digits and hyphens');
  const org = await deps.reader.organizationBySlug(request.organizationSlug);
  if (!org) return refuse('unknown organization');

  const now = deps.now();
  const s = await deps.reader.read(org.id, now);
  deps.log(line({ event: 'ORGANIZATION', organization: org.slug, provider: PROVIDER, at: iso(now) }));

  // 1. Connections, as #n in createdAt order. The join key is never printed.
  const index = new Map<string, string>();
  s.connections.forEach((c, i) => index.set(c.userId, `#${i + 1}`));
  const ref = (userId: string): string => index.get(userId) ?? 'UNMATCHED';
  let live = 0;
  for (const c of s.connections) {
    if (connectionIsLive(c.state as Parameters<typeof connectionIsLive>[0])) live += 1;
    deps.log(line({
      event: 'CONNECTION',
      connection: ref(c.userId),
      state: token(c.state),
      background: token(c.backgroundObservation),
      credential: c.credentialHeld,
      cursor: c.cursorHeld,
      lastFailure: token(c.lastFailureClass),
      createdAt: iso(c.createdAt),
      connectingStartedAt: iso(c.connectingStartedAt),
      connectedAt: iso(c.connectedAt),
      lastObservedAt: iso(c.lastObservedAt),
      reconnectRequiredAt: iso(c.reconnectRequiredAt),
      disconnectedAt: iso(c.disconnectedAt),
      observations: c.observations,
    }));
  }
  deps.log(line({ event: 'CONNECTIONS', total: s.connections.length, live, bounded: s.connectionsBounded }));

  // 2. Observations: counts and edge instants.
  deps.log(line({
    event: 'OBSERVATIONS',
    total: s.observations.total,
    oldestObservedAt: iso(s.observations.oldestObservedAt),
    newestObservedAt: iso(s.observations.newestObservedAt),
    last24h: s.observations.last24h,
    last7d: s.observations.last7d,
  }));

  // 3. Baselines, by connection.
  for (const b of s.baselines) {
    deps.log(line({
      event: 'BASELINE',
      connection: ref(b.userId),
      state: token(b.state),
      windowDays: b.windowDays,
      windowFloorAt: iso(b.windowFloorAt),
      consentAt: iso(b.consentAt),
      startedAt: iso(b.startedAt),
      lastRunAt: iso(b.lastRunAt),
      completedAt: iso(b.completedAt),
      oldestReachedAt: iso(b.oldestReachedAt),
      lastFailure: token(b.lastFailureClass),
      backoffUntil: iso(b.backoffUntil),
      revokedAt: iso(b.revokedAt),
      checkpoint: b.checkpointHeld,
    }));
  }
  deps.log(line({ event: 'BASELINES', total: s.baselines.length, unmatched: s.baselines.filter((b) => !index.has(b.userId)).length }));

  // 4. Content authorizations, by connection.
  let authorized = 0;
  for (const a of s.authorizations) {
    const isAuthorized = a.revokedAt === null;
    if (isAuthorized) authorized += 1;
    deps.log(line({
      event: 'CONTENT_AUTHORIZATION',
      connection: ref(a.userId),
      authorized: isAuthorized,
      authorizedAt: iso(a.authorizedAt),
      revokedAt: iso(a.revokedAt),
      lastRunAt: iso(a.lastRunAt),
      lastFailure: token(a.lastFailureClass),
      backoffUntil: iso(a.backoffUntil),
      cursor: a.cursorHeld,
      historicalState: token(a.historicalState),
      historicalWindowFloorAt: iso(a.historicalWindowFloorAt),
      historicalOldestReachedAt: iso(a.historicalOldestReachedAt),
      historicalLastRunAt: iso(a.historicalLastRunAt),
      historicalLastFailure: token(a.historicalLastFailureClass),
      historicalBackoffUntil: iso(a.historicalBackoffUntil),
      historicalFailedItems: a.historicalFailedItems,
      historicalCursor: a.historicalCursorHeld,
    }));
  }
  deps.log(line({
    event: 'CONTENT_AUTHORIZATIONS',
    total: s.authorizations.length,
    authorized,
    revoked: s.authorizations.length - authorized,
    unmatched: s.authorizations.filter((a) => !index.has(a.userId)).length,
  }));

  // 5. Derived work items: the closed vocabularies as columns, anything else summed as `other`.
  const counted = (groups: readonly { readonly key: string | null; readonly count: number }[], vocabulary: readonly string[]) => {
    const fields: Record<string, Field> = {};
    let other = 0;
    let none = 0;
    for (const v of vocabulary) fields[v] = 0;
    for (const g of groups) {
      if (g.key === null) none += g.count;
      else if (vocabulary.includes(g.key)) fields[g.key] = (fields[g.key] as number) + g.count;
      else other += g.count;
    }
    return { fields, other, none };
  };
  const byState = counted(s.workItems.byState.map((g) => ({ key: g.state, count: g.count })), WORK_ITEM_STATES);
  const byOutcome = counted(s.workItems.byOutcome.map((g) => ({ key: g.outcome, count: g.count })), WORK_ITEM_OUTCOMES);
  deps.log(line({ event: 'WORK_ITEMS_BY_STATE', ...byState.fields, other: byState.other }));
  deps.log(line({ event: 'WORK_ITEMS_BY_OUTCOME', ...byOutcome.fields, none: byOutcome.none, other: byOutcome.other }));
  deps.log(line({
    event: 'WORK_ITEMS',
    total: s.workItems.total,
    oldestFirstDetectedAt: iso(s.workItems.oldestFirstDetectedAt),
    newestLastDetectedAt: iso(s.workItems.newestLastDetectedAt),
  }));

  // 6. The AI ledger for the triage task, last seven days.
  for (const g of s.ledger.byOutcome) {
    deps.log(line({
      event: 'AI_LEDGER_OUTCOME',
      outcome: token(g.outcome),
      count: g.count,
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      cachedInputTokens: g.cachedInputTokens,
      reasoningTokens: g.reasoningTokens,
      reserveCostMicros: g.reserveCostMicros,
    }));
  }
  for (const g of s.ledger.byFailureClass) deps.log(line({ event: 'AI_LEDGER_FAILURE', class: token(g.failureClass), count: g.count }));
  deps.log(line({
    event: 'AI_LEDGER',
    task: token(TRIAGE_TASK_ID),
    since: iso(s.ledger.since),
    total: s.ledger.total,
    answeredWithoutUsage: s.ledger.answeredWithoutUsage,
  }));

  deps.log(line({
    event: 'SUMMARY',
    connections: s.connections.length,
    live,
    observations: s.observations.total,
    baselines: s.baselines.length,
    contentAuthorized: authorized,
    workItems: s.workItems.total,
    ledgerInvocations: s.ledger.total,
    OVERALL_RESULT: 'READ',
  }));
  return { overall: 'READ', connections: s.connections.length };
}

// --- Wiring -------------------------------------------------------------------

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');
  const args = parseArgs(process.argv.slice(2));
  if (!args.organization) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--organization <slug> is required' }));
    return 2;
  }
  const env = readEnvironment(process.env);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: env.missing.join(',') }));
    return 2;
  }

  const { prisma, readOnlyClient } = await import('@emgloop/database');
  try {
    // The reader gets a client that can only read. Its own `$disconnect` stays with this wiring.
    const reader = new PrismaTelegramStateReader(readOnlyClient(prisma));
    const result = await runTelegramState({ organizationSlug: args.organization }, { reader, now: () => new Date(), log });
    return result.overall === 'READ' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

const ENTRY_POINT = /[\\/]read-telegram-state\.ts$/;
if (process.argv[1] && ENTRY_POINT.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // A class, never a cause: a database error message can carry a connection string or a value.
      process.stdout.write(line({ event: 'RUN_FAILED', reason: 'UNEXPECTED' }) + '\n');
      process.exitCode = 1;
    },
  );
}
