// Intelligence execution status -- the pure half (2026-09-24).
//
// What an authorized operator (ADMIN workspace + intelligence:view, the Executive Brain's gate) may
// see about how Loop's intelligence is RUNNING: per AI task, over the last 24 hours and 7 days, how
// many runs, how they ended, which provider and model served the latest one, how long they took,
// and what they reported in tokens and reserved cost. Plus the recorded provider policies, and the
// viewer's OWN domain-intelligence digests' metadata.
//
// AGGREGATES ONLY FOR OTHERS. Every AI figure is an organization total; nothing here can say which
// employee a run belonged to (the ledger reads never select the principal). The only per-person
// figures are the viewer's own, read with the viewer's own id from the signed session.
//
// NEVER CONTENT. No prompt, response, digest content, subject reference, conversation key or
// provider request id is read, projected or shown. The ledger holds no prompt or response at all;
// the digest metadata is read without its content, provenance or subject.
//
// MISSING IS NOT ZERO. A token or cost total no row reported is "not recorded", never 0; a read
// that failed is "could not read", never empty. A task with no runs in the window HAS zero runs --
// the ledger read ran and found none -- and says so in words.
//
// PURE: no database, no clock, no environment.

import { AI_TASKS } from '@emgloop/shared';

export const STATUS_WINDOWS = Object.freeze([
  { key: '24h', label: 'Last 24 hours', hours: 24 },
  { key: '7d', label: 'Last 7 days', hours: 24 * 7 },
] as const);
export type StatusWindowKey = (typeof STATUS_WINDOWS)[number]['key'];

/** The outcome the ledger writes while a call is outstanding. */
export const IN_FLIGHT = 'IN_FLIGHT';
export const ANSWERED = 'ANSWERED';

/** How many of the latest latency values the median is taken over, at most. */
export const LATENCY_SAMPLE = 2000;

/** What each governed task is called here. An unknown id is shown as recorded. */
const TASK_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'case.explanation': 'Case explanation',
  'mail.reply.draft': 'Mail reply draft',
  'telegram.content.triage': 'Telegram content triage',
});

export function taskName(taskId: string): string {
  return TASK_NAMES[taskId] ?? taskId;
}

// --- The rows the reads hand in (exactly what they select; nothing else exists here) ------------

/** One group of the ledger by (task, outcome, failure class), within a window. */
export interface OutcomeGroup {
  readonly taskId: string;
  readonly outcome: string;
  readonly failureClass: string | null;
  readonly runs: number;
  /** How many of those runs reported each figure; the sums are over those only. */
  readonly inputReported: number;
  readonly outputReported: number;
  readonly costRecorded: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly estimatedCostMicros: number | null;
  readonly lastRequestedAt: Date | null;
}

/** The provider and model a task was routed to, with the latest request that used that route. */
export interface RouteGroup {
  readonly taskId: string;
  readonly providerId: string;
  readonly requestedModelId: string;
  readonly servedModel: string | null;
  readonly lastRequestedAt: Date | null;
}

export interface LatencySample {
  readonly taskId: string;
  readonly latencyMs: number;
  readonly requestedAt: Date;
}

export interface OwnGroup {
  readonly taskId: string;
  readonly runs: number;
  readonly lastRequestedAt: Date | null;
}

// --- The projection --------------------------------------------------------------------------------

export interface TaskWindowStatus {
  readonly runs: number;
  readonly answered: number;
  readonly inFlight: number;
  /** Runs that ended any other way, by Loop's failure class (or the outcome when it named none). */
  readonly notAnswered: readonly { readonly reason: string; readonly runs: number }[];
  readonly lastRunAt: Date | null;
  /** Null: no run in the window reported a latency. */
  readonly medianLatencyMs: number | null;
  /** Null: no run reported tokens. `reported` of `runs` did. */
  readonly tokens: { readonly input: number; readonly output: number; readonly reported: number } | null;
  /** The reserve estimate Loop recorded before dispatch -- never the cost of record. Null: none recorded. */
  readonly reservedCostMicros: { readonly total: number; readonly recorded: number } | null;
  /** The viewer's own runs of this task in the window. */
  readonly yours: number;
}

export interface TaskStatus {
  readonly taskId: string;
  readonly name: string;
  readonly windows: Readonly<Record<StatusWindowKey, TaskWindowStatus>>;
  /** The route of the latest run in the last 7 days; null when there was none. */
  readonly latestRoute: { readonly providerId: string; readonly model: string; readonly servedModel: string | null } | null;
  readonly yourLastRunAt: Date | null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function windowStatus(taskId: string, groups: readonly OutcomeGroup[], latency: readonly LatencySample[], since: Date, yours: number): TaskWindowStatus {
  const mine = groups.filter((g) => g.taskId === taskId);
  let runs = 0;
  let answered = 0;
  let inFlight = 0;
  let lastRunAt: Date | null = null;
  const failed = new Map<string, number>();
  let input = 0;
  let output = 0;
  let tokenRows = 0;
  let tokenReported = 0;
  let cost = 0;
  let costRecorded = 0;
  for (const g of mine) {
    runs += g.runs;
    lastRunAt = latest(lastRunAt, g.lastRequestedAt);
    if (g.outcome === ANSWERED) answered += g.runs;
    else if (g.outcome === IN_FLIGHT) inFlight += g.runs;
    else {
      const reason = g.failureClass ?? g.outcome;
      failed.set(reason, (failed.get(reason) ?? 0) + g.runs);
    }
    if (g.inputTokens !== null || g.outputTokens !== null) {
      input += g.inputTokens ?? 0;
      output += g.outputTokens ?? 0;
      tokenRows += 1;
    }
    tokenReported += Math.max(g.inputReported, g.outputReported);
    if (g.estimatedCostMicros !== null && g.costRecorded > 0) {
      cost += g.estimatedCostMicros;
      costRecorded += g.costRecorded;
    }
  }
  return {
    runs,
    answered,
    inFlight,
    notAnswered: [...failed.entries()].map(([reason, n]) => ({ reason, runs: n })).sort((a, b) => b.runs - a.runs || a.reason.localeCompare(b.reason)),
    lastRunAt,
    medianLatencyMs: median(latency.filter((l) => l.taskId === taskId && l.requestedAt.getTime() >= since.getTime()).map((l) => l.latencyMs)),
    tokens: tokenRows > 0 ? { input, output, reported: tokenReported } : null,
    reservedCostMicros: costRecorded > 0 ? { total: cost, recorded: costRecorded } : null,
    yours,
  };
}

/**
 * Every governed task, plus any task id the ledger recorded that this deployment does not know,
 * each over both windows. Ordered as the task registry, then unknown ids alphabetically.
 */
export function projectTaskStatus(input: {
  readonly now: Date;
  readonly outcomes: Readonly<Record<StatusWindowKey, readonly OutcomeGroup[]>>;
  readonly routes: readonly RouteGroup[];
  readonly latency: readonly LatencySample[];
  readonly own: Readonly<Record<StatusWindowKey, readonly OwnGroup[]>>;
}): TaskStatus[] {
  const known = AI_TASKS.map((t) => t.taskId);
  const seen = new Set([...input.outcomes['7d'], ...input.outcomes['24h']].map((g) => g.taskId));
  const ids = [...known, ...[...seen].filter((id) => !known.includes(id)).sort()];
  return ids.map((taskId) => {
    const windows = {} as Record<StatusWindowKey, TaskWindowStatus>;
    for (const w of STATUS_WINDOWS) {
      const since = new Date(input.now.getTime() - w.hours * 3600_000);
      const yours = input.own[w.key].filter((o) => o.taskId === taskId).reduce((n, o) => n + o.runs, 0);
      windows[w.key] = windowStatus(taskId, input.outcomes[w.key], input.latency, since, yours);
    }
    const route = [...input.routes]
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => (b.lastRequestedAt?.getTime() ?? 0) - (a.lastRequestedAt?.getTime() ?? 0))[0];
    const yourLastRunAt = input.own['7d'].filter((o) => o.taskId === taskId).reduce<Date | null>((d, o) => latest(d, o.lastRequestedAt), null);
    return {
      taskId,
      name: taskName(taskId),
      windows,
      latestRoute: route ? { providerId: route.providerId, model: route.requestedModelId, servedModel: route.servedModel } : null,
      yourLastRunAt,
    };
  });
}

// --- Provider policies -----------------------------------------------------------------------------

export interface ProviderPolicyRow {
  readonly providerId: string;
  /** NOT_RECORDED: nobody recorded a policy, so admission refuses this provider. */
  readonly state: 'ACTIVE' | 'KILLED' | 'NOT_RECORDED';
  readonly ceiling: string | null;
  readonly version: number | null;
  readonly recordedAt: Date | null;
}

export function projectProviderPolicies(
  providers: readonly string[],
  policies: readonly { readonly providerId: string; readonly state: 'ACTIVE' | 'KILLED'; readonly ceiling: string | null; readonly version: number; readonly recordedAtMs: number }[],
): ProviderPolicyRow[] {
  const ids = [...new Set([...providers, ...policies.map((p) => p.providerId)])];
  return ids.map((providerId) => {
    const p = policies.find((x) => x.providerId === providerId);
    return p
      ? { providerId, state: p.state, ceiling: p.ceiling, version: p.version, recordedAt: new Date(p.recordedAtMs) }
      : { providerId, state: 'NOT_RECORDED', ceiling: null, version: null, recordedAt: null };
  });
}

// --- Digest metadata -------------------------------------------------------------------------------

/**
 * The only digest fields this page may hold: metadata of the VIEWER's own digests. No content, no
 * provenance, no subject reference, no provider id.
 */
export interface DigestMetadata {
  readonly domain: string;
  readonly subjectKind: string;
  readonly coverage: string;
  readonly status: string;
  readonly generatedAt: Date;
  readonly windowEnd: Date;
  readonly evidenceCount: number;
  readonly version: number;
  readonly expiresAt: Date;
}

/** Organization-wide counts only, never a row. */
export interface DigestCount {
  readonly domain: string;
  readonly status: string;
  readonly coverage: string;
  readonly count: number;
}

/** Strip anything a reader handed back beyond the metadata allowlist, whatever it returned. */
export function digestMetadataOnly(rows: readonly Record<string, unknown>[]): DigestMetadata[] {
  const out: DigestMetadata[] = [];
  for (const r of rows) {
    const date = (v: unknown) => (v instanceof Date && !Number.isNaN(v.getTime()) ? v : null);
    const generatedAt = date(r.generatedAt);
    const windowEnd = date(r.windowEnd);
    const expiresAt = date(r.expiresAt);
    if (typeof r.domain !== 'string' || typeof r.subjectKind !== 'string' || typeof r.coverage !== 'string' || typeof r.status !== 'string') continue;
    if (!generatedAt || !windowEnd || !expiresAt || typeof r.evidenceCount !== 'number' || typeof r.version !== 'number') continue;
    out.push({ domain: r.domain, subjectKind: r.subjectKind, coverage: r.coverage, status: r.status, generatedAt, windowEnd, evidenceCount: r.evidenceCount, version: r.version, expiresAt });
  }
  return out;
}

export function digestCountsOnly(rows: readonly Record<string, unknown>[]): DigestCount[] {
  return rows
    .filter((r) => typeof r.domain === 'string' && typeof r.status === 'string' && typeof r.coverage === 'string' && typeof r.count === 'number')
    .map((r) => ({ domain: r.domain as string, status: r.status as string, coverage: r.coverage as string, count: r.count as number }));
}

/** A section's read, kept apart from its value, so "could not read" never renders as "none". */
export type Section<T> =
  | { readonly state: 'READ'; readonly value: T }
  | { readonly state: 'UNAVAILABLE' }
  /** The authority that owns the data exposes no read this page may use (yet). Nothing was read. */
  | { readonly state: 'NOT_EXPOSED' };

export interface IntelligenceStatus {
  readonly generatedAt: Date;
  readonly tasks: Section<{ readonly rows: readonly TaskStatus[]; readonly latencySampled: boolean }>;
  readonly providers: Section<readonly ProviderPolicyRow[]>;
  readonly yourDigests: Section<readonly DigestMetadata[]>;
  readonly organizationDigests: Section<readonly DigestCount[]>;
}
