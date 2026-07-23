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

function condMatches(value: any, cond: any): boolean {
  if (cond === null) return value === null || value === undefined;
  if (isPlainObject(cond)) {
    if ('not' in cond) return value !== cond.not;
    if ('in' in cond) return (cond.in as any[]).includes(value);
    if ('gt' in cond) return value != null && cmp(value, cond.gt) > 0;
    if ('gte' in cond) return value != null && cmp(value, cond.gte) >= 0;
    if ('lt' in cond) return value != null && cmp(value, cond.lt) < 0;
    if ('lte' in cond) return value != null && cmp(value, cond.lte) <= 0;
    return false;
  }
  return value === cond;
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
  const uniqueKeys = UNIQUE_KEYS[name];

  return {
    __rows: rows,
    async create({ data }: { data: Row }): Promise<Row> {
      if (uniqueKeys) {
        // Postgres treats a row as distinct when ANY indexed column is NULL, so a
        // unique only binds rows whose every key column is non-null.
        const anyNull = uniqueKeys.some((k) => data[k] === null || data[k] === undefined);
        const dup = anyNull ? undefined : rows.find((r) => uniqueKeys.every((k) => r[k] === data[k]));
        if (dup) {
          const e = new Error(
            `Unique constraint failed on the fields: (${uniqueKeys.join(',')})`,
          ) as Error & { code: string };
          e.code = 'P2002';
          throw e;
        }
      }
      const now = nextTime();
      const row: Row = {
        id: data.id ?? nextId(),
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      rows.push(row);
      return { ...row };
    },
    async findFirst({ where, orderBy }: { where?: Row; orderBy?: any } = {}): Promise<Row | null> {
      const found = sortRows(rows.filter((r) => matches(r, where)), orderBy);
      return found.length ? { ...found[0] } : null;
    },
    async findUnique({ where }: { where: Row }): Promise<Row | null> {
      const found = rows.find((r) => matches(r, where));
      return found ? { ...found } : null;
    },
    async findMany(
      { where, orderBy, take }: { where?: Row; orderBy?: any; take?: number } = {},
    ): Promise<Row[]> {
      let out = sortRows(rows.filter((r) => matches(r, where)), orderBy);
      if (typeof take === 'number') out = out.slice(0, take);
      return out.map((r) => ({ ...r }));
    },
    async update({ where, data }: { where: Row; data: Row }): Promise<Row> {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error(`${name}.update: row not found`);
      applyData(row, data);
      return { ...row };
    },
    // Conditional bulk update. Returns { count } like Prisma — the basis for the
    // atomic single-claim gate (updateMany where status=PENDING → PROCESSING):
    // exactly the rows still matching the guard are flipped.
    async updateMany({ where, data }: { where?: Row; data: Row }): Promise<{ count: number }> {
      const targets = rows.filter((r) => matches(r, where));
      for (const row of targets) applyData(row, data);
      return { count: targets.length };
    },
    async count({ where }: { where?: Row } = {}): Promise<number> {
      return rows.filter((r) => matches(r, where)).length;
    },
  };
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
