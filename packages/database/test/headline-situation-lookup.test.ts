// Where the investigations behind many Headlines stand -- one query, one org.
//
// WHAT THESE PROVE
//
// THE BATCH READ IS ONE QUERY. A list of two hundred Headlines must not ask the
// Decision Center two hundred questions. The Prisma double is instrumented and
// the count is asserted, not assumed.
//
// ONE ROW PER HEADLINE, NOTHING FOR THE REST. A Headline that never opened an
// investigation is absent, not null; an id nobody has is absent; a thread from
// another producer whose key happens to look like ours is absent.
//
// ORGANIZATION-SCOPED. The same Headline id in two organizations resolves to
// each organization's own thread and never to the other's.
//
// THE CASE'S OWN COLUMNS, CARRIED. Lane, outcome and close time are what the
// engine projected from its log after a real resolve and a real ignore, read
// through the real repository -- nothing here re-derives them.
//
// THE READ WRITES NOTHING, and `findCaseForHeadline` is unchanged beside it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INVESTIGATION_PRODUCER, investigationRecurrenceKey } from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import { OperationalPriorityRepository } from '../src/repositories/operational-priority.repository';
import { HeadlineInvestigationService } from '../src/services/headline-investigation.service';

const ORG = 'org_alpha';
const OTHER = 'org_beta';
const NOW = new Date('2026-09-08T12:00:00.000Z');
const human = { type: 'HUMAN' as const, userId: 'usr_charlie', source: 'operator' };

async function world() {
  const prisma = makeCognitivePrisma();
  const engine = new DecisionEngine(prisma as never);

  const open = async (organizationId: string, headlineId: string) =>
    (
      await engine.create(organizationId, {
        producer: INVESTIGATION_PRODUCER,
        recurrenceKey: investigationRecurrenceKey(headlineId),
        detectionKey: 'promotion:' + headlineId,
        detectedAt: NOW,
        title: 'Headline ' + headlineId,
        severity: 'NOTABLE',
        sourceReference: headlineId,
      })
    ).decision.id;

  // Three investigations in ORG, in three lanes -- moved by the engine itself.
  const a = await open(ORG, 'hl_a');
  const b = await open(ORG, 'hl_b');
  await engine.resolve(ORG, b, { actor: human, outcome: 'RECOVERED', reason: 'We acted and it came back.' });
  const c = await open(ORG, 'hl_c');
  await engine.ignore(ORG, c, { actor: human, outcome: 'NO_ACTION_NEEDED', reason: 'Fine as it stands.' });

  // The OTHER organization holds hl_x and ITS OWN thread for hl_a.
  const x = await open(OTHER, 'hl_x');
  const aInOther = await open(OTHER, 'hl_a');

  // A thread from a different producer whose key merely looks like ours.
  await engine.create(ORG, {
    producer: 'CALLGRID',
    recurrenceKey: investigationRecurrenceKey('hl_d'),
    detectionKey: 'yesterday:2026-09-07',
    detectedAt: NOW,
    title: 'A CallGrid thread with a Headline-shaped key',
    severity: 'HIGH',
  });

  // INSTRUMENTED: every findMany on the priorities table is counted.
  const delegate = prisma.operationalPriority;
  const original = delegate.findMany.bind(delegate);
  const queries: unknown[] = [];
  delegate.findMany = async (args: unknown) => {
    queries.push(args);
    return original(args as never);
  };

  const repo = new OperationalPriorityRepository(prisma as never);
  const svc = new HeadlineInvestigationService(prisma as never);
  return { prisma, engine, repo, svc, queries, ids: { a, b, c, x, aInOther } };
}

// --- 1. One row per headline, one query ----------------------------------------------------

test('1. one row per headline, carrying the lane, outcome and close time the engine projected', async () => {
  const { svc, ids, queries } = await world();
  const map = await svc.findCasesForHeadlines(ORG, ['hl_a', 'hl_b', 'hl_c', 'hl_d', 'hl_x', 'hl_nope']);

  assert.deepEqual([...map.keys()].sort(), ['hl_a', 'hl_b', 'hl_c']);
  assert.equal(queries.length, 1, 'ONE query for six headlines');

  const a = map.get('hl_a')!;
  assert.equal(a.caseId, ids.a);
  assert.equal(a.state, 'NEEDS_REVIEW');
  assert.equal(a.outcome, null);
  assert.equal(a.resolvedAt, null, 'open: no close time');
  assert.match(String(a.updatedAt), /^\d{4}-\d{2}-\d{2}T/, 'ISO, like every other view');

  const b = map.get('hl_b')!;
  assert.equal(b.caseId, ids.b);
  assert.equal(b.state, 'RESOLVED');
  assert.equal(b.outcome, 'RECOVERED');
  assert.match(String(b.resolvedAt), /^\d{4}-\d{2}-\d{2}T/, 'closed: the close time, as ISO');

  const c = map.get('hl_c')!;
  assert.equal(c.state, 'DISMISSED');
  assert.equal(c.outcome, 'NO_ACTION_NEEDED');
  assert.ok(c.resolvedAt, 'closed without acting still records when');
});

test('1b. a headline that never opened an investigation is ABSENT, not null', async () => {
  const { svc } = await world();
  const map = await svc.findCasesForHeadlines(ORG, ['hl_nope']);
  assert.equal(map.size, 0);
  assert.equal(map.has('hl_nope'), false);
});

test('1c. another producer\'s thread with a Headline-shaped key is not a Headline\'s case', async () => {
  // Identity is (organization, producer, key). A CallGrid thread keyed
  // `headline:hl_d` is CallGrid's business, and attributing it to a Headline
  // would put a CallGrid decline under a Commercial Intelligence development.
  const { svc } = await world();
  const map = await svc.findCasesForHeadlines(ORG, ['hl_d']);
  assert.equal(map.size, 0);
});

test('1d. empty, blank and duplicate ids: no query for nothing, one row for a repeated id', async () => {
  const { svc, queries } = await world();
  assert.equal((await svc.findCasesForHeadlines(ORG, [])).size, 0);
  assert.equal((await svc.findCasesForHeadlines(ORG, ['', '   '])).size, 0);
  assert.equal(queries.length, 0, 'nothing to ask, nothing asked');

  const map = await svc.findCasesForHeadlines(ORG, ['hl_a', ' hl_a ', 'hl_a', '']);
  assert.equal(map.size, 1);
  assert.equal(queries.length, 1, 'one query, deduplicated');
});

// --- 2. Tenancy ---------------------------------------------------------------------------------

test('2. THE SAME HEADLINE ID IN TWO ORGANIZATIONS RESOLVES TO EACH ONE\'S OWN THREAD', async () => {
  const { svc, ids } = await world();
  const mine = await svc.findCasesForHeadlines(ORG, ['hl_a', 'hl_x']);
  const theirs = await svc.findCasesForHeadlines(OTHER, ['hl_a', 'hl_x', 'hl_b', 'hl_c']);

  assert.deepEqual([...mine.keys()], ['hl_a']);
  assert.equal(mine.get('hl_a')!.caseId, ids.a);
  assert.equal(mine.has('hl_x'), false, 'another organization\'s thread never appears');

  assert.deepEqual([...theirs.keys()].sort(), ['hl_a', 'hl_x']);
  assert.equal(theirs.get('hl_a')!.caseId, ids.aInOther, 'the OTHER org\'s own hl_a thread');
  assert.notEqual(theirs.get('hl_a')!.caseId, ids.a);
  assert.equal(theirs.get('hl_x')!.caseId, ids.x);
  assert.equal(theirs.has('hl_b'), false, 'and not-found, never forbidden');
});

test('2b. the repository read is organization-scoped and selects only the lifecycle columns', async () => {
  const { repo, ids } = await world();
  const rows = await repo.findLifecycleByRecurrenceKeys(ORG, INVESTIGATION_PRODUCER, [
    investigationRecurrenceKey('hl_b'),
    investigationRecurrenceKey('hl_x'),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, ids.b);
  // EXPLICIT SELECT. A title, a summary or a severity here would be a column
  // the list never needed and a 500 waiting for a schema drift.
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['id', 'outcome', 'recurrenceKey', 'resolvedAt', 'state', 'updatedAt']);
  assert.deepEqual(await repo.findLifecycleByRecurrenceKeys(ORG, INVESTIGATION_PRODUCER, []), []);
});

// --- 3. Reads are reads ---------------------------------------------------------------------

test('3. the batch read writes nothing', async () => {
  const { prisma, svc } = await world();
  const before = {
    priorities: await prisma.operationalPriority.count(),
    observations: await prisma.operationalObservation.count(),
  };
  await svc.findCasesForHeadlines(ORG, ['hl_a', 'hl_b', 'hl_c', 'hl_new']);
  await svc.findCasesForHeadlines(OTHER, ['hl_a']);
  assert.deepEqual(
    {
      priorities: await prisma.operationalPriority.count(),
      observations: await prisma.operationalObservation.count(),
    },
    before,
  );
});

test('3b. findCaseForHeadline is unchanged beside it: one thread, and whether a person authorized it', async () => {
  const { svc, ids } = await world();
  const one = await svc.findCaseForHeadline(ORG, 'hl_a');
  assert.deepEqual(one, { caseId: ids.a, humanAuthorizationRecorded: false });
  assert.equal(await svc.findCaseForHeadline(OTHER, 'hl_b'), null);
  // The two lineage reads agree about which thread a Headline opened.
  const many = await svc.findCasesForHeadlines(ORG, ['hl_a']);
  assert.equal(many.get('hl_a')!.caseId, one!.caseId);
});
