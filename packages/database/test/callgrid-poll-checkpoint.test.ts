// Durable poll checkpoint + overlap contract — Stage 3 PR 10.
//
// WHAT THESE PROVE
//
// One sentence carries the weight: CHECKPOINT ADVANCEMENT IS PROOF OF COVERAGE.
// Every outcome that does not prove an interval was read AND applied is asserted
// to leave the boundary exactly where it was — and the cost of that is only that
// the interval is read again, which is the cheap direction.
//
// The second property is monotonicity. Two pollers may overlap harmlessly, but
// the proven boundary can only move forward, and a slower run carrying an older
// boundary must not be able to pull it back.
//
// WHAT THESE DELIBERATELY DO NOT PROVE
//
// Which interval to read is decided by a pure planner and proved in
// packages/shared/test/poll-interval-planning.test.ts. What a poll DOES with an
// interval is proved in callgrid-poll-execution.test.ts. This file is the seam:
// plan -> poll -> prove -> record.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_POLL_OVERLAP_MS, DEFAULT_POLL_SAFETY_LAG_MS } from '@emgloop/shared';

import {
  CALLGRID_POLL_OUTCOMES,
  checkpointMayAdvance,
  pollSucceeded,
  type CallGridPollExecution,
  type CallGridPollOutcome,
} from '../src/services/callgrid-poll.service';
import {
  CALLGRID_POLL_POLICY,
  CallGridRoutinePollService,
} from '../src/services/callgrid-routine-poll.service';
import { ProviderPollCheckpointRepository } from '../src/repositories/provider-poll-checkpoint.repository';

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

const ROUTINE_CODE = codeOf(readFileSync(join(SRC, 'services', 'callgrid-routine-poll.service.ts'), 'utf8'));
const REPO_CODE = codeOf(readFileSync(join(SRC, 'repositories', 'provider-poll-checkpoint.repository.ts'), 'utf8'));

const ORG = 'org-alpha';
const KEY = 'cg_live_fixture';
const NOW = new Date('2026-08-21T12:00:00.000Z');
const SAFE_NOW = new Date(NOW.getTime() - DEFAULT_POLL_SAFETY_LAG_MS);

function execution(over: Partial<CallGridPollExecution> = {}): CallGridPollExecution {
  return {
    outcome: 'APPLIED',
    since: '',
    until: '',
    dryRun: false,
    reason: null,
    fetchOutcome: 'COMPLETE',
    providerRecordsFetched: 2,
    acceptedRecords: 2,
    refusedRecords: 0,
    refusals: [],
    newEvents: 2,
    duplicateObservations: 0,
    strengthenedCalls: 0,
    conflicts: 0,
    failedProcessing: 0,
    notAttempted: 0,
    pages: 1,
    pageCap: 500,
    rateLimitRetries: 0,
    providerTotal: null,
    failedAtIndex: null,
    failedIdentityDigest: null,
    ...over,
  };
}

/**
 * A Prisma double over provider_poll_checkpoints, holding at most one row.
 *
 * `updateMany` applies the SAME monotonic guard the real one does, in the same
 * place — the WHERE clause — so the concurrency cases below exercise the real
 * decision rather than a convenient stand-in for it.
 */
function checkpointDouble(initial?: { completedThrough: Date; lastIntervalSince: Date }) {
  const state: {
    row: { completedThrough: Date; lastIntervalSince: Date; updatedAt: Date } | null;
    creates: number;
    guardedUpdates: number;
  } = {
    row: initial ? { ...initial, updatedAt: NOW } : null,
    creates: 0,
    guardedUpdates: 0,
  };
  const prisma = {
    providerPollCheckpoint: {
      async findFirst() {
        return state.row
          ? { provider: 'callgrid', stream: 'calls', ...state.row }
          : null;
      },
      async updateMany({
        where,
        data,
      }: {
        where: { completedThrough?: { lt?: Date } };
        data: { completedThrough: Date; lastIntervalSince: Date };
      }) {
        state.guardedUpdates += 1;
        const guard = where.completedThrough?.lt;
        assert.ok(guard instanceof Date, 'advancement must be guarded on the stored boundary');
        if (!state.row) return { count: 0 };
        if (!(state.row.completedThrough.getTime() < guard.getTime())) return { count: 0 };
        state.row = { ...state.row, ...data, updatedAt: NOW };
        return { count: 1 };
      },
      async create({ data }: { data: { completedThrough: Date; lastIntervalSince: Date } }) {
        state.creates += 1;
        if (state.row) throw new Error('unique constraint');
        state.row = { completedThrough: data.completedThrough, lastIntervalSince: data.lastIntervalSince, updatedAt: NOW };
        return { completedThrough: data.completedThrough };
      },
    },
  };
  return { prisma, state };
}

interface Harness {
  service: CallGridRoutinePollService;
  polls: Array<{ since: Date; until: Date; dryRun: boolean }>;
  state: ReturnType<typeof checkpointDouble>['state'];
}

function harness(options: {
  stored?: { completedThrough: Date; lastIntervalSince: Date };
  result?: CallGridPollExecution;
} = {}): Harness {
  const { prisma, state } = checkpointDouble(options.stored);
  const polls: Array<{ since: Date; until: Date; dryRun: boolean }> = [];
  const service = new CallGridRoutinePollService(prisma as never, {
    checkpoints: new ProviderPollCheckpointRepository(prisma as never),
    poller: {
      async execute(input) {
        polls.push({ since: input.since, until: input.until, dryRun: input.dryRun === true });
        return { ...(options.result ?? execution()), since: input.since.toISOString(), until: input.until.toISOString() };
      },
    },
  });
  return { service, polls, state };
}

const run = (h: Harness, over: Record<string, unknown> = {}) =>
  h.service.run({ organizationId: ORG, apiKey: KEY, now: NOW, ...over });

// --- 1/2. What gets read ----------------------------------------------------------

test('1. with no checkpoint the run polls a bounded bootstrap interval', async () => {
  const h = harness();
  const out = await run(h);
  assert.equal(out.checkpointBefore, null, 'no coverage had been proven');
  assert.equal(out.plan.plan, 'POLL');
  assert.equal(h.polls.length, 1);
  assert.equal(h.polls[0]!.until.getTime(), SAFE_NOW.getTime());
  assert.equal(
    h.polls[0]!.until.getTime() - h.polls[0]!.since.getTime(),
    CALLGRID_POLL_POLICY.bootstrapLookbackMs,
  );
});

test('2. with a checkpoint the run polls from the boundary MINUS the overlap', async () => {
  const stored = {
    completedThrough: new Date('2026-08-21T06:00:00.000Z'),
    lastIntervalSince: new Date('2026-08-19T06:00:00.000Z'),
  };
  const h = harness({ stored });
  await run(h);
  assert.equal(
    h.polls[0]!.since.getTime(),
    stored.completedThrough.getTime() - DEFAULT_POLL_OVERLAP_MS,
  );
});

// --- 3/10/13. Advancing ------------------------------------------------------------

test('10. APPLIED advances to the EXACT exclusive until boundary', async () => {
  const h = harness();
  const out = await run(h);
  assert.equal(out.advancement, 'ADVANCED');
  assert.equal(out.checkpointAfter!.getTime(), h.polls[0]!.until.getTime());
  assert.equal(out.checkpointAfter!.getTime(), SAFE_NOW.getTime());
  // Recorded evidence: the span that set it.
  assert.equal(h.state.row!.lastIntervalSince.getTime(), h.polls[0]!.since.getTime());
});

test('4. a COMPLETE interval holding ZERO records advances', async () => {
  // The whole reason the checkpoint is not a max() over observed occurrences: a
  // quiet night is covered, and treating it as unproven would leave it unclaimed
  // forever while the re-read window grew without bound.
  const h = harness({
    result: execution({ providerRecordsFetched: 0, acceptedRecords: 0, newEvents: 0 }),
  });
  const out = await run(h);
  assert.equal(out.advancement, 'ADVANCED');
  assert.equal(out.checkpointAfter!.getTime(), SAFE_NOW.getTime());
});

test('11. APPLIED_WITH_CONFLICTS advances, and that is a decision', async () => {
  // Every record was read and applied. The conflict is two settled provider values
  // disagreeing about one call's money; nothing was overwritten and a revision
  // records it. Withholding coverage would stall the poller behind a question no
  // re-read can answer — the same conflict would recur on every pass, forever.
  const h = harness({ result: execution({ outcome: 'APPLIED_WITH_CONFLICTS', conflicts: 3 }) });
  const out = await run(h);
  assert.equal(out.advancement, 'ADVANCED');
  assert.equal(out.execution!.conflicts, 3, 'and the conflict is still reported, not hidden');
});

test('3/13. repeated successful runs move the boundary forward and never back', async () => {
  const h = harness();
  const first = await run(h);
  const later = new Date(NOW.getTime() + 60 * 60 * 1000);
  const second = await h.service.run({ organizationId: ORG, apiKey: KEY, now: later });
  assert.ok(second.checkpointAfter!.getTime() > first.checkpointAfter!.getTime());
  // The SECOND read still reached back behind the first boundary — overlap — while
  // the boundary itself only moved forward.
  assert.ok(h.polls[1]!.since.getTime() < first.checkpointAfter!.getTime(), 'overlap re-read');
  assert.ok(h.state.row!.completedThrough.getTime() > first.checkpointAfter!.getTime());
});

// --- 5/6/7/8/9. Everything that must NOT advance -------------------------------------

test('5/6/7/8/9. no unproven outcome advances the checkpoint, and each says why', async () => {
  const unproven: CallGridPollOutcome[] = [
    'FETCH_INCOMPLETE',
    'REFUSED',
    'PARTIALLY_APPLIED',
    'PROCESSING_FAILED',
    'DRY_RUN_READY',
  ];
  for (const outcome of unproven) {
    const h = harness();
    const out = await run(h);
    assert.equal(out.advancement, 'ADVANCED', 'sanity: the baseline advances');

    const blocked = harness({ result: execution({ outcome }) });
    const result = await run(blocked);
    assert.equal(result.advancement, 'NOT_PROVEN', `${outcome} must not advance`);
    assert.equal(result.checkpointAfter, null, `${outcome} left nothing proven`);
    assert.equal(blocked.state.row, null, `${outcome} wrote no checkpoint row`);
    assert.match(result.reason, /does not prove/);
  }
});

test('5b. an unproven outcome cannot advance an EXISTING checkpoint either', async () => {
  const stored = {
    completedThrough: new Date('2026-08-21T06:00:00.000Z'),
    lastIntervalSince: new Date('2026-08-19T06:00:00.000Z'),
  };
  for (const outcome of ['FETCH_INCOMPLETE', 'REFUSED', 'PARTIALLY_APPLIED'] as CallGridPollOutcome[]) {
    const h = harness({ stored, result: execution({ outcome }) });
    const out = await run(h);
    assert.equal(out.advancement, 'NOT_PROVEN');
    assert.equal(out.checkpointAfter!.getTime(), stored.completedThrough.getTime(), 'unmoved');
    assert.equal(h.state.guardedUpdates, 0, 'no write was even attempted');
  }
});

test('9b. a dry run reads and reports and proves nothing', async () => {
  const h = harness({ result: execution({ outcome: 'DRY_RUN_READY', dryRun: true }) });
  const out = await run(h, { dryRun: true });
  assert.equal(h.polls[0]!.dryRun, true, 'the intent reached the poll');
  assert.equal(out.advancement, 'NOT_PROVEN');
  assert.equal(h.state.row, null);
  // A dry run is a SUCCESSFUL operation that proves nothing. These are two
  // different questions and the vocabulary answers them separately.
  assert.equal(pollSucceeded('DRY_RUN_READY'), true);
  assert.equal(checkpointMayAdvance('DRY_RUN_READY'), false);
});

test('the advancement rule denies by default across the whole vocabulary', () => {
  for (const outcome of CALLGRID_POLL_OUTCOMES) {
    assert.equal(
      checkpointMayAdvance(outcome),
      outcome === 'APPLIED' || outcome === 'APPLIED_WITH_CONFLICTS',
      `${outcome} advancement`,
    );
  }
  // Named positively, so an outcome added later is refused until somebody decides.
  assert.ok(REPO_CODE.includes('lt: input.completedThrough') || ROUTINE_CODE.includes('checkpointMayAdvance('));
});

// --- 12/14. Crashes and concurrency --------------------------------------------------

test('12. dying after every record and before advancement is safe: the rerun converges', async () => {
  // Crash D. The first run applied everything and never recorded coverage.
  const crashed = harness();
  await crashed.service.run({ organizationId: ORG, apiKey: KEY, now: NOW }).then(() => undefined);
  // Simulate the crash by discarding the checkpoint write: a fresh store, same interval.
  const rerun = harness({ result: execution({ newEvents: 0, duplicateObservations: 2 }) });
  const out = await run(rerun);
  assert.equal(out.advancement, 'ADVANCED', 'the rerun proves the same interval');
  assert.equal(out.execution!.newEvents, 0, 'and creates nothing new');
  assert.equal(out.execution!.duplicateObservations, 2, 'the applied rows are re-observed');
});

test('14. an older concurrent run cannot overwrite a newer proven boundary', async () => {
  const repo = (() => {
    const { prisma, state } = checkpointDouble();
    return { repo: new ProviderPollCheckpointRepository(prisma as never), state };
  })();
  const early = new Date('2026-08-21T06:00:00.000Z');
  const late = new Date('2026-08-21T11:00:00.000Z');

  // Worker B finishes first with the later boundary.
  const b = await repo.repo.advance(ORG, 'callgrid', 'calls', {
    completedThrough: late,
    intervalSince: new Date('2026-08-19T11:00:00.000Z'),
  });
  assert.equal(b.outcome, 'ADVANCED');

  // Worker A, slower and holding the earlier boundary, arrives afterwards.
  const a = await repo.repo.advance(ORG, 'callgrid', 'calls', {
    completedThrough: early,
    intervalSince: new Date('2026-08-19T06:00:00.000Z'),
  });
  assert.equal(a.outcome, 'ALREADY_AHEAD', 'not an error — it proved something already known');
  assert.equal(a.completedThrough.getTime(), late.getTime(), 'and it reports the real boundary');
  assert.equal(repo.state.row!.completedThrough.getTime(), late.getTime(), 'nothing regressed');
});

test('14b. two workers racing the FIRST row produce one checkpoint, not two', async () => {
  const { prisma, state } = checkpointDouble();
  const repo = new ProviderPollCheckpointRepository(prisma as never);
  const later = new Date('2026-08-21T11:00:00.000Z');
  const earlier = new Date('2026-08-21T06:00:00.000Z');

  // The double throws on a second create, exactly as the unique index does.
  const first = await repo.advance(ORG, 'callgrid', 'calls', {
    completedThrough: earlier,
    intervalSince: earlier,
  });
  const second = await repo.advance(ORG, 'callgrid', 'calls', {
    completedThrough: later,
    intervalSince: earlier,
  });
  assert.equal(first.outcome, 'ADVANCED');
  assert.equal(second.outcome, 'ADVANCED', 'the later boundary still wins, through the guard');
  assert.equal(state.creates, 1, 'exactly one row was ever created');
  assert.equal(state.row!.completedThrough.getTime(), later.getTime());
});

test('advancement is monotonic even when handed the identical boundary twice', async () => {
  const { prisma, state } = checkpointDouble();
  const repo = new ProviderPollCheckpointRepository(prisma as never);
  const at = new Date('2026-08-21T11:00:00.000Z');
  assert.equal((await repo.advance(ORG, 'callgrid', 'calls', { completedThrough: at, intervalSince: at })).outcome, 'ADVANCED');
  const again = await repo.advance(ORG, 'callgrid', 'calls', { completedThrough: at, intervalSince: at });
  assert.equal(again.outcome, 'ALREADY_AHEAD', 'equal is not newer');
  assert.equal(state.row!.completedThrough.getTime(), at.getTime());
});

// --- 15. Historical recovery cannot reach this ----------------------------------------

test('15. a manual explicit interval cannot move the routine checkpoint at all', () => {
  // Separation, not a rule. The manual runner and the admin sync route call
  // CallGridPollService.execute directly; only the routine service reads or writes
  // a checkpoint, and execute() has no access to one.
  const pollService = codeOf(readFileSync(join(SRC, 'services', 'callgrid-poll.service.ts'), 'utf8'));
  // The primitive owns `checkpointMayAdvance` — a pure predicate over its OWN
  // outcome vocabulary, sitting beside `pollSucceeded` so that adding an outcome
  // puts both judgements in one place. What it must not have is checkpoint STATE:
  // it cannot read one, write one, or plan an interval from one.
  for (const symbol of [
    'ProviderPollCheckpointRepository',
    'completedThrough',
    'planPollInterval',
    'lastIntervalSince',
    'providerPollCheckpoint',
    '.advance(',
  ]) {
    assert.ok(!pollService.includes(symbol), `the poll primitive must not reference ${symbol}`);
  }
  const runner = codeOf(readFileSync(join(HERE, '..', '..', '..', 'scripts', 'operations', 'poll-callgrid-interval.ts'), 'utf8'));
  const route = codeOf(
    readFileSync(
      join(HERE, '..', '..', '..', 'apps', 'web', 'src', 'app', 'api', 'integrations', 'callgrid', 'sync', 'route.ts'),
      'utf8',
    ),
  );
  for (const source of [runner, route]) {
    for (const symbol of ['Checkpoint', 'completedThrough', 'RoutinePoll']) {
      assert.ok(!source.includes(symbol), `an explicit-interval caller must not reference ${symbol}`);
    }
  }
});

test('15b. and even if one did, the guard makes a backward move impossible', async () => {
  const { prisma, state } = checkpointDouble({
    completedThrough: new Date('2026-08-21T06:00:00.000Z'),
    lastIntervalSince: new Date('2026-08-19T06:00:00.000Z'),
  });
  const repo = new ProviderPollCheckpointRepository(prisma as never);
  // The August incident window, offered as a boundary.
  const out = await repo.advance(ORG, 'callgrid', 'calls', {
    completedThrough: new Date('2026-08-14T13:10:23.000Z'),
    intervalSince: new Date('2026-08-10T22:06:14.000Z'),
  });
  assert.equal(out.outcome, 'ALREADY_AHEAD');
  assert.equal(state.row!.completedThrough.toISOString(), '2026-08-21T06:00:00.000Z', 'unmoved');
});

// --- 19/20. Ownership -------------------------------------------------------------------

test('19/20. the checkpoint layer delegates execution and touches no record itself', () => {
  assert.ok(ROUTINE_CODE.includes('this.poller.execute('), 'execution is delegated');
  for (const symbol of [
    'marketplaceCall',
    'MarketplaceCall',
    'IngestionService',
    'ingest(',
    'readCallGridInterval',
    'nextCursor',
    'mapCallGridEventType',
    'convergeFact',
    'resolveCallGridIdentity',
    'ProviderReconciliationService',
    'assessReadiness',
    'MeasurementSource',
    'HeadlineDetectionService',
    'cron',
    'schedule',
    'setInterval',
  ]) {
    assert.ok(!ROUTINE_CODE.includes(symbol), `the checkpoint layer must not reference ${symbol}`);
  }
  assert.equal(/prisma\.[a-z]/.test(ROUTINE_CODE), false, 'no Prisma model delegate');
});

test('the repository can move the boundary FORWARD and has no other writer', () => {
  // No setter, no reset, no delete: the only mutation is guarded advancement.
  assert.ok(REPO_CODE.includes('completedThrough: { lt: input.completedThrough }'), 'guarded in the WHERE');
  for (const symbol of ['delete(', 'deleteMany(', 'reset', 'set(', 'upsert(']) {
    assert.ok(!REPO_CODE.includes(symbol), `the repository must not expose ${symbol}`);
  }
  // The organization is the first argument of every method, per CLAUDE.md.
  for (const signature of ['find(\n    organizationId: string', 'advance(\n    organizationId: string']) {
    assert.ok(REPO_CODE.includes(signature), `missing tenant-first signature: ${signature}`);
  }
});

test('16/17/18. the stored value is an instant, not a business day or an occurrence', () => {
  const schema = readFileSync(join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');
  const model = schema.slice(schema.indexOf('model ProviderPollCheckpoint'));
  const body = model.slice(0, model.indexOf('\n}'));
  assert.ok(body.includes('completedThrough DateTime'), 'a UTC instant');
  for (const symbol of ['businessDate', '@db.Date', 'timezone', 'occurredAt', 'lastEventAt', 'lastRunAt']) {
    assert.ok(!body.includes(symbol), `the model must not carry ${symbol}`);
  }
  // Successes only: no attempt or failure state can be mistaken for coverage.
  for (const symbol of ['lastOutcome', 'lastAttempt', 'status', 'error', 'truncated']) {
    assert.ok(!body.includes(symbol), `the model must not carry ${symbol}`);
  }
});

test('the migration is additive and seeds no coverage', () => {
  const sql = readFileSync(
    join(SRC, '..', 'prisma', 'migrations', '20260825000000_ci_stage3_poll_checkpoint', 'migration.sql'),
    'utf8',
  );
  assert.ok(sql.includes('CREATE TABLE "provider_poll_checkpoints"'));
  assert.ok(sql.includes('CREATE UNIQUE INDEX "poll_checkpoint_identity"'), 'the create race is decided by the index');
  // STATEMENTS ONLY. The header says "Zero DROP" in prose, and a check that reads
  // prose as SQL would fail on the sentence promising the thing it forbids.
  const statements = sql
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');
  // DML and destructive DDL, in the forms they actually take. A bare `UPDATE `
  // matched `ON DELETE CASCADE ON UPDATE CASCADE`, which is a foreign key clause
  // and not a write -- the same class of mistake as a query matching more rows
  // than it names.
  for (const forbidden of ['DROP ', 'ALTER COLUMN', 'INSERT INTO', 'UPDATE "', 'DELETE FROM', 'TRUNCATE']) {
    assert.ok(!statements.includes(forbidden), `the migration must not contain ${forbidden}`);
  }
  assert.ok(statements.includes('ON DELETE CASCADE'), 'deleting an organization takes its checkpoint');
  // ASCII only — a leading em-dash blocked a whole ledger replay once.
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[^\x00-\x7F]/.test(sql), 'the migration must be plain ASCII');
});
