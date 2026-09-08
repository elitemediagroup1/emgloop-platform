// What Stage 4 actually writes onto a Case's log, at the boundary that writes it.
//
// WHAT THESE PROVE. That every Stage 4 service now persists a governed
// observation type rather than a generic one carrying a sentence; that a reader
// recovers the meaning from the stored row without consulting prose; that the
// Decision Center stayed producer-neutral while this happened; and that a log
// containing pre-migration rows alongside new ones reads as one story.
//
// WHY AT THIS LAYER. `packages/shared` can prove the vocabulary is coherent, but
// only a run through the real services and a real Prisma shape can prove that
// what reaches the database is what the vocabulary describes. The debt being
// retired was precisely a gap between the two: the predicates were correct, and
// the rows were generic.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CASE_EVENT_KINDS,
  CASE_EVENT_REASONS,
  INVESTIGATION_PRODUCER,
  LEGACY_CASE_EVENT_SIGNATURES,
  caseEventKind,
  investigationRecurrenceKey,
  isLegacyCaseEvent,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import { CaseParticipantRepository } from '../src/repositories/case-participant.repository';
import { CaseParticipationService } from '../src/services/case-participation.service';

const ORG = 'org-alpha';
const HEADLINE_ID = 'hl_cem';
const CHARLIE = 'usr_charlie';
const MATT = 'usr_matt';
const NOW = new Date('2026-09-08T14:30:00.000Z');
const asHuman = (userId: string) => ({ type: 'HUMAN' as const, userId, source: 'operator' });

async function world() {
  const prisma = makeCognitivePrisma();
  const engine = new DecisionEngine(prisma as never);
  for (const id of [CHARLIE, MATT]) {
    await prisma.user.create({
      data: { id, organizationId: ORG, email: `${id}@test`, name: id, status: 'ACTIVE', metadata: {} },
    });
  }
  const participation = new CaseParticipationService(prisma as never, {
    cases: engine,
    participants: new CaseParticipantRepository(prisma as never),
    headlines: { async get() { return null; } },
    objectives: { async get() { return null; } } as never,
  });
  const { decision } = await engine.create(ORG, {
    producer: INVESTIGATION_PRODUCER,
    recurrenceKey: investigationRecurrenceKey(HEADLINE_ID),
    detectionKey: `promotion:${HEADLINE_ID}`,
    detectedAt: NOW,
    title: "Buyer CEM's monetized rate fell.",
    severity: 'NOTABLE',
    sourceReference: HEADLINE_ID,
  });
  return { prisma, engine, participation, caseId: decision.id };
}

const logOf = (prisma: ReturnType<typeof makeCognitivePrisma>, caseId: string) =>
  prisma.operationalObservation.findMany({ where: { priorityId: caseId }, orderBy: { sequence: 'asc' } });

// --- 1. The row that reaches the database carries the meaning -----------------------

test('1. asking somebody to contribute writes PARTICIPANT_ADDED, not a note', async () => {
  const { prisma, participation, caseId } = await world();
  await participation.add(ORG, caseId, {
    userId: MATT,
    contribution: 'INVESTIGATE',
    request: 'Work out whether the drop is real.',
    actor: asHuman(CHARLIE),
  });

  const log = await logOf(prisma, caseId);
  const row = log.at(-1)!;
  assert.equal(row.observationType, 'PARTICIPANT_ADDED');
  assert.equal(caseEventKind(row as never), 'PARTICIPANT_ADDED');
  assert.equal(isLegacyCaseEvent(row as never), false, 'written in the current shape');
  // The sentence is still there, and is now only description.
  assert.equal(row.reason, CASE_EVENT_REASONS.PARTICIPANT_ADDED);
});

test('1b. changing and releasing write their own types, all three distinguishable', async () => {
  const { prisma, participation, caseId } = await world();
  await participation.add(ORG, caseId, {
    userId: MATT, contribution: 'INVESTIGATE', request: 'Look into it.', actor: asHuman(CHARLIE),
  });
  await participation.add(ORG, caseId, {
    userId: MATT, contribution: 'INVESTIGATE', request: 'Look into it by Friday.', actor: asHuman(CHARLIE),
  });
  await participation.release(ORG, caseId, MATT, 'INVESTIGATE', asHuman(CHARLIE));

  const kinds = (await logOf(prisma, caseId))
    .map((o) => caseEventKind(o as never))
    .filter((k): k is NonNullable<typeof k> => k !== null);
  assert.deepEqual(kinds, ['PARTICIPANT_ADDED', 'PARTICIPANT_CHANGED', 'PARTICIPANT_RELEASED']);
  // NOT ONE OF THEM IS A NOTE ANY MORE. This is the assertion that fails if a
  // future change reintroduces the generic type.
  const stored = await logOf(prisma, caseId);
  assert.equal(stored.filter((o) => o.observationType === 'NOTE_ADDED').length, 0);
});

// --- 2. The reader never needs the prose -------------------------------------------

test('2. a reworded row still reads correctly, which is the entire point', async () => {
  const { prisma, participation, caseId } = await world();
  await participation.add(ORG, caseId, {
    userId: MATT, contribution: 'DECIDE', request: 'Decide whether to pause the buyer.', actor: asHuman(CHARLIE),
  });
  const row = (await logOf(prisma, caseId)).at(-1)!;

  // Somebody rewrites the human-facing sentence — a copy edit, a translation, a
  // typo fix. Before the vocabulary migration this silently destroyed the
  // history's readability and no test noticed.
  await prisma.operationalObservation.update({
    where: { id: row.id },
    data: { reason: 'Se pidió a alguien que contribuyera.' },
  });

  const after = (await logOf(prisma, caseId)).at(-1)!;
  assert.equal(caseEventKind(after as never), 'PARTICIPANT_ADDED', 'the meaning survived the copy edit');
});

// --- 3. Mixed history ----------------------------------------------------------------

test('3. a log holding pre-migration and current rows reads as one story', async () => {
  const { prisma, participation, caseId } = await world();
  // A row as an older build wrote it, written directly to stand in for history
  // that is already in the database and is not being rewritten.
  const legacySig = LEGACY_CASE_EVENT_SIGNATURES.FINDING_RECORDED;
  await prisma.operationalObservation.create({
    data: {
      organizationId: ORG,
      priorityId: caseId,
      observationType: legacySig.observationType,
      occurredAt: NOW,
      sequence: 500,
      actorType: 'SYSTEM',
      source: 'ci-finding',
      reason: legacySig.reason,
      evidence: {},
    },
  });
  await participation.add(ORG, caseId, {
    userId: MATT, contribution: 'DOMAIN_INPUT', request: 'What does the buyer usually do here?', actor: asHuman(CHARLIE),
  });

  const log = await logOf(prisma, caseId);
  const finding = log.find((o) => caseEventKind(o as never) === 'FINDING_RECORDED')!;
  const participant = log.find((o) => caseEventKind(o as never) === 'PARTICIPANT_ADDED')!;
  assert.ok(finding, 'the old row is still understood');
  assert.ok(participant, 'the new row is understood');
  assert.equal(isLegacyCaseEvent(finding as never), true);
  assert.equal(isLegacyCaseEvent(participant as never), false);
  // AND THE OLD ROW WAS NOT TOUCHED. No migration rewrote it, and nothing here did.
  assert.equal(finding.observationType, 'NOTE_ADDED');
  assert.equal(finding.reason, legacySig.reason);
});

// --- 4. The Decision Center stayed neutral --------------------------------------------

test('4. the engine never decides what a Stage 4 event means', async () => {
  // `linkHypothesis` takes the meaning from its caller and defaults to
  // NOTE_ADDED. A producer that expresses no opinion behaves exactly as it did
  // before this vocabulary existed — which is what makes the change additive for
  // every producer that is not Stage 4.
  const { prisma, engine, caseId } = await world();
  const hypothesis = await prisma.intelligenceHypothesis.create({
    data: {
      id: 'hyp_1', organizationId: ORG, hypothesisType: 'other-producer:thing',
      title: 'Something another producer believes', status: 'PROPOSED',
    },
  });
  await engine.linkHypothesis(ORG, caseId, {
    hypothesisId: hypothesis.id,
    actor: { type: 'SYSTEM', source: 'some-other-producer' },
    reason: 'A producer that is not Stage 4 attached a belief.',
  });
  const row = (await logOf(prisma, caseId)).at(-1)!;
  assert.equal(row.observationType, 'NOTE_ADDED', 'unchanged default');
  assert.equal(caseEventKind(row as never), null, 'and it is not a Stage 4 event');
});

test('4b. the engine source names no Stage 4 concept', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(
    new URL('../src/services/decision/decision-engine.ts', import.meta.url),
    'utf8',
  );
  // The Decision Center is producer-neutral platform machinery. A switch here on
  // "is this a finding" would be the inversion the layer exists to prevent — the
  // caller chooses the type, and the engine only records it.
  for (const word of ['FINDING_RECORDED', 'FINDING_SUPERSEDED', 'PARTICIPANT_ADDED', 'RECOMMENDATION_SELECTED']) {
    assert.equal(
      new RegExp(`'${word}'`).test(src),
      false,
      `decision-engine.ts must not name ${word}`,
    );
  }
});

// --- 5. Coverage ------------------------------------------------------------------------

test('5. every Stage 4 meaning has somewhere that writes it', async () => {
  // A vocabulary member nothing emits is a member that will drift. This asserts
  // the ten meanings are exactly the ten the services below produce, so adding an
  // eleventh without an emitter fails here rather than in six months.
  const emitted = new Set<string>();
  const { readFileSync } = await import('node:fs');
  for (const file of [
    '../src/services/case-participation.service.ts',
    '../src/services/case-recommendation.service.ts',
    '../src/services/case-finding.service.ts',
    '../src/services/headline-investigation.service.ts',
  ]) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const kind of CASE_EVENT_KINDS) {
      if (new RegExp(`observationType: (input\\.\\w+ \\? )?'${kind}'|\\? '${kind}'|: '${kind}'`).test(src)) {
        emitted.add(kind);
      }
    }
  }
  assert.deepEqual([...emitted].sort(), [...CASE_EVENT_KINDS].sort());
});
