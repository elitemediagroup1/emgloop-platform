// The two reads Charlie and Lexi design against.
//
// WHAT THESE PROVE
//
// NO PRISMA MODEL REACHES THE UI. Every field of both contracts is a shape from
// `@emgloop/shared`. A WorkStage, an OperationalObservation or a
// CognitiveDecision in a UI contract would make the database schema the
// product's API, and the next migration would be a front-end change.
//
// THE COMPOSITION ADDS NO RULES. Each part is produced by the service that owns
// it. Where a question cannot be answered by one of those, the answer is that it
// is not known — never a value assembled from parts.
//
// UNKNOWN SURVIVES TO THE LAST LAYER. A Case with a dangling work reference and
// an unmeasured window must not read as a healthy one, and the home screen must
// not say "all clear" because the list happened to be empty.
//
// IT WRITES NOTHING.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { INVESTIGATION_PRODUCER, investigationRecurrenceKey, isAllClear } from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { DecisionEngine } from '../src/services/decision/decision-engine';
import { CaseWorkspaceService } from '../src/services/case-workspace.service';

const ORG = 'org_alpha';
const OTHER = 'org_beta';
const NOW = new Date('2026-09-08T12:00:00.000Z');
const human = { type: 'HUMAN' as const, userId: 'usr_charlie', source: 'operator' };

async function world(
  opts: {
    objectives?: { id: string; title: string }[];
    readinessByObjective?: Record<string, string | null>;
    headlines?: number;
    coordinationNotKnown?: string[];
    findingState?: string | null;
  } = {},
) {
  const prisma = makeCognitivePrisma();
  const engine = new DecisionEngine(prisma as never);
  const { decision } = await engine.create(ORG, {
    producer: INVESTIGATION_PRODUCER,
    recurrenceKey: investigationRecurrenceKey('hl_cem'),
    detectionKey: 'promotion:hl_cem',
    detectedAt: NOW,
    title: "Buyer CEM's monetized rate fell.",
    severity: 'NOTABLE',
    sourceReference: 'hl_cem',
  });

  const scoped = <T>(value: T) =>
    async (organizationId: string, caseId?: string) =>
      organizationId === ORG && (caseId === undefined || caseId === decision.id) ? value : null;

  const workspace = new CaseWorkspaceService(prisma as never, {
    brief: {
      get: scoped({
        caseId: decision.id, status: 'ASSIGNED', title: 'x', subject: null,
        origin: {}, authorization: null, ownerUserId: null, assigneeUserId: null,
        evidence: [], uncertainty: {}, fiveWs: {}, timeline: [], history: {},
        outcome: null, measuredEffectCents: null,
        sourceSystem: INVESTIGATION_PRODUCER, recurrenceKey: 'headline:hl_cem',
      }) as never,
    },
    findings: {
      get: scoped(
        opts.findingState === null ? null : { findingId: 'fnd_1', state: opts.findingState ?? 'DEVELOPING' },
      ) as never,
    },
    recommendations: { get: scoped(null) as never },
    participation: { get: scoped({ caseId: decision.id, participants: [], released: [], awaiting: [], work: [] }) as never },
    coordination: {
      get: scoped({
        caseId: decision.id, asks: [], work: [],
        notKnown: opts.coordinationNotKnown ?? [],
        ruleVersion: 'case-work-coordination.v1',
      }) as never,
    },
    monitoring: {
      get: scoped(null) as never,
      outcome: scoped({
        caseId: decision.id, outcome: null, statement: 'x', causalClaim: null, causalCaveat: 'y',
        lineage: {}, notEstablished: [], measuredEffectCents: null, measuredEffectBasis: null,
        ruleVersion: 'case-monitoring.v1',
      }) as never,
    },
    headlines: {
      async list(organizationId: string) {
        return organizationId === ORG ? Array.from({ length: opts.headlines ?? 0 }, (_, i) => ({ id: `hl_${i}` })) : [];
      },
    } as never,
    objectives: {
      async list(organizationId: string) {
        return organizationId === ORG ? (opts.objectives ?? []) : [];
      },
    } as never,
    readiness: {
      async readinessFor(_org: string, objectiveId: string) {
        const outcome = opts.readinessByObjective?.[objectiveId];
        // NULL MEANS NOTHING COULD BE ASKED. Not READY.
        if (outcome === undefined || outcome === null) return null;
        return { readiness: { outcome, ready: outcome === 'READY', findings: [] } } as never;
      },
    } as never,
  });

  return { prisma, engine, workspace, caseId: decision.id };
}

// --- 1. The Case contract ------------------------------------------------------------

test('1. one read returns every part of an investigation', async () => {
  const { workspace, caseId } = await world();
  const view = await workspace.case(ORG, caseId, NOW);
  assert.equal(view?.caseId, caseId);
  for (const part of ['brief', 'finding', 'recommendations', 'participation', 'coordination', 'monitoring', 'outcome']) {
    assert.ok(part in view!, `${part} is present`);
  }
});

test('1b. an absent part is null and does not look broken', async () => {
  // A Case with no Finding, no recommendations and no work is an ordinary Case
  // on its first morning, and the shape has to say so.
  const { workspace, caseId } = await world({ findingState: null });
  const view = await workspace.case(ORG, caseId, NOW);
  assert.equal(view?.finding, null);
  assert.equal(view?.recommendations, null);
  assert.equal(view?.monitoring, null);
  assert.ok(view, 'and the Case still reads');
});

test('1c. what could not be established survives to the last layer', async () => {
  const { workspace, caseId } = await world({
    coordinationNotKnown: ['Loop cannot find the work this Case pointed at.'],
    findingState: 'DEVELOPING',
  });
  const view = await workspace.case(ORG, caseId, NOW);
  assert.ok(view!.notKnown.some((l) => l.includes('cannot find the work')));
  assert.ok(view!.notKnown.some((l) => l.includes('not established this claim')));
  // De-duplicated, so a reader is told once rather than three times.
  assert.equal(new Set(view!.notKnown).size, view!.notKnown.length);
});

test('1d. the brief is the tenant gate, and a cross-tenant id reveals nothing', async () => {
  const { workspace, caseId } = await world();
  assert.equal(await workspace.case(OTHER, caseId, NOW), null);
});

// --- 2. The home-screen contract ------------------------------------------------------

test('2. an empty Headline list with full coverage is an all-clear', async () => {
  const { workspace } = await world({
    objectives: [{ id: 'obj_a', title: 'Grow Medicare' }],
    readinessByObjective: { obj_a: 'READY' },
    headlines: 0,
  });
  const view = await workspace.attention(ORG, NOW);
  assert.equal(view.attention.state, 'ALL_CLEAR');
  assert.equal(isAllClear(view.attention), true);
});

test('2b. an empty Headline list with a coverage gap is NOT an all-clear', async () => {
  // THE PROPERTY. Both mornings render as zero rows; one is good news and the
  // other is an outage.
  const { workspace } = await world({
    objectives: [{ id: 'obj_a', title: 'Grow Medicare' }, { id: 'obj_b', title: 'Grow ACA' }],
    readinessByObjective: { obj_a: 'READY', obj_b: 'NOT_READY' },
    headlines: 0,
  });
  const view = await workspace.attention(ORG, NOW);
  assert.equal(view.attention.state, 'INSUFFICIENT_COVERAGE');
  assert.equal(isAllClear(view.attention), false);
  assert.ok(view.attention.notKnown[0]?.includes('Grow ACA'));
});

test('2c. an objective whose readiness cannot even be asked is unmeasurable', async () => {
  const { workspace } = await world({
    objectives: [{ id: 'obj_a', title: 'Grow Medicare' }],
    readinessByObjective: {},
    headlines: 0,
  });
  const view = await workspace.attention(ORG, NOW);
  assert.equal(view.attention.state, 'INSUFFICIENT_COVERAGE');
  assert.equal(view.attention.objectivesMeasurable, 0);
});

test('2d. another organization gets nothing to check, not an all-clear', async () => {
  const { workspace } = await world({
    objectives: [{ id: 'obj_a', title: 'Grow Medicare' }],
    readinessByObjective: { obj_a: 'READY' },
    headlines: 3,
  });
  const view = await workspace.attention(OTHER, NOW);
  assert.equal(view.attention.state, 'NOTHING_TO_CHECK');
  assert.equal(view.headlines.length, 0);
  assert.equal(isAllClear(view.attention), false, 'an empty tenant is never all-clear');
});

// --- 3. No Prisma model reaches the UI ---------------------------------------------------

test('3. the UI contracts name no Prisma model', () => {
  const src = readFileSync(new URL('../src/services/case-workspace.service.ts', import.meta.url), 'utf8');
  // The contract block is what a client codes against. A Prisma model here would
  // make the database schema the product's API, and the next migration a
  // front-end change.
  //
  // MATCHED IN DECLARATION POSITION, NOT AS WORDS. The contract explains what
  // each part is, and those explanations name the things the parts are about --
  // "the Headlines themselves", "Work OS owns every answer". Forbidding the
  // words would forbid the documentation. What must not appear is a model USED
  // AS A TYPE.
  const contracts = src
    .slice(src.indexOf('export interface CaseWorkspaceView'), src.indexOf('export interface CaseWorkspaceDeps'))
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');
  for (const model of [
    'OperationalPriority', 'OperationalObservation', 'CognitiveDecision', 'IntelligenceHypothesis',
    'WorkInstance', 'WorkStage', 'WorkStageEvent', 'WorkDependency', 'CaseParticipant',
    'DecisionEvidence', 'PerformanceObjective', 'Prisma.',
  ]) {
    assert.equal(
      new RegExp(`:\\s*(readonly\\s+)?${model}\\b`).test(contracts),
      false,
      `the UI contract must not use ${model} as a type`,
    );
  }
  // AND NO FIELD IS TYPED `unknown`. A weak type is not the absence of a
  // contract; it is a contract that has given up, and it is how a raw row gets
  // through under a name that tells nobody. This caught exactly that.
  assert.equal(/:\s*(readonly\s+)?unknown/.test(contracts), false, 'no field may be typed unknown');
});

test('3b. every part of the Case contract is a shared type', () => {
  const src = readFileSync(new URL('../src/services/case-workspace.service.ts', import.meta.url), 'utf8');
  for (const t of ['CaseBriefView', 'CaseFindingView', 'CaseParticipationView', 'CaseCoordinationView', 'CaseOutcomeView', 'AttentionAssessment']) {
    assert.ok(src.includes(t), `${t} is the contract for its part`);
  }
  // And they come from the contract package, not from @prisma/client.
  const prismaImport = src.slice(src.indexOf("from '@prisma/client'") - 200, src.indexOf("from '@prisma/client'"));
  assert.ok(prismaImport.includes('PrismaClient'), 'only the client itself is imported');
  assert.equal(/OperationalPriority|WorkStage|CognitiveDecision/.test(prismaImport), false);
});

// --- 4. It writes nothing -------------------------------------------------------------------

test('4. composing a Case and a home screen writes nothing at all', async () => {
  const { prisma, workspace, caseId } = await world({
    objectives: [{ id: 'obj_a', title: 'Grow Medicare' }],
    readinessByObjective: { obj_a: 'READY' },
  });
  const before = (await prisma.operationalObservation.findMany({ where: {} })).length;
  await workspace.case(ORG, caseId, NOW);
  await workspace.attention(ORG, NOW);
  assert.equal((await prisma.operationalObservation.findMany({ where: {} })).length, before);
});

test('4b. the composition service has no write path', () => {
  const src = readFileSync(new URL('../src/services/case-workspace.service.ts', import.meta.url), 'utf8');
  for (const forbidden of ['.create(', '.update(', '.upsert(', '.delete(', '$transaction', 'addObservation']) {
    assert.equal(src.includes(forbidden), false, `must not contain ${forbidden}`);
  }
});

test('4c. the composition adds no rules of its own', () => {
  const src = readFileSync(new URL('../src/services/case-workspace.service.ts', import.meta.url), 'utf8');
  // Every verdict comes from the service that owns it. A threshold, a comparison
  // against a duration, or a re-derivation here would be a second answer to a
  // question something else already answers.
  for (const forbidden of [/\bgetTime\(\)/, /\b\d+\s*\*\s*60\s*\*\s*60/, /assessExecution/, /assessMonitoring/, /assessFindingEstablishment/]) {
    assert.equal(forbidden.test(src), false, `must not contain ${forbidden}`);
  }
  // The one assessment it does call is the all-clear, which is the composition's
  // own question and nobody else's.
  assert.ok(src.includes('assessAttention'));
});
