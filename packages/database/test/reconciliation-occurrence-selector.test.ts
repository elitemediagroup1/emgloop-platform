// Reconciliation selects by PROVIDER OCCURRENCE — Stage 3.
//
// THE DEFECT THIS CLOSES
//
// Until PR #180 there was no occurrence column on integration_events, so the only
// way to reach a business day's rows was to scan a widened DELIVERY window and
// filter in memory. That works for live webhook traffic, where a call arrives
// seconds after it happens, and it fails completely for a RECOVERED call: one
// ingested today for an interval in August has receivedAt today and occurredAt in
// August, and a delivery-bounded scan around the August day never fetches it.
//
// The consequence is the reason this had to be fixed BEFORE any recovery runs:
// recovery would have written thousands of correct rows and reconciliation would
// have gone on reporting them missing — leaving a stored verdict that was true
// when written and false afterwards, with nothing to say so.
//
// WHAT THESE PROVE
//
//   1. a recovered row counts on the day it OCCURRED, not the day it arrived;
//   2. a legacy row with no occurrence column is still discoverable;
//   3. delivery time cannot redefine a business date;
//   4. today's verdicts do not move, because live traffic is delivered within the
//      window it occurred in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { easternBusinessDayWindow } from '@emgloop/shared';

import { IntegrationRepository } from '../src/repositories/integration.repository';
import { LOCAL_SCAN_MARGIN_MS } from '../src/services/provider-reconciliation.service';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');
const codeOf = (source: string): string =>
  source
    .split('\n')
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

const SERVICE_CODE = codeOf(readFileSync(join(SRC, 'services', 'provider-reconciliation.service.ts'), 'utf8'));

const ORG = 'org-alpha';
const DAY = '2026-08-11';
const WINDOW = easternBusinessDayWindow(DAY);

/** Noon Eastern inside the day — unambiguously inside, whatever the offset. */
const OCCURRED_IN_WINDOW = new Date(WINDOW.start.getTime() + 12 * 60 * 60 * 1000);
/** Two weeks later: when a recovery would actually have run. */
const RECOVERED_AT = new Date('2026-08-25T14:00:00.000Z');

interface Row {
  id: string;
  externalId: string;
  status: string;
  receivedAt: Date;
  occurredAt: Date | null;
  payload: Record<string, unknown>;
}

/**
 * A Prisma double that applies the WHERE clause for real.
 *
 * The whole point of this suite is which rows the query selects, so a double that
 * ignored the filter would prove nothing. It implements exactly the two operators
 * the repository uses — a half-open range and an IS NULL branch — and records the
 * `where` it was handed so the shape itself can be asserted.
 */
function prismaDouble(rows: Row[]) {
  const seen: Array<Record<string, unknown>> = [];
  const inRange = (value: Date | null, range: { gte: Date; lt: Date }): boolean =>
    value !== null && value.getTime() >= range.gte.getTime() && value.getTime() < range.lt.getTime();
  const prisma = {
    integrationEvent: {
      async findMany({ where, take }: { where: Record<string, any>; take: number }) {
        seen.push(where);
        const branches = where.OR as Array<Record<string, any>>;
        const after = where.id?.gt as string | undefined;
        const matched = rows.filter((row) => {
          if (row.status === '__other_org__') return false;
          if (where.provider && row.externalId.startsWith('other-provider')) return false;
          if (after && row.id <= after) return false;
          return branches.some((branch) => {
            if ('occurredAt' in branch && branch.occurredAt === null) {
              return row.occurredAt === null && inRange(row.receivedAt, branch.receivedAt);
            }
            return inRange(row.occurredAt, branch.occurredAt);
          });
        });
        return matched.slice(0, take).map((r) => ({ ...r }));
      },
    },
  };
  return { prisma, seen };
}

const read = (rows: Row[]) => {
  const { prisma, seen } = prismaDouble(rows);
  const repo = new IntegrationRepository(prisma as never);
  return {
    seen,
    run: () =>
      repo.listEventsForOccurrenceWindow(ORG, {
        provider: 'callgrid',
        since: WINDOW.start,
        until: WINDOW.end,
        legacySince: new Date(WINDOW.start.getTime() - LOCAL_SCAN_MARGIN_MS),
        legacyUntil: new Date(WINDOW.end.getTime() + LOCAL_SCAN_MARGIN_MS),
      }),
  };
};

const row = (over: Partial<Row> & { id: string }): Row => ({
  externalId: `call-${over.id}`,
  status: 'PROCESSED',
  receivedAt: OCCURRED_IN_WINDOW,
  occurredAt: OCCURRED_IN_WINDOW,
  payload: { id: `call-${over.id}` },
  ...over,
});

// --- 1. The recovered call --------------------------------------------------------

test('1. A RECOVERED CALL COUNTS ON THE DAY IT OCCURRED, NOT THE DAY IT ARRIVED', async () => {
  // Occurred on the August day; received two weeks later, by a recovery run. The
  // old delivery-bounded scan reached back only two days and never saw it.
  const recovered = row({ id: 'r1', occurredAt: OCCURRED_IN_WINDOW, receivedAt: RECOVERED_AT });
  const { run } = read([recovered]);
  const found = await run();
  assert.equal(found.length, 1, 'the recovered row is selected for its August day');
  assert.equal(found[0]!.id, 'r1');

  // And to be explicit about what changed: its delivery time is far outside the
  // widened delivery window that used to be the only way in.
  const legacyFloor = WINDOW.start.getTime() - LOCAL_SCAN_MARGIN_MS;
  const legacyCeiling = WINDOW.end.getTime() + LOCAL_SCAN_MARGIN_MS;
  assert.ok(
    RECOVERED_AT.getTime() > legacyCeiling || RECOVERED_AT.getTime() < legacyFloor,
    'the fixture really is outside the old scan',
  );
});

// --- 2. The legacy row ------------------------------------------------------------

test('2. a legacy row with NO occurrence column is still discoverable', async () => {
  // Written before PR #180. Its occurrence lives only inside `payload`, so it is
  // reached by the delivery window it was always reached by and judged in memory.
  const legacy = row({ id: 'l1', occurredAt: null, receivedAt: OCCURRED_IN_WINDOW });
  const found = await read([legacy]).run();
  assert.equal(found.length, 1, 'a null-occurrence row does not vanish');
  assert.equal(found[0]!.occurredAt, null, 'and it is handed up as null, for the caller to judge');
});

test('2b. a legacy row is fetched even when its payload occurrence is unresolvable', async () => {
  // It cannot be ruled OUT of the date, which is exactly what makes it impeach the
  // day. Excluding it in SQL would make it silently disappear from both sides.
  const opaque = row({ id: 'l2', occurredAt: null, payload: { nothing: 'useful' } });
  const found = await read([opaque]).run();
  assert.equal(found.length, 1);
});

test('2c. a legacy row delivered outside even the widened window is NOT selected', async () => {
  // The fallback is bounded. An ancient null-occurrence row is not dragged into
  // every day's comparison forever.
  const ancient = row({ id: 'l3', occurredAt: null, receivedAt: new Date('2026-06-01T00:00:00.000Z') });
  assert.equal((await read([ancient]).run()).length, 0);
});

// --- 3. Delivery time cannot redefine a business date -------------------------------

test('3. a row DELIVERED in the window but OCCURRING outside it is not selected', async () => {
  // The old scan fetched these and filtered them out in memory. The result is the
  // same and the query is now the thing that says so.
  const wrongDay = row({
    id: 'x1',
    occurredAt: new Date(WINDOW.end.getTime() + 60 * 60 * 1000),
    receivedAt: OCCURRED_IN_WINDOW,
  });
  assert.equal((await read([wrongDay]).run()).length, 0);
});

test('3b. the window is half-open: the closing instant belongs to the next day', async () => {
  const atEnd = row({ id: 'e1', occurredAt: WINDOW.end, receivedAt: WINDOW.end });
  const atStart = row({ id: 's1', occurredAt: WINDOW.start, receivedAt: WINDOW.start });
  const found = await read([atEnd, atStart]).run();
  assert.deepEqual(found.map((f) => f.id), ['s1'], 'start included, end excluded');
});

// --- 4. Today's verdicts do not move -------------------------------------------------

test('4. LIVE TRAFFIC SELECTS IDENTICALLY, so no existing verdict changes today', async () => {
  // A webhook call is delivered seconds after it happens, so it was inside the old
  // delivery window and is inside the new occurrence window. Every row this
  // platform holds today is of that shape; the only rows the change adds are ones
  // that do not exist yet, because no recovery has been run.
  const live = [
    row({ id: 'a', occurredAt: OCCURRED_IN_WINDOW, receivedAt: new Date(OCCURRED_IN_WINDOW.getTime() + 3_000) }),
    row({ id: 'b', occurredAt: OCCURRED_IN_WINDOW, receivedAt: new Date(OCCURRED_IN_WINDOW.getTime() + 90_000) }),
    // Retried the next morning: late by delivery, still the same business day.
    row({
      id: 'c',
      occurredAt: OCCURRED_IN_WINDOW,
      receivedAt: new Date(OCCURRED_IN_WINDOW.getTime() + 20 * 60 * 60 * 1000),
    }),
  ];
  const found = await read(live).run();
  assert.deepEqual(found.map((f) => f.id).sort(), ['a', 'b', 'c']);
});

// --- Query shape ---------------------------------------------------------------------

test('the query is organization-scoped, provider-scoped and batched', async () => {
  const { seen, run } = read([row({ id: 'q1' })]);
  await run();
  const where = seen[0]!;
  assert.equal(where.organizationId, ORG, 'tenant-scoped, per CLAUDE.md');
  assert.equal(where.provider, 'callgrid');
  assert.ok(Array.isArray(where.OR) && where.OR.length === 2, 'exactly two branches');
});

test('a projection failure does not remove a captured event from the comparison', async () => {
  // Reconciliation asks "did the provider's record arrive", not "was it projected".
  // A FAILED or RECEIVED row is captured evidence and must still be compared;
  // moving this question to MarketplaceCall would conflate delivery failure with
  // projection failure permanently.
  const rows = [
    row({ id: 'p1', status: 'PROCESSED' }),
    row({ id: 'p2', status: 'FAILED' }),
    row({ id: 'p3', status: 'RECEIVED' }),
    row({ id: 'p4', status: 'PROCESSING' }),
  ];
  const found = await read(rows).run();
  assert.equal(found.length, 4, 'status does not gate selection');
  assert.deepEqual(found.map((f) => f.status).sort(), ['FAILED', 'PROCESSED', 'PROCESSING', 'RECEIVED']);
});

// --- The service wiring ----------------------------------------------------------------

test('the verdict path passes the DAY as the occurrence window and the widened one as legacy', () => {
  assert.ok(SERVICE_CODE.includes('listEventsForOccurrenceWindow'), 'the service uses the new selector');
  assert.ok(!SERVICE_CODE.includes('listEventsReceivedBetween'), 'and not the old one');
  assert.match(SERVICE_CODE, /since:\s*window\.start,\s*\n\s*until:\s*window\.end,/);
  assert.match(SERVICE_CODE, /legacySince:\s*scanStart,\s*\n\s*legacyUntil:\s*scanEnd,/);
});

test('the stored occurrence column is preferred over re-resolving the payload', () => {
  assert.ok(
    SERVICE_CODE.includes('row.occurredAt ?? resolveOccurrence(payload).at'),
    'the column wins where it exists; the payload is the legacy fallback',
  );
});

test('reconciliation still compares at INTEGRATION_EVENT, not at the projection', () => {
  // The boundary is what makes "the provider never delivered it" distinguishable
  // from "it was delivered and never projected". Moving to MarketplaceCall would
  // merge the two questions permanently, whatever else it made convenient.
  for (const symbol of ['marketplaceCall', 'MarketplaceCall', 'sourceOccurredAt']) {
    assert.ok(!SERVICE_CODE.includes(symbol), `reconciliation must not read ${symbol}`);
  }
  assert.ok(SERVICE_CODE.includes('INTEGRATION_EVENT_STAGE'));
});

test('reconciliation still repairs nothing', () => {
  for (const symbol of ['IngestionService', '.ingest(', 'CallGridPollService', 'API_RECOVERY']) {
    assert.ok(!SERVICE_CODE.includes(symbol), `reconciliation must not reference ${symbol}`);
  }
});
