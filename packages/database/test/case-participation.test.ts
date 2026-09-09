// Multiple people on one investigation — without a second task system.
//
// WHAT THESE PROVE
//
// TWO COLUMNS GENUINELY CANNOT DO THIS. The suite runs the real product shape:
// Charlie decides, Matt investigates, Mike handles the buyer. All three are on
// the Case at once, each with a distinct ask, and owner and assignee are exactly
// what they were before any of them arrived.
//
// PARTICIPATION IS NOT WORK, AND THE ABSENCES ARE ASSERTED. The participant row
// carries no due date, status, dependency, SLA or completion — checked against
// the shared list of Work-owned fields, against the stored row and against the
// migration, so adding one fails a test rather than a review.
//
// WORK IS REFERENCED, NEVER COPIED. Where a Case became work, the view carries
// the pointer the Decision Center already writes on a CONVERTED_TO_WORK outcome
// and nothing about the work's mutable state.
//
// LOOP SUGGESTS; PEOPLE INVITE. The one deterministic responsibility fact in this
// schema is a USER-scoped objective. A suggestion states its basis and proposes
// the weakest contribution that fits, and calling `suggest` writes nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CASE_CONTRIBUTIONS,
  CASE_CONTRIBUTION_DESCRIPTIONS,
  CASE_CONTRIBUTION_LABELS,
  CASE_PARTICIPATION_DEFERRED,
  CASE_WORK_OWNERSHIP,
  INVESTIGATION_PRODUCER,
  PARTICIPANT_ADDED_REASON,
  PARTICIPANT_RELEASED_REASON,
  SUGGESTION_BASIS,
  WORK_OWNED_FIELDS,
  investigationRecurrenceKey,
  isParticipationEvent,
  suggestParticipants,
  type HeadlineView,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import { CaseParticipantRepository } from '../src/repositories/case-participant.repository';
import { CaseParticipationService } from '../src/services/case-participation.service';

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';
const HEADLINE_ID = 'hl_cem';
const OBJECTIVE_ID = 'obj_medicare';
const NOW = new Date('2026-08-23T14:30:00.000Z');

const CHARLIE = 'usr_charlie';
const MATT = 'usr_matt';
const MIKE = 'usr_mike';
const STRANGER = 'usr_beta';

const asHuman = (userId: string) => ({ type: 'HUMAN' as const, userId, source: 'operator' });

function headline(): HeadlineView {
  return {
    id: HEADLINE_ID,
    performanceObjectiveId: OBJECTIVE_ID,
    objectiveTitle: 'Grow Medicare answer rate',
    measureBindingId: 'bind_1',
    measureBindingVersion: 3,
    measurement: {
      metric: 'MONETIZED_RATE', metricLabel: 'Monetized rate', unit: 'RATIO',
      movement: 'DECREASE', againstObjective: true, currentValue: 0.412, priorValue: 0.597,
      absoluteChange: -0.185, percentageChange: -0.31, currentDenominator: 3184,
      priorDenominator: 2996, currentCoverage: 0.98, priorCoverage: 0.99,
      comparisonBasis: 'Trailing 7 complete Eastern business days.',
      currentWindowStart: '2026-08-15T04:00:00.000Z', currentWindowEnd: '2026-08-22T04:00:00.000Z',
      priorWindowStart: '2026-08-08T04:00:00.000Z', priorWindowEnd: '2026-08-15T04:00:00.000Z',
    },
    statement: "Buyer CEM's monetized rate fell from 59.7% to 41.2%.",
    limitations: [], unknowns: [],
    ruleId: 'ci.objective-measure-change', ruleVersion: 'v1', producerVersion: 'ci-headline.v1',
    ruleDescription: 'A move of at least 15% over at least 200 calls.',
    firstDetectedAt: '2026-08-20T11:02:00.000Z', lastDetectedAt: '2026-08-22T06:15:00.000Z',
    detectionCount: 3, dismissedAt: null, dismissedByUserId: null, dismissedByName: null,
    dismissalBasis: null, createdAt: '2026-08-20T11:02:00.000Z',
  };
}

async function world(
  options: { objectiveScope?: 'USER' | 'ORGANIZATION'; objectiveOwner?: string | null } = {},
) {
  const prisma = makeCognitivePrisma();
  const engine = new DecisionEngine(prisma as never);
  const participantRepo = new CaseParticipantRepository(prisma as never);

  for (const [id, org] of [
    [CHARLIE, ORG], [MATT, ORG], [MIKE, ORG], [STRANGER, OTHER_ORG],
  ] as const) {
    await prisma.user.create({
      data: { id, organizationId: org, email: `${id}@test`, name: id, status: 'ACTIVE', metadata: {} },
    });
  }

  const objectives = {
    async get(organizationId: string, id: string) {
      if (organizationId !== ORG || id !== OBJECTIVE_ID) return null;
      return {
        id: OBJECTIVE_ID,
        scope: options.objectiveScope ?? 'ORGANIZATION',
        scopeUserId: options.objectiveOwner ?? null,
      } as never;
    },
  };

  const participation = new CaseParticipationService(prisma as never, {
    cases: engine,
    participants: participantRepo,
    headlines: {
      async get(org: string, id: string) {
        return org === ORG && id === HEADLINE_ID ? headline() : null;
      },
    },
    objectives: objectives as never,
  });

  const { decision } = await engine.create(ORG, {
    producer: INVESTIGATION_PRODUCER,
    recurrenceKey: investigationRecurrenceKey(HEADLINE_ID),
    detectionKey: `promotion:${HEADLINE_ID}`,
    detectedAt: NOW,
    title: "Buyer CEM's monetized rate fell from 59.7% to 41.2%.",
    severity: 'NOTABLE',
    sourceReference: HEADLINE_ID,
  });

  return { prisma, engine, participation, participantRepo, caseId: decision.id };
}

const ask = (userId: string, contribution: any, request: string) => ({
  userId,
  contribution,
  request,
  actor: asHuman(CHARLIE),
});

// --- The product shape ---------------------------------------------------------------

test('three people, three different asks, on one investigation', async () => {
  const { participation, caseId } = await world();

  assert.equal(
    (await participation.add(ORG, caseId, ask(CHARLIE, 'DECIDE', 'Whether we move volume off CEM this week.'))).outcome,
    'ADDED',
  );
  assert.equal(
    (await participation.add(ORG, caseId, ask(MATT, 'INVESTIGATE', 'Whether the disposition feed is complete.'))).outcome,
    'ADDED',
  );
  assert.equal(
    (await participation.add(ORG, caseId, ask(MIKE, 'RELATIONSHIP', 'What CEM says about the settlement change.'))).outcome,
    'ADDED',
  );

  const view = await participation.get(ORG, caseId);
  assert.equal(view?.participants.length, 3);
  assert.deepEqual(view?.participants.map((p) => p.userId), [CHARLIE, MATT, MIKE]);
  assert.deepEqual(view?.participants.map((p) => p.contribution), [
    'DECIDE', 'INVESTIGATE', 'RELATIONSHIP',
  ]);
  // EVERY PARTICIPANT CARRIES A STATED REASON, so the next person to open the
  // case does not have to guess what was wanted from anybody.
  assert.ok(view?.participants.every((p) => p.request.length > 10));
});

test('owner and assignee are untouched by participation', async () => {
  const { participation, engine, caseId } = await world();
  await engine.setOwner(ORG, caseId, { ownerUserId: CHARLIE, actor: asHuman(CHARLIE) });
  await engine.assign(ORG, caseId, { assigneeUserId: MATT, actor: asHuman(CHARLIE) });
  const before = await engine.get(ORG, caseId);

  await participation.add(ORG, caseId, ask(MIKE, 'RELATIONSHIP', 'Speak to CEM.'));
  await participation.add(ORG, caseId, ask(CHARLIE, 'DECIDE', 'Whether to move volume.'));
  await participation.release(ORG, caseId, MIKE, 'RELATIONSHIP', asHuman(CHARLIE));

  const after = await engine.get(ORG, caseId);
  assert.equal(after?.ownerUserId, before?.ownerUserId);
  assert.equal(after?.assigneeUserId, before?.assigneeUserId);

  const view = await participation.get(ORG, caseId);
  assert.equal(view?.ownerUserId, CHARLIE);
  assert.equal(view?.assigneeUserId, MATT);
});

test('one person may hold two genuinely different roles', async () => {
  const { participation, caseId } = await world();
  await participation.add(ORG, caseId, ask(MATT, 'INVESTIGATE', 'Check the feed.'));
  await participation.add(ORG, caseId, ask(MATT, 'DECIDE', 'Whether the feed fix ships today.'));

  const view = await participation.get(ORG, caseId);
  assert.equal(view?.participants.length, 2);
  assert.deepEqual(view?.participants.map((p) => p.contribution), ['INVESTIGATE', 'DECIDE']);
});

test('"who is this waiting on" is derived from what was asked, not from a status', async () => {
  const { participation, caseId } = await world();
  await participation.add(ORG, caseId, ask(CHARLIE, 'DECIDE', 'Whether to move volume.'));
  await participation.add(ORG, caseId, ask(MATT, 'INVESTIGATE', 'Check the feed.'));
  await participation.add(ORG, caseId, ask(MIKE, 'INFORMED', 'Kept in the loop.'));

  const view = await participation.get(ORG, caseId);
  assert.deepEqual(view?.awaiting.map((p) => p.userId), [CHARLIE]);
  // NOBODY SET A FLAG. It is a property of having asked for a decision, so it
  // cannot be left stale by anyone forgetting to update it.
  assert.equal(view?.participants.find((p) => p.userId === MATT)?.awaited, false);
});

// --- History -----------------------------------------------------------------------------

test('releasing keeps the row, and the case remembers who was asked for what', async () => {
  const { participation, caseId, prisma } = await world();
  await participation.add(ORG, caseId, ask(MIKE, 'RELATIONSHIP', 'Speak to CEM about settlement.'));
  const released = await participation.release(ORG, caseId, MIKE, 'RELATIONSHIP', asHuman(CHARLIE));
  assert.equal(released.outcome, 'RELEASED');

  const view = await participation.get(ORG, caseId);
  assert.equal(view?.participants.length, 0);
  assert.equal(view?.released.length, 1);
  assert.equal(view?.released[0]?.userId, MIKE);
  assert.equal(view?.released[0]?.request, 'Speak to CEM about settlement.');
  assert.equal(view?.released[0]?.releasedByUserId, CHARLIE);
  assert.equal(view?.released[0]?.active, false);

  const log = await prisma.operationalObservation.findMany({ where: { priorityId: caseId } });
  assert.equal(log.filter((o: any) => isParticipationEvent(o, 'ADDED')).length, 1);
  assert.equal(log.filter((o: any) => isParticipationEvent(o, 'RELEASED')).length, 1);
});

test('re-asking the same person converges on one row and reports it as a change', async () => {
  const { participation, caseId, prisma } = await world();
  const first = await participation.add(ORG, caseId, ask(MATT, 'INVESTIGATE', 'Check the feed.'));
  const again = await participation.add(ORG, caseId, ask(MATT, 'INVESTIGATE', 'Check the feed AND the postbacks.'));

  assert.equal(first.outcome, 'ADDED');
  assert.equal(again.outcome, 'CHANGED');
  assert.equal(again.participantId, first.participantId);

  const rows = await prisma.caseParticipant.findMany({ where: { priorityId: caseId } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].request, 'Check the feed AND the postbacks.');

  const log = await prisma.operationalObservation.findMany({ where: { priorityId: caseId } });
  assert.equal(log.filter((o: any) => isParticipationEvent(o, 'CHANGED')).length, 1);
});

test('bringing somebody back reactivates them, and the log keeps both acts', async () => {
  const { participation, caseId, prisma } = await world();
  await participation.add(ORG, caseId, ask(MIKE, 'RELATIONSHIP', 'Speak to CEM.'));
  await participation.release(ORG, caseId, MIKE, 'RELATIONSHIP', asHuman(CHARLIE));
  await participation.add(ORG, caseId, ask(MIKE, 'RELATIONSHIP', 'CEM called back — take it.'));

  const view = await participation.get(ORG, caseId);
  assert.equal(view?.participants.length, 1);
  assert.equal(view?.released.length, 0);

  // THE LOG READS: ASKED, RELEASED, ASKED AGAIN. Bringing somebody back is an
  // invitation, not a revision of one they were never holding — a timeline that
  // called it a change would read as though they had been on the case throughout.
  const log = await prisma.operationalObservation.findMany({ where: { priorityId: caseId } });
  assert.equal(log.filter((o: any) => isParticipationEvent(o, 'ADDED')).length, 2);
  assert.equal(log.filter((o: any) => isParticipationEvent(o, 'RELEASED')).length, 1);
  assert.equal(log.filter((o: any) => isParticipationEvent(o, 'CHANGED')).length, 0);
});

test('a participant must carry a stated reason', async () => {
  const { participation, caseId } = await world();
  await assert.rejects(
    () => participation.add(ORG, caseId, ask(MATT, 'INVESTIGATE', '   ')),
    /stated reason/,
  );
});

test('an unrecognised contribution is refused', async () => {
  const { participation, caseId } = await world();
  await assert.rejects(
    () => participation.add(ORG, caseId, ask(MATT, 'DO_THE_THING', 'Anything.')),
    /Unknown contribution/,
  );
});

// --- Tenancy -----------------------------------------------------------------------------

test('a case in another organization is not-found, and nothing is written', async () => {
  const { participation, caseId, prisma } = await world();
  const result = await participation.add(OTHER_ORG, caseId, ask(MATT, 'INVESTIGATE', 'Check the feed.'));
  assert.equal(result.outcome, 'CASE_NOT_FOUND');
  assert.equal((await prisma.caseParticipant.findMany({})).length, 0);
  assert.equal(await participation.get(OTHER_ORG, caseId), null);
});

test('a person from another organization cannot be added, and no log entry is written', async () => {
  const { participation, caseId, prisma } = await world();
  const result = await participation.add(ORG, caseId, ask(STRANGER, 'DOMAIN_INPUT', 'They know the buyer.'));
  assert.equal(result.outcome, 'PARTICIPANT_NOT_FOUND');
  assert.equal((await prisma.caseParticipant.findMany({})).length, 0);

  // NO AUDIT ENTRY FOR A WRITE THAT DID NOT HAPPEN.
  const log = await prisma.operationalObservation.findMany({ where: { priorityId: caseId } });
  assert.equal(log.filter((o: any) => isParticipationEvent(o, 'ADDED')).length, 0);
});

test('a participant cannot be released across a tenant boundary', async () => {
  const { participation, caseId, prisma } = await world();
  await participation.add(ORG, caseId, ask(MATT, 'INVESTIGATE', 'Check the feed.'));
  const result = await participation.release(OTHER_ORG, caseId, MATT, 'INVESTIGATE', asHuman(STRANGER));
  assert.equal(result.outcome, 'CASE_NOT_FOUND');
  const rows = await prisma.caseParticipant.findMany({});
  assert.equal(rows[0].releasedAt, null);
});

test('one person’s involvements are readable only within their own organization', async () => {
  const { participantRepo, caseId } = await world();
  await participantRepo.add(ORG, caseId, { userId: MATT, contribution: 'INVESTIGATE', request: 'Check.' });
  assert.equal((await participantRepo.listForUser(ORG, MATT)).length, 1);
  assert.equal((await participantRepo.listForUser(OTHER_ORG, MATT)).length, 0);
});

// --- The Work boundary --------------------------------------------------------------------

test('the participant row carries nothing Work OS owns', async () => {
  const { participation, caseId, prisma } = await world();
  await participation.add(ORG, caseId, ask(MATT, 'INVESTIGATE', 'Check the feed.'));
  const row = (await prisma.caseParticipant.findMany({}))[0];

  for (const field of WORK_OWNED_FIELDS) {
    assert.equal(field in row, false, `a participant must not carry ${field}`);
  }
  // AND NO STATUS OF ANY KIND. Presence and release, following work_assignments'
  // own convention, so nothing can disagree with a timestamp.
  assert.equal('status' in row, false);
  assert.equal('state' in row, false);
});

test('work is referenced through the columns the Decision Center already writes', async () => {
  const { participation, engine, caseId } = await world();
  await participation.add(ORG, caseId, ask(MATT, 'INVESTIGATE', 'Check the feed.'));

  await engine.resolve(ORG, caseId, {
    actor: asHuman(CHARLIE),
    outcome: 'CONVERTED_TO_WORK',
    destination: { system: 'work-os', type: 'work_instance', id: 'wi_42' },
  });

  const view = await participation.get(ORG, caseId);
  assert.equal(view?.work.length, 1);
  assert.equal(view?.work[0]?.system, 'work-os');
  assert.equal(view?.work[0]?.id, 'wi_42');
  assert.ok(view?.work[0]?.observationId);

  // A POINTER, NOT A COPY. Nothing about the work's mutable state is carried, so
  // there is no second answer to "is it done" that can go stale.
  const serialized = JSON.stringify(view?.work);
  for (const owned of ['status', 'dueDate', 'completedAt', 'assignee', 'title']) {
    assert.equal(serialized.includes(owned), false, `the reference must not carry ${owned}`);
  }
});

test('nothing executable is created by any participation act', async () => {
  const { participation, caseId, prisma } = await world();
  await participation.add(ORG, caseId, ask(CHARLIE, 'DECIDE', 'Whether to move volume.'));
  await participation.add(ORG, caseId, ask(MATT, 'INVESTIGATE', 'Check the feed.'));
  await participation.release(ORG, caseId, MATT, 'INVESTIGATE', asHuman(CHARLIE));

  // WORK OS IS NOW MODELLED ON THIS DOUBLE, so "the table does not exist" is no
  // longer available as a proxy -- and what replaces it is stronger. The tables
  // are present and reachable, and Commercial Intelligence still writes nothing
  // into any of them. Absence of a capability proved nothing about restraint;
  // this proves restraint.
  for (const table of ['workInstance', 'workStage', 'workStageEvent', 'workDependency']) {
    assert.equal((await (prisma as never as Record<string, { findMany(a: object): Promise<unknown[]> }>)[table]!.findMany({})).length, 0, `participation must not create ${table}`);
  }
  // These three are still not modelled at all, so reaching them would throw.
  for (const table of ['workAssignment', 'blueprint', 'workNotification']) {
    assert.equal(table in prisma, false, `participation must not reach ${table}`);
  }
});

test('the ownership declaration says exactly who owns each noun', () => {
  assert.equal(CASE_WORK_OWNERSHIP.case, 'COMMERCIAL_INTELLIGENCE');
  assert.equal(CASE_WORK_OWNERSHIP.finding, 'COMMERCIAL_INTELLIGENCE');
  assert.equal(CASE_WORK_OWNERSHIP.recommendation, 'COMMERCIAL_INTELLIGENCE');
  assert.equal(CASE_WORK_OWNERSHIP.caseParticipation, 'COMMERCIAL_INTELLIGENCE');
  assert.equal(CASE_WORK_OWNERSHIP.executionObligation, 'WORK_OS');
  assert.equal(CASE_WORK_OWNERSHIP.taskStatus, 'WORK_OS');
  assert.equal(CASE_WORK_OWNERSHIP.dueDate, 'WORK_OS');
  assert.equal(CASE_WORK_OWNERSHIP.completion, 'WORK_OS');
  // HONEST ABOUT THE GAP: nothing in this repository owns dependency semantics
  // today, and claiming Work OS did would be citing a capability that does not
  // exist.
  assert.equal(CASE_WORK_OWNERSHIP.dependency, 'UNOWNED');
  assert.deepEqual(CaseParticipationService.ownership(), CASE_WORK_OWNERSHIP);
});

// --- Routing: a suggestion, never an assignment ------------------------------------------------

test('a user-scoped objective makes its owner a suggested participant, with a stated basis', async () => {
  const { participation, caseId, prisma } = await world({
    objectiveScope: 'USER',
    objectiveOwner: MIKE,
  });

  const suggestions = await participation.suggest(ORG, caseId);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.userId, MIKE);
  assert.equal(suggestions[0]?.basis, SUGGESTION_BASIS);
  assert.equal(suggestions[0]?.performanceObjectiveId, OBJECTIVE_ID);
  // THE WEAKEST CONTRIBUTION THAT FITS. Owning the objective makes somebody
  // relevant; it does not make them the decider.
  assert.equal(suggestions[0]?.contribution, 'DOMAIN_INPUT');

  // SUGGESTING WRITES NOTHING.
  assert.equal((await prisma.caseParticipant.findMany({})).length, 0);
  const log = await prisma.operationalObservation.findMany({ where: { priorityId: caseId } });
  assert.equal(log.filter((o: any) => isParticipationEvent(o, 'ADDED')).length, 0);
});

test('an organization-scoped objective suggests nobody rather than guessing', async () => {
  const { participation, caseId } = await world({ objectiveScope: 'ORGANIZATION' });
  assert.deepEqual(await participation.suggest(ORG, caseId), []);
});

test('somebody already involved is never suggested again', async () => {
  const { participation, caseId } = await world({ objectiveScope: 'USER', objectiveOwner: MIKE });
  await participation.add(ORG, caseId, ask(MIKE, 'RELATIONSHIP', 'Speak to CEM.'));
  assert.deepEqual(await participation.suggest(ORG, caseId), []);
});

test('the pure suggestion rule refuses everything it cannot support', () => {
  assert.deepEqual(suggestParticipants({ objective: null, existingUserIds: [] }), []);
  assert.deepEqual(
    suggestParticipants({
      objective: { id: 'o', scope: 'USER', scopeUserId: null },
      existingUserIds: [],
    }),
    [],
    'a USER-scoped objective with no owner names nobody',
  );
});

test('a case not opened from a headline suggests nobody', async () => {
  const prisma = makeCognitivePrisma();
  const engine = new DecisionEngine(prisma as never);
  const participation = new CaseParticipationService(prisma as never, {
    cases: engine,
    headlines: { async get() { return null; } },
    objectives: { async get() { return null; } } as never,
  });
  const { decision } = await engine.create(ORG, {
    producer: 'ACCOUNTING',
    recurrenceKey: 'invoice-aging::acme',
    detectionKey: 'month:2026-08',
    detectedAt: NOW,
    title: 'Acme invoices ageing',
    severity: 'HIGH',
  });
  assert.deepEqual(await participation.suggest(ORG, decision.id), []);
});

// --- The vocabulary --------------------------------------------------------------------------

test('every contribution has a label and a sentence saying what it asks for', () => {
  for (const c of CASE_CONTRIBUTIONS) {
    assert.ok(CASE_CONTRIBUTION_LABELS[c]?.length > 3, `${c} has no label`);
    assert.ok(CASE_CONTRIBUTION_DESCRIPTIONS[c]?.length > 20, `${c} has no description`);
  }
});

test('what is deferred is written down rather than left to be assumed', () => {
  for (const key of ['acknowledgement', 'escalation', 'sla', 'automaticRouting'] as const) {
    assert.ok(CASE_PARTICIPATION_DEFERRED[key].length > 40, `${key} is not explained`);
  }
});

// --- The migration ------------------------------------------------------------------------------

const MIGRATION = readFileSync(
  new URL(
    '../prisma/migrations/20260908000000_ci_stage4_case_participants/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

test('the migration is additive only', () => {
  // Statement-position only: the prose above deliberately says "Zero DROP".
  for (const destructive of ['DROP TABLE', 'DROP COLUMN', 'ALTER COLUMN', 'DELETE FROM', 'TRUNCATE', 'UPDATE "']) {
    assert.equal(MIGRATION.includes(destructive), false, `must not ${destructive}`);
  }
  assert.ok(MIGRATION.includes('CREATE TABLE "case_participants"'));
  assert.equal((MIGRATION.match(/CREATE TABLE/g) ?? []).length, 1, 'exactly one new table');
  assert.equal((MIGRATION.match(/INSERT INTO/g) ?? []).length, 0, 'no backfill, nothing seeded');
});

test('the migration creates no column Work OS owns', () => {
  const columns = MIGRATION.slice(
    MIGRATION.indexOf('CREATE TABLE'),
    MIGRATION.indexOf('CONSTRAINT "case_participants_pkey"'),
  );
  for (const field of WORK_OWNED_FIELDS) {
    assert.equal(columns.includes(`"${field}"`), false, `must not create ${field}`);
  }
  assert.equal(columns.includes('"status"'), false, 'no status column of any kind');
});

test('the migration is tenant-scoped, indexed and carries real foreign keys', () => {
  assert.ok(MIGRATION.includes('"organizationId" TEXT NOT NULL'));
  assert.ok(MIGRATION.includes('case_participants_org_priority_idx'));
  assert.ok(MIGRATION.includes('case_participants_org_user_released_idx'));
  assert.ok(MIGRATION.includes('CREATE UNIQUE INDEX "case_participants_priority_user_contribution_key"'));
  // Five foreign keys, including organizationId — the ten existing tables that
  // carry it without one are known debt, and this does not add to it.
  assert.equal((MIGRATION.match(/ADD CONSTRAINT "case_participants_\w+_fkey"/g) ?? []).length, 5);
  assert.ok(MIGRATION.includes('"organizations"("id") ON DELETE CASCADE'));
  assert.ok(MIGRATION.includes('"operational_priorities"("id") ON DELETE CASCADE'));
  assert.ok(MIGRATION.includes('case_participants_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "users"("id") ON DELETE SET NULL'));
});

test('the migration is plain ASCII', () => {
  // A leading em-dash in the sprint_11 migration blocked replay of the whole
  // ledger once. This is cheap to assert and expensive to rediscover.
  const nonAscii = [...MIGRATION].filter((ch) => ch.charCodeAt(0) > 127);
  assert.deepEqual(nonAscii, []);
});

const SERVICE_SOURCE = readFileSync(
  new URL('../src/services/case-participation.service.ts', import.meta.url),
  'utf8',
);

test('the service reaches no execution layer and calls no model', () => {
  // MATCHED AS AN IDENTIFIER OR A CALL, not as a word: the header explains at
  // length which layer owns work, and an assertion that forbids naming Work OS
  // forbids explaining the boundary.
  for (const forbidden of ['WorkRepository', 'workInstance', 'blueprint\\.', 'Blueprint\\b', 'anthropic', 'openai']) {
    assert.equal(
      new RegExp(forbidden).test(SERVICE_SOURCE),
      false,
      `must not reference ${forbidden}`,
    );
  }
  assert.equal(/\bfetch\s*\(/.test(SERVICE_SOURCE), false, 'must make no network call');
  assert.equal(/from '\.\.\/repositories\/work\./.test(SERVICE_SOURCE), false);
});
