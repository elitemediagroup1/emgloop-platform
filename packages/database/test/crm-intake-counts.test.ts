// Customer intake counts — every number means what its label says.
//
// Regression for the live preview: the People "New" chip said 4,884 and
// "Contacted" 113, while filtering by those statuses (and the Intake Board)
// showed 1,864 and 136, and Command Center's Active Intake showed 4,997. None
// was a count of the organization's customers:
//   - statusCounts() read 5,000 customers in no order and counted those;
//   - listCustomers({ status }) read the 2,000 newest and filtered those, then
//     reported that as the total;
//   - kanbanBoard() read the 2,000 most recently active and counted those.
// Contacted could be HIGHER in the 2,000-row slice than in the 5,000-row one
// because the two were different, arbitrary subsets.
//
// Status is a JSON attribute, so exact counts need a database filter on the JSON
// path -- and SQL's three-valued logic makes the obvious filter for New wrong: a
// customer with no pipelineStatus key has a NULL path, NOT(NULL) is not true,
// and NOT(any other status) silently drops them. This fake evaluates `where`
// with that same three-valued logic, and the first test pins it to what Postgres
// actually returned for each attribute shape (observed 2026-09-15, Postgres 16,
// Prisma 5, against a disposable local database).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  CrmRepository,
  KANBAN_CARD_LIMIT,
  PIPELINE_STATUSES,
  customerStatusWhere,
  readPipelineStatus,
  type PipelineStatus,
} from '../src/repositories/crm.repository';

type Row = Record<string, any>;
type Truth = boolean | null; // null = SQL UNKNOWN

// ---- A customer table that evaluates `where` the way Postgres does ----------

/** `attributes #> '{key}'`: SQL NULL unless attributes is an object that has the key. */
function jsonPath(attributes: unknown, path: string[]): { sqlNull: true } | { value: unknown } {
  let cur: unknown = attributes;
  for (const key of path) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !(key in (cur as Row))) return { sqlNull: true };
    cur = (cur as Row)[key];
  }
  return { value: cur };
}

function fieldTruth(row: Row, key: string, cond: any): Truth {
  const value = row[key];
  if (key === 'attributes' && cond && 'path' in cond) {
    const got = jsonPath(value, cond.path);
    if (cond.equals === Prisma.DbNull) return 'sqlNull' in got;
    if (cond.equals === Prisma.JsonNull) return !('sqlNull' in got) && got.value === null;
    if ('sqlNull' in got) return null;
    return got.value === cond.equals;
  }
  if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
    if ('in' in cond) return value == null ? null : cond.in.includes(value);
    if ('has' in cond) return Array.isArray(value) ? value.includes(cond.has) : null;
    if ('contains' in cond) {
      if (value == null) return null;
      const hay = cond.mode === 'insensitive' ? String(value).toLowerCase() : String(value);
      const needle = cond.mode === 'insensitive' ? String(cond.contains).toLowerCase() : String(cond.contains);
      return hay.includes(needle);
    }
    throw new Error(`fake: unsupported condition on ${key}: ${JSON.stringify(cond)}`);
  }
  return value == null ? null : value === cond;
}

function truth(row: Row, where: any): Truth {
  if (!where) return true;
  const parts: Truth[] = Object.entries(where).map(([key, cond]): Truth => {
    if (key === 'AND') return and((cond as any[]).map((w) => truth(row, w)));
    if (key === 'OR') return or((cond as any[]).map((w) => truth(row, w)));
    if (key === 'NOT') {
      const t = Array.isArray(cond) ? and((cond as any[]).map((w) => truth(row, w))) : truth(row, cond);
      return t === null ? null : !t;
    }
    return fieldTruth(row, key, cond);
  });
  return and(parts);
}
const and = (ts: Truth[]): Truth => (ts.includes(false) ? false : ts.includes(null) ? null : true);
const or = (ts: Truth[]): Truth => (ts.includes(true) ? true : ts.includes(null) ? null : false);
const matches = (row: Row, where: any) => truth(row, where) === true;

function sortRows(rows: Row[], orderBy: any): Row[] {
  if (!orderBy) return rows;
  const [[key, dir]] = Object.entries(orderBy) as [[string, 'asc' | 'desc']];
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    // Postgres: NULLS LAST ascending, NULLS FIRST descending.
    if (x == null && y == null) return 0;
    if (x == null) return dir === 'desc' ? -1 : 1;
    if (y == null) return dir === 'desc' ? 1 : -1;
    const c = x < y ? -1 : x > y ? 1 : 0;
    return dir === 'desc' ? -c : c;
  });
}

function makeDb(customers: Row[]) {
  const calls: { op: string; take?: number }[] = [];
  const customer = {
    async count({ where }: any) {
      calls.push({ op: 'count' });
      return customers.filter((r) => matches(r, where)).length;
    },
    async findMany({ where, orderBy, skip = 0, take }: any) {
      calls.push({ op: 'findMany', take });
      const found = sortRows(customers.filter((r) => matches(r, where)), orderBy);
      return found.slice(skip, take === undefined ? undefined : skip + take).map((r) => ({ ...r }));
    },
    async findFirst({ where }: any) {
      const r = customers.find((c) => matches(c, where));
      return r ? { ...r } : null;
    },
    async update({ where, data }: any) {
      const r = customers.find((c) => c.id === where.id);
      if (!r) throw new Error('fake: update of a missing row');
      Object.assign(r, data);
      r.updates = (r.updates ?? 0) + 1;
      return { ...r };
    },
  };
  const db = {
    customer,
    interaction: { async findMany() { return []; } },
    async $transaction(ops: Promise<unknown>[]) { return Promise.all(ops); },
  };
  return { db: db as unknown as PrismaClient, calls, customers };
}

// ---- Pinning the fake to Postgres --------------------------------------------

const SHAPES: [string, unknown][] = [
  ['empty-object', {}], ['null-status', { pipelineStatus: null }], ['New', { pipelineStatus: 'New' }],
  ['Contacted', { pipelineStatus: 'Contacted' }], ['lowercase', { pipelineStatus: 'contacted' }],
  ['number', { pipelineStatus: 5 }], ['other-keys', { city: 'Austin' }], ['Archived', { pipelineStatus: 'Archived' }],
  ['array-attrs', ['x']], ['string-attrs', 'Contacted'], ['nested-obj', { pipelineStatus: { v: 'Contacted' } }],
];
const shapeRows = () => SHAPES.map(([label, attributes], i) => ({ id: label, firstName: label, organizationId: 'org', attributes, createdAt: new Date(2026, 0, 1 + i) }));
const names = (rows: Row[], where: any) => rows.filter((r) => matches(r, where)).map((r) => r.firstName).sort();
const eq = (s: string) => ({ attributes: { path: ['pipelineStatus'], equals: s } });
const NON_NEW = PIPELINE_STATUSES.filter((s) => s !== 'New');

test('the fake evaluates JSON-path filters exactly as Postgres did for every attribute shape', () => {
  const rows = shapeRows();
  assert.deepEqual(names(rows, eq('Contacted')), ['Contacted']);
  assert.deepEqual(names(rows, { NOT: { OR: NON_NEW.map(eq) } }), ['New', 'lowercase', 'nested-obj', 'null-status', 'number']);
  assert.deepEqual(names(rows, { attributes: { path: ['pipelineStatus'], equals: Prisma.DbNull } }), ['array-attrs', 'empty-object', 'other-keys', 'string-attrs']);
  assert.deepEqual(names(rows, { attributes: { path: ['pipelineStatus'], equals: Prisma.JsonNull } }), ['null-status']);
});

test('each status filter selects exactly the customers readPipelineStatus() reads as that status', () => {
  const rows = shapeRows();
  const seen = new Map<string, PipelineStatus>();
  for (const status of PIPELINE_STATUSES) {
    const selected = names(rows, customerStatusWhere(status));
    const expected = rows.filter((r) => readPipelineStatus(r as never) === status).map((r) => r.firstName).sort();
    assert.deepEqual(selected, expected, status);
    for (const n of selected) {
      assert.equal(seen.has(n), false, `${n} is in one status only`);
      seen.set(n, status);
    }
  }
  assert.equal(seen.size, rows.length, 'every customer is in exactly one status');
  // Why New has two branches: the one-branch filter loses customers with no status stored.
  const naiveNew = names(rows, { NOT: { OR: NON_NEW.map(eq) } });
  assert.ok(names(rows, customerStatusWhere('New')).length > naiveNew.length);
});

// ---- A book bigger than every old cap ----------------------------------------

const ORG = 'org_session';
const OTHER = 'org_other';

/**
 * 6,000 customers in ORG (+ 50 in another org). Older customers are mostly New;
 * recent ones are more often Contacted -- so any "recent 2,000" slice disagrees
 * with the whole, exactly as on the preview. Shapes rotate so New includes
 * customers with no status stored at all.
 */
function book() {
  const rows: Row[] = [];
  const t0 = Date.UTC(2025, 0, 1);
  for (let i = 0; i < 6000; i++) {
    const recent = i >= 4000;
    const roll = (i * 7919) % 100;
    let status: string | undefined =
      recent ? (roll < 20 ? 'Contacted' : roll < 23 ? 'Quoted' : roll < 25 ? 'Booked' : undefined)
             : (roll < 2 ? 'Contacted' : roll < 3 ? 'Completed' : roll < 4 ? 'Archived' : undefined);
    const attributes = status ? { pipelineStatus: status } : i % 3 === 0 ? {} : i % 3 === 1 ? { pipelineStatus: 'New' } : { city: 'Austin' };
    rows.push({
      id: `c${String(i).padStart(4, '0')}`,
      organizationId: ORG,
      firstName: `Person${i}`,
      lastName: 'Sample',
      email: `p${i}@example.test`,
      phone: null,
      externalId: null,
      tags: i % 10 === 0 ? ['VIP'] : [],
      attributes,
      createdAt: new Date(t0 + i * 60_000),
      lastSeenAt: i % 17 === 0 ? null : new Date(t0 + ((i * 37) % 6000) * 60_000),
    });
  }
  for (let i = 0; i < 50; i++) {
    rows.push({ id: `x${i}`, organizationId: OTHER, firstName: 'Other', lastName: null, email: null, phone: null, externalId: null, tags: [], attributes: { pipelineStatus: 'Contacted' }, createdAt: new Date(t0), lastSeenAt: null });
  }
  return rows;
}

function truthCounts(rows: Row[], filter: (r: Row) => boolean = () => true) {
  const counts = Object.fromEntries(PIPELINE_STATUSES.map((s) => [s, 0])) as Record<PipelineStatus, number>;
  for (const r of rows) if (r.organizationId === ORG && filter(r)) counts[readPipelineStatus(r as never)] += 1;
  return counts;
}

test('statusCounts are exact counts of every customer, past the old 5,000 cap, and never read rows', async () => {
  const { db, calls, customers } = makeDb(book());
  const counts = await new CrmRepository(db).statusCounts(ORG);
  const truth = truthCounts(customers);
  assert.deepEqual(counts, truth);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 6000, 'they sum to the organization\'s customers');
  assert.ok(truth.New > 0 && truth.Contacted > 0 && truth.Archived > 0);
  assert.equal(calls.some((c) => c.op === 'findMany'), false, 'counts are COUNT queries, not a bounded fetch');
  // Command Center's Active Intake is New + Contacted + Quoted of these counts.
  assert.equal(counts.New + counts.Contacted + counts.Quoted, truth.New + truth.Contacted + truth.Quoted);
});

test('a status filter reports the full population as its total and pages through all of it', async () => {
  const { db, customers } = makeDb(book());
  const repo = new CrmRepository(db);
  const counts = await repo.statusCounts(ORG);
  for (const status of PIPELINE_STATUSES) {
    const first = await repo.listCustomers(ORG, { status, pageSize: 25 });
    assert.equal(first.total, counts[status], `${status}: list total equals its chip`);
    assert.equal(first.pageCount, Math.max(1, Math.ceil(counts[status] / 25)));
    for (const r of first.rows) assert.equal(r.status, status);
  }
  // The last page of New is reachable and holds the oldest New customers.
  const newRows = customers.filter((r) => r.organizationId === ORG && readPipelineStatus(r as never) === 'New')
    .sort((a, b) => b.createdAt - a.createdAt);
  const pages = Math.ceil(newRows.length / 100);
  const last = await repo.listCustomers(ORG, { status: 'New', pageSize: 100, page: pages });
  assert.deepEqual(last.rows.map((r) => r.id), newRows.slice((pages - 1) * 100).map((r) => r.id));
});

test('status chips count within the current search and tag, so each equals the list it opens', async () => {
  const { db, customers } = makeDb(book());
  const repo = new CrmRepository(db);
  const counts = await repo.statusCounts(ORG, { tag: 'VIP', search: 'person1' });
  const inView = (r: Row) => r.tags.includes('VIP') && String(r.firstName).toLowerCase().includes('person1');
  assert.deepEqual(counts, truthCounts(customers, inView));
  for (const status of PIPELINE_STATUSES) {
    const list = await repo.listCustomers(ORG, { status, tag: 'VIP', search: 'person1' });
    assert.equal(list.total, counts[status], status);
  }
});

test('sorting by status is exact at any size and orders by status, then newest first', async () => {
  const { db, customers } = makeDb(book());
  const repo = new CrmRepository(db);
  const org = customers.filter((r) => r.organizationId === ORG);
  const rank = (r: Row) => PIPELINE_STATUSES.indexOf(readPipelineStatus(r as never));
  for (const direction of ['asc', 'desc'] as const) {
    const expected = [...org].sort((a, b) => (direction === 'asc' ? rank(a) - rank(b) : rank(b) - rank(a)) || b.createdAt - a.createdAt);
    const counts = truthCounts(customers);
    // A page that straddles the boundary between the first and second status.
    const first = direction === 'asc' ? counts.New : counts.Archived;
    const page = Math.floor(first / 100) + 1;
    const result = await repo.listCustomers(ORG, { sort: 'status', direction, pageSize: 100, page });
    assert.equal(result.total, 6000, direction);
    assert.deepEqual(result.rows.map((r) => r.id), expected.slice((page - 1) * 100, page * 100).map((r) => r.id), direction);
  }
});

test('the Intake Board counts every customer per status and discloses when it shows fewer cards', async () => {
  const { db, customers } = makeDb(book());
  const board = await new CrmRepository(db).kanbanBoard(ORG);
  const truth = truthCounts(customers);
  assert.deepEqual(board.map((c) => [c.status, c.count]), PIPELINE_STATUSES.map((s) => [s, truth[s]]));
  assert.equal(board.reduce((n, c) => n + c.count, 0), 6000);
  for (const col of board) {
    assert.equal(col.cards.length, Math.min(col.count, KANBAN_CARD_LIMIT), col.status);
    // The cards are the most recently active of THAT status, not of a 2,000-row slice.
    const expected = sortRows(customers.filter((r) => r.organizationId === ORG && readPipelineStatus(r as never) === col.status), { lastSeenAt: 'desc' })
      .slice(0, KANBAN_CARD_LIMIT).map((r) => r.id);
    assert.deepEqual(col.cards.map((c) => c.id), expected, col.status);
  }
  const page = (await import('node:fs')).readFileSync(new URL('../../../apps/web/src/app/crm/pipeline/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /\{col\.cards\.length < col\.count \? \(/);
  assert.match(page, /Showing the \{col\.cards\.length\} most recently active of \{col\.count\.toLocaleString\('en-US'\)\}/);
});

test('bulk writes touch exactly the posted IDs that belong to the organization, each once', async () => {
  for (const op of ['status', 'tag', 'assign'] as const) {
    const { db, customers } = makeDb(book());
    const repo = new CrmRepository(db);
    const posted = ['c0001', 'c0002', 'c0001', 'x1', 'does-not-exist'];
    const n =
      op === 'status' ? await repo.bulkSetStatus(ORG, posted, 'Booked')
      : op === 'tag' ? await repo.bulkAddTag(ORG, posted, 'Priority')
      : await repo.bulkAssign(ORG, posted, { humanName: 'Charlie' });
    assert.equal(n, 2, op);
    const touched = customers.filter((r) => r.updates).map((r) => [r.id, r.updates]);
    assert.deepEqual(touched, [['c0001', 1], ['c0002', 1]], `${op}: only the selection, once each, never another organization's row`);
  }
});
