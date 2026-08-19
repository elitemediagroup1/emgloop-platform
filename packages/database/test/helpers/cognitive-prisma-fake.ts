// In-memory Prisma double for the cognitive repositories.
//
// Requires NO database. It stands in for the cognitive delegates and, crucially,
// ENFORCES the org-scoped @@unique constraints the way Postgres does (a colliding
// insert throws a P2002), so tenant-isolation and idempotency are proven, not
// assumed. It also implements the interactive $transaction(fn) form so the
// transactional-outbox invariants can be exercised deterministically.
//
// Scope is intentionally minimal: only the delegate methods the repositories
// actually use (create / findFirst / findMany / update) plus $transaction.

type Row = Record<string, any>;

// Delegates that carry a @@unique constraint (org-scoped composite, or global).
const UNIQUE_KEYS: Record<string, string[]> = {
  cognitiveIdentity: ['organizationId', 'entityType', 'canonicalKey'],
  memoryEvent: ['organizationId', 'sourceSystem', 'sourceEventId'],
  activeStateRecord: ['organizationId', 'identityId', 'domain', 'stateKey'],
  loopEvent: ['eventId'], // global @unique, matching the real LoopEvent model
  stateChangeDelivery: ['outboxId', 'subscriptionId'], // one delivery per (change, subscriber)
  cognitiveDecision: ['organizationId', 'idempotencyKey'], // NULL keys are distinct (Postgres)
  // Operational lifecycle. `recurrenceKey` is what makes the same situation
  // tomorrow the same row; `detectionKey` is what stops a page refresh
  // appending a sighting (NULL on operator-recorded rows, so the unique binds
  // only detection rows).
  operationalPriority: ['organizationId', 'sourceSystem', 'recurrenceKey'],
  user: ['organizationId', 'email'],
  // Commercial Intelligence Stage 2. TENANT-SCOPED, unlike marketplace_calls'
  // global (provider, externalId): re-running an evaluation over the same window
  // must reaffirm one determination rather than accumulate duplicates, and
  // `evaluatorId` is in the key so a future evaluator records its own.
  commercialSignal: [
    'organizationId',
    'performanceObjectiveId',
    'sourceSystem',
    'sourceKey',
    'evaluatorId',
  ],
  // Commercial Intelligence Stage 3. A binding version is unique per objective,
  // so two concurrent confirmations collide loudly instead of interleaving.
  objectiveMeasureBinding: ['performanceObjectiveId', 'version'],
  // A headline's identity is TIMESTAMP-FREE and tenant-scoped: the same
  // development next period must land on the same row, and two concurrent
  // detection runs must converge on one.
  headline: ['organizationId', 'performanceObjectiveId', 'recurrenceKey'],
  // TENANT-FIRST, unlike integration_events' global (provider, externalId): one
  // organization certifying a calendar day must never satisfy another's gate, so
  // organizationId leads the key here and the double enforces it.
  providerObservationDay: ['organizationId', 'provider', 'stream', 'businessDate'],
  // TENANT-FIRST for the same reason, and the reason re-running is safe: one
  // reconciliation answer per day per stream per tenant, rewritten in place.
  providerReconciliationDay: ['organizationId', 'provider', 'stream', 'businessDate'],
  // One member row per member per day. A re-run deletes the set and rewrites it
  // inside one transaction, so this only ever fires on a computation that
  // produced the same member twice.
  providerReconciliationMember: ['reconciliationDayId', 'memberDimension', 'memberExternalId'],
  // One source per key per tenant, and one row per metric per source -- so a
  // metric cannot be supported twice with two different definitions.
  measurementSource: ['organizationId', 'key'],
  measurementSourceMetric: ['measurementSourceId', 'metric'],
};

/**
 * Column defaults the schema applies and this double otherwise would not.
 *
 * Only the ones a query FILTERS on, which is what makes them matter: a row
 * created without `status` does not match `where status: 'PENDING'`, so a drain
 * that is correct in production silently finds nothing here. That is the worst
 * kind of test double — it fails a working query and invites someone to "fix"
 * the query until the fake is happy.
 *
 * Deliberately not a general default engine. These mirror `@default(...)` in
 * schema.prisma; if one drifts, the fake is wrong and should be corrected here.
 */
const COLUMN_DEFAULTS: Record<string, Row> = {
  // A performance objective is ACTIVE and open-ended unless stated otherwise,
  // matching @default(ACTIVE) — a row created without one must still match
  // `where status: 'ACTIVE'`, or the list query would be correct in production
  // and silently empty here.
  performanceObjective: { status: 'ACTIVE' },
  // A signal is established once and counted from one, matching @default(1).
  // firstEvaluatedAt / lastEvaluatedAt default to now() in the schema; the
  // repository sets lastEvaluatedAt explicitly on reaffirm, so only the create
  // path needs a default here and `createdAt` already supplies the instant.
  commercialSignal: { evaluationCount: 1 },
  user: { status: 'ACTIVE', metadata: {} },
  // A headline is established once and counted from one, matching @default(1).
  // The array columns default to empty in the schema; a repository reading one
  // back would work in production and throw here without them.
  headline: { detectionCount: 1, limitations: [], unknowns: [] },
  // A binding's population arrays default to empty, and `memberLabels` to {}.
  objectiveMeasureBinding: {
    campaignExternalIds: [],
    sourceExternalIds: [],
    buyerExternalIds: [],
    vendorExternalIds: [],
    callerStates: [],
    memberLabels: {},
  },
  stateChangeOutbox: { status: 'PENDING', attemptCount: 0, subjectType: 'ACTIVE_STATE' },
  stateChangeDelivery: { status: 'PENDING', attemptCount: 0, required: false },
  stateChangeSubscription: { status: 'ACTIVE', required: false, eventTypes: [] },
};

/**
 * Columns declared `@default(now())` in the schema, which this double must fill
 * for the same reason as COLUMN_DEFAULTS above: a repository that reads one back
 * would work in production and throw here, and the natural "fix" is to break the
 * repository until the fake is happy. They take the row's create instant, so
 * they stay consistent with `createdAt`.
 */
const TIMESTAMP_DEFAULTS: Record<string, string[]> = {
  commercialSignal: ['firstEvaluatedAt', 'lastEvaluatedAt'],
  // The repository sets both explicitly on create; these keep a row written by a
  // narrower future caller consistent with `createdAt`.
  headline: ['firstDetectedAt', 'lastDetectedAt'],
  objectiveMeasureBinding: ['confirmedAt'],
};

/**
 * Constraints that are NOT key equality: the effective-dated tables.
 *
 * `provider_member_expectations` carries a Postgres EXCLUDE constraint over the
 * member key and daterange(effectiveFrom, effectiveTo, '[)') -- at most one
 * declaration in force per member per business date. Prisma cannot express it, so
 * it is hand-written SQL in the migration, and a double that did not model it
 * would let the suite prove only the repository's own pre-check. The invariant
 * that actually matters under concurrency is the database's, so it is modelled
 * here: a direct write that overlaps throws the way Postgres does (23P01), and
 * the accompanying CHECK on an empty or inverted range throws 23514.
 *
 * Enforced on `create` alone. Truncating a range -- the only update this
 * repository makes -- can shrink an interval but never widen one, so it cannot
 * manufacture an overlap.
 */
const EXCLUSION_RANGES: Record<string, { keys: string[]; from: string; to: string }> = {
  providerMemberExpectation: {
    keys: ['organizationId', 'provider', 'stream', 'memberDimension', 'memberExternalId'],
    from: 'effectiveFrom',
    to: 'effectiveTo',
  },
  // At most one authority per member per MEASURE per date. The metric is part of
  // the key: one campaign taking call volume from a provider and revenue from a
  // counterparty on the same day is the case this whole layer exists for, and a
  // key without the metric would refuse it as an overlap.
  measureSourceAuthority: {
    keys: ['organizationId', 'memberDimension', 'memberExternalId', 'metric'],
    from: 'effectiveFrom',
    to: 'effectiveTo',
  },
};

function rangeBound(value: any, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  return value instanceof Date ? value.getTime() : Number(value);
}

// A delegate may carry more than one unique. Prisma enforces each independently.
const EXTRA_UNIQUE_KEYS: Record<string, string[][]> = {
  operationalObservation: [
    ['priorityId', 'sequence'],
    ['priorityId', 'detectionKey'],
  ],
  // A binding may supersede at most one predecessor. NULL is distinct in
  // Postgres, so this binds only rows that actually point at something.
  objectiveMeasureBinding: [['supersededByBindingId']],
};

const DELEGATES = [
  'cognitiveIdentity',
  'identityRole',
  'identityEvidence',
  'identityResolutionLink',
  'identityRelationship',
  'memoryEvent',
  'knowledgeAssertion',
  'dataGovernancePolicy',
  'activeStateRecord',
  'activeStateEvidence',
  'activeStateRevision',
  'stateChangeOutbox',
  'stateChangeSubscription',
  'stateChangeDelivery',
  'intelligenceHypothesis',
  'cognitiveDecision',
  'cognitiveProcessingAttempt',
  'auditLog',
  'loopEvent',
  'operationalPriority',
  'operationalObservation',
  'decisionEvidence',
  // Commercial Intelligence Stage 1. `user` is here because the Performance
  // Objective repository validates that a USER-scoped objective names an actual
  // member of the SAME organization, and that check is a real query — proving it
  // needs a real row to miss on.
  'user',
  'performanceObjective',
  // Commercial Intelligence Stage 2. `marketplaceCall` is NOT here: the
  // evaluation service reads calls through MarketplaceCallRepository, and its
  // tests supply that read directly rather than faking another domain's table.
  'commercialSignal',
  // Commercial Intelligence Stage 3. `marketplaceCall` is deliberately NOT here:
  // the detection service reads call AGGREGATES through MarketplaceCallRepository,
  // and its tests supply that read directly rather than faking another domain's
  // table — the same stance the Stage 2 tests take.
  'objectiveMeasureBinding',
  'headline',
  // Commercial Intelligence Stage 3 correctness. The observation ledger IS faked
  // here, unlike marketplaceCall: the detection gate reads it directly and the
  // property under test is exactly that a missing row withholds a measurement, so
  // supplying the read from the test would assume away what is being proven.
  'providerObservationDay',
  // Stage 3 correctness, second fact: what a human DECLARED about a population
  // member, effective-dated. Faked here for the same reason as the observation
  // ledger -- the property under test is that a missing declaration resolves
  // UNKNOWN and that overlapping ones cannot exist, so supplying the read from
  // the test would assume away what is being proven.
  'providerMemberExpectation',
  // Stage 3 correctness, third fact: whether what the provider held actually
  // ARRIVED. Both tables are faked because the property under test is exactly
  // that a re-run leaves one current answer and replaces its member set --
  // supplying either read from the test would assume away what is being proven.
  'providerReconciliationDay',
  'providerReconciliationMember',
  // Stage 3 correctness, fourth fact: WHOSE NUMBER a measure is. All three are
  // faked because the properties under test are that a missing authority fails
  // closed, that two cannot overlap, and that a source registered by one
  // organization cannot be named by another -- supplying any of those reads from
  // the test would assume away exactly what is being proven.
  'measurementSource',
  'measurementSourceMetric',
  'measureSourceAuthority',
] as const;

let idSeq = 0;
let timeSeq = 0;
function nextId(): string {
  return 'id_' + (++idSeq).toString(36);
}
// Monotonic timestamps so orderBy is deterministic even for same-millisecond
// inserts. Each row gets a strictly increasing createdAt/updatedAt.
function nextTime(): Date {
  return new Date(Date.UTC(2026, 0, 1) + ++timeSeq * 1000);
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function cmp(a: any, b: any): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (av === bv) return 0;
  if (av === undefined || av === null) return -1;
  if (bv === undefined || bv === null) return 1;
  return av < bv ? -1 : 1;
}

/**
 * Value equality the way Postgres compares a column, not the way JS compares a
 * reference.
 *
 * Two `Date`s for the same instant are `!==` in JavaScript, so a `where` on a
 * DATE or TIMESTAMP column matched nothing here while working perfectly in
 * production. A fake that UNDER-matches is as dangerous as one that over-matches:
 * it invites someone to rewrite a correct query until the double is happy.
 */
function sameValue(a: any, b: any): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function condMatches(value: any, cond: any): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date) return sameValue(value, cond);
  if (isPlainObject(cond)) {
    // EVERY operator present must hold, as Prisma ANDs them. This used to return
    // on the FIRST one it recognised, so `{ not: null, lt: cutoff }` silently
    // dropped the `lt` and matched every non-null row — a filter narrowing by
    // age would have passed its test while doing nothing. A fake that quietly
    // over-matches is worse than no fake: the suite stays green and the
    // assertion stops meaning anything.
    const checks: boolean[] = [];
    if ('not' in cond) {
      checks.push(cond.not === null ? value !== null && value !== undefined : value !== cond.not);
    }
    if ('in' in cond) checks.push((cond.in as any[]).some((c) => sameValue(value, c)));
    if ('notIn' in cond) checks.push(!(cond.notIn as any[]).some((c) => sameValue(value, c)));
    if ('gt' in cond) checks.push(value != null && cmp(value, cond.gt) > 0);
    if ('gte' in cond) checks.push(value != null && cmp(value, cond.gte) >= 0);
    if ('lt' in cond) checks.push(value != null && cmp(value, cond.lt) < 0);
    if ('lte' in cond) checks.push(value != null && cmp(value, cond.lte) <= 0);
    // An unrecognised operator must not silently pass. Matching nothing surfaces
    // as a failing assertion; matching everything hides a broken query.
    if (checks.length === 0) return false;
    return checks.every(Boolean);
  }
  return value === cond;
}

/**
 * Named compound uniques, as Prisma exposes them in a `where`.
 *
 * `findUnique({ where: { observation_day_identity: { ... } } })` nests the key
 * columns under the constraint's name. The double flattens that back to plain
 * columns so a repository written against the real client works here unchanged.
 */
const COMPOUND_UNIQUE_ALIASES: Record<string, string> = {
  providerObservationDay: 'observation_day_identity',
  providerReconciliationDay: 'reconciliation_day_identity',
};

function flattenCompound(name: string, where: Row | undefined): Row | undefined {
  const alias = COMPOUND_UNIQUE_ALIASES[name];
  if (!where || !alias || !isPlainObject(where[alias])) return where;
  const { [alias]: nested, ...rest } = where;
  return { ...rest, ...(nested as Row) };
}

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Row[]).every((w) => matches(row, w));
    if (key === 'NOT') return !matches(row, cond as Row);
    return condMatches(row[key], cond);
  });
}

function applyData(row: Row, data: Row): void {
  for (const [key, val] of Object.entries(data)) {
    if (isPlainObject(val) && 'increment' in val) row[key] = (row[key] ?? 0) + val.increment;
    else if (isPlainObject(val) && 'decrement' in val) row[key] = (row[key] ?? 0) - val.decrement;
    else row[key] = val;
  }
  row.updatedAt = nextTime();
}

function makeDelegate(name: string) {
  const rows: Row[] = [];
  const uniques: string[][] = [
    ...(UNIQUE_KEYS[name] ? [UNIQUE_KEYS[name]!] : []),
    ...(EXTRA_UNIQUE_KEYS[name] ?? []),
  ];

  return {
    __rows: rows,
    async create({ data }: { data: Row }): Promise<Row> {
      for (const uniqueKeys of uniques) {
        // Postgres treats a row as distinct when ANY indexed column is NULL, so a
        // unique only binds rows whose every key column is non-null.
        const anyNull = uniqueKeys.some((k) => data[k] === null || data[k] === undefined);
        const dup = anyNull ? undefined : rows.find((r) => uniqueKeys.every((k) => sameValue(r[k], data[k])));
        if (dup) {
          const e = new Error(
            `Unique constraint failed on the fields: (${uniqueKeys.join(',')})`,
          ) as Error & { code: string };
          e.code = 'P2002';
          throw e;
        }
      }
      const exclusion = EXCLUSION_RANGES[name];
      if (exclusion) {
        const from = rangeBound(data[exclusion.from], NaN);
        const to = rangeBound(data[exclusion.to], Number.POSITIVE_INFINITY);
        if (Number.isFinite(to) && to <= from) {
          const e = new Error(
            `new row for relation "${name}" violates check constraint (empty or inverted range)`,
          ) as Error & { code: string };
          e.code = '23514';
          throw e;
        }
        const clash = rows.find((r) => {
          if (!exclusion.keys.every((k) => sameValue(r[k], data[k]))) return false;
          const rFrom = rangeBound(r[exclusion.from], NaN);
          const rTo = rangeBound(r[exclusion.to], Number.POSITIVE_INFINITY);
          return from < rTo && rFrom < to;
        });
        if (clash) {
          const e = new Error(
            'conflicting key value violates exclusion constraint "provider_member_expectations_no_overlap"',
          ) as Error & { code: string };
          e.code = '23P01';
          throw e;
        }
      }
      const now = nextTime();
      const row: Row = {
        id: data.id ?? nextId(),
        createdAt: now,
        updatedAt: now,
        // Schema defaults first, so anything the caller passed still wins.
        ...(COLUMN_DEFAULTS[name] ?? {}),
        // `availableAt` defaults to now() in the schema for the queue models.
        ...(COLUMN_DEFAULTS[name] && 'status' in (COLUMN_DEFAULTS[name] as Row)
          ? { availableAt: now }
          : {}),
        ...Object.fromEntries((TIMESTAMP_DEFAULTS[name] ?? []).map((k) => [k, now])),
        ...data,
      };
      rows.push(row);
      return { ...row };
    },
    async findFirst(
      { where, orderBy, select }: { where?: Row; orderBy?: any; select?: Row } = {},
    ): Promise<Row | null> {
      const found = sortRows(rows.filter((r) => matches(r, where)), orderBy);
      return found.length ? project({ ...found[0] }, select) : null;
    },
    async findUnique({ where }: { where: Row }): Promise<Row | null> {
      const found = rows.find((r) => matches(r, flattenCompound(name, where)));
      return found ? { ...found } : null;
    },
    async findMany(
      { where, orderBy, take, select, distinct }: {
        where?: Row; orderBy?: any; take?: number; select?: Row; distinct?: string[];
      } = {},
    ): Promise<Row[]> {
      let out = sortRows(rows.filter((r) => matches(r, where)), orderBy);
      // Applied BEFORE take, as Prisma does: `distinct` then `take` returns N
      // distinct rows, whereas the reverse would return the distinct subset of
      // the first N — a difference that matters to a drain paging through
      // organizations.
      if (distinct?.length) {
        const seen = new Set<string>();
        out = out.filter((r) => {
          const key = distinct.map((k) => String(r[k])).join(' ');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      if (typeof take === 'number') out = out.slice(0, take);
      return out.map((r) => project({ ...r }, select)!);
    },
    async update({ where, data }: { where: Row; data: Row }): Promise<Row> {
      const row = rows.find((r) => matches(r, flattenCompound(name, where)));
      if (!row) throw new Error(`${name}.update: row not found`);
      applyData(row, data);
      return { ...row };
    },
    /**
     * Insert-or-update on a unique. Prisma's semantics: the row is matched on the
     * `where` unique, `update` is applied when it exists and `create` when it does
     * not — so a caller re-running the same operation converges on ONE row rather
     * than accumulating. That convergence is the property tests assert, so the
     * double has to model it rather than approximate it with create-then-catch.
     */
    async upsert({ where, create, update }: { where: Row; create: Row; update: Row }): Promise<Row> {
      const flat = flattenCompound(name, where);
      const row = rows.find((r) => matches(r, flat));
      if (row) {
        applyData(row, update);
        return { ...row };
      }
      return this.create({ data: create });
    },
    // Conditional bulk update. Returns { count } like Prisma — the basis for the
    // atomic single-claim gate (updateMany where status=PENDING → PROCESSING):
    // exactly the rows still matching the guard are flipped.
    async updateMany({ where, data }: { where?: Row; data: Row }): Promise<{ count: number }> {
      const targets = rows.filter((r) => matches(r, where));
      for (const row of targets) applyData(row, data);
      return { count: targets.length };
    },
    // Conditional bulk delete. Returns { count } like Prisma. Used where a set of
    // child rows is REPLACED rather than merged, so a row that stopped being
    // produced cannot linger from a previous run looking like a current fact.
    async deleteMany({ where }: { where?: Row } = {}): Promise<{ count: number }> {
      const doomed = rows.filter((r) => matches(r, where));
      for (const row of doomed) {
        const at = rows.indexOf(row);
        if (at >= 0) rows.splice(at, 1);
      }
      return { count: doomed.length };
    },
    async count({ where }: { where?: Row } = {}): Promise<number> {
      return rows.filter((r) => matches(r, where)).length;
    },
  };
}

// `select` narrows the returned columns, as Prisma does. Faithful enough that a
// repository relying on a projection cannot pass here and fail in production.
function project(row: Row | null, select?: Row): Row | null {
  if (!row || !select) return row;
  const out: Row = {};
  for (const [k, want] of Object.entries(select)) if (want) out[k] = row[k];
  return out;
}

function sortRows(list: Row[], orderBy: any): Row[] {
  if (!orderBy) return list;
  const keys = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...list].sort((a, b) => {
    for (const spec of keys) {
      const [field, dir] = Object.entries(spec)[0] as [string, 'asc' | 'desc'];
      const c = cmp(a[field], b[field]);
      if (c !== 0) return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

export interface CognitivePrismaFake {
  [delegate: string]: any;
  $transaction: <T>(fn: (tx: CognitivePrismaFake) => Promise<T>) => Promise<T>;
}

/** Build a fresh in-memory cognitive Prisma double. */
export function makeCognitivePrisma(): CognitivePrismaFake {
  const fake: any = {};
  for (const d of DELEGATES) fake[d] = makeDelegate(d);
  // Interactive transaction: run against the same in-memory tables. Rollback is
  // not simulated — Increment 1 tests assert commit atomicity, not partial
  // failure, so a straight-through application is faithful for those cases.
  fake.$transaction = async <T>(fn: (tx: CognitivePrismaFake) => Promise<T>): Promise<T> => fn(fake);
  return fake as CognitivePrismaFake;
}
