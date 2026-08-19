// Member expectation persistence — the declaration layer.
//
// THE PROPERTY UNDER TEST, ONCE
//
// What was true on a past date must stay true after somebody changes what is
// true today. Every case below is a way that could fail: a transition that
// overwrites instead of succeeding, an interval that swallows its neighbour, a
// gap silently filled, a resolver that guesses when two statements disagree, or
// one organization's declaration answering another's question.
//
// The counter-property matters just as much: a member nobody has declared must
// resolve UNKNOWN, not a default. UNKNOWN is not storable, so the only way to
// produce it is to have nothing to say — and the gate in @emgloop/shared turns it
// into a refusal rather than a number.
//
// Everything runs on the in-memory Prisma double, which models the EXCLUDE
// constraint the migration adds. The overlap invariant is therefore proven at the
// layer that actually enforces it under concurrency, not only at the repository's
// own pre-check.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MEMBER_EXPECTATION_STATES,
  type BusinessDate,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import {
  ProviderMemberExpectationRepository,
  type DeclareExpectationInput,
} from '../src/repositories/provider-member-expectation.repository';
import { businessDateToColumn } from '../src/repositories/provider-observation.repository';
import { CALLGRID_PROVIDER, CALLS_STREAM } from '../src/services/provider-observation.service';

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';

// Generic fixture members. The four shapes the brief names, with no business-
// specific identifier anywhere: a campaign that changes state, one that always
// delivered, one deliberately outside the population, and one nobody has spoken
// about at all.
const TRANSITIONING = 'cmp-transitioning';
const STEADY = 'cmp-steady';
const EXCLUDED_MEMBER = 'cmp-excluded';
const UNDECLARED = 'cmp-undeclared';

const AUG_01: BusinessDate = '2026-08-01';
const AUG_05: BusinessDate = '2026-08-05';
const AUG_18: BusinessDate = '2026-08-18';
const AUG_19: BusinessDate = '2026-08-19';
const JUL_31: BusinessDate = '2026-07-31';

function make() {
  const prisma = makeCognitivePrisma();
  return { prisma, expectations: new ProviderMemberExpectationRepository(prisma as never) };
}

function input(over: Partial<DeclareExpectationInput> = {}): DeclareExpectationInput {
  return {
    provider: CALLGRID_PROVIDER,
    stream: CALLS_STREAM,
    dimension: 'CAMPAIGN',
    memberExternalId: TRANSITIONING,
    state: 'EXPECTED',
    basis: 'OPERATOR_DECLARED',
    reason: 'Declared while setting up measurement.',
    effectiveFrom: AUG_01,
    ...over,
  };
}

type Repo = ProviderMemberExpectationRepository;

function resolve(
  repo: Repo,
  member: string,
  on: BusinessDate,
  scope: { organizationId?: string; provider?: string; stream?: string; dimension?: 'CAMPAIGN' | 'SOURCE' } = {},
) {
  return repo.resolveOn(
    scope.organizationId ?? ORG,
    scope.provider ?? CALLGRID_PROVIDER,
    scope.stream ?? CALLS_STREAM,
    scope.dimension ?? 'CAMPAIGN',
    member,
    on,
  );
}

/** Campaign A: not connected through 2026-08-18, connected from 2026-08-19. */
async function campaignA(repo: Repo): Promise<void> {
  const first = await repo.declare(
    ORG,
    input({
      state: 'NOT_CONFIGURED',
      basis: 'PROVIDER_CONFIG_VERIFIED',
      reason: 'No delivery webhook attached at the provider.',
      effectiveFrom: AUG_01,
    }),
  );
  assert.equal(first.ok, true);
  const second = await repo.declare(
    ORG,
    input({
      state: 'EXPECTED',
      basis: 'PROVIDER_CONFIG_VERIFIED',
      reason: 'Delivery webhook attached and verified in the provider interface.',
      effectiveFrom: AUG_19,
    }),
  );
  assert.equal(second.ok, true);
}

// --- 1–4. Writing one declaration, and what its interval means ---------------------

test('1 · an open-ended declaration is created and says so', async () => {
  const { expectations } = make();
  const result = await expectations.declare(ORG, input());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.declaration.state, 'EXPECTED');
  assert.equal(result.declaration.effectiveFrom, AUG_01);
  assert.equal(result.declaration.effectiveTo, null, 'open-ended, not a guessed end date');
  assert.equal(result.supersededId, null, 'nothing preceded it');
  assert.equal(result.unchanged, false);
});

test('2 · it resolves on a date it covers', async () => {
  const { expectations } = make();
  await expectations.declare(ORG, input());
  const resolution = await resolve(expectations, TRANSITIONING, AUG_05);
  assert.equal(resolution.state, 'EXPECTED');
  assert.equal(resolution.matches, 1);
  assert.equal(resolution.declaration?.effectiveFrom, AUG_01);
});

test('3 · effectiveFrom is INCLUSIVE — the first date is covered', async () => {
  const { expectations } = make();
  await expectations.declare(ORG, input({ effectiveFrom: AUG_19 }));
  assert.equal((await resolve(expectations, TRANSITIONING, AUG_19)).state, 'EXPECTED');
  assert.equal((await resolve(expectations, TRANSITIONING, AUG_18)).state, 'UNKNOWN');
});

test('4 · effectiveTo is EXCLUSIVE — the end date is NOT covered', async () => {
  const { expectations } = make();
  await expectations.declare(ORG, input({ effectiveFrom: AUG_01, effectiveTo: AUG_19 }));
  assert.equal((await resolve(expectations, TRANSITIONING, AUG_18)).state, 'EXPECTED');
  assert.equal(
    (await resolve(expectations, TRANSITIONING, AUG_19)).state,
    'UNKNOWN',
    'the day the declaration ends is the first day it says nothing about',
  );
});

// --- 5–7. What silence resolves to -------------------------------------------------

test('5 · a date before the first declaration is UNKNOWN, never a default', async () => {
  const { expectations } = make();
  await expectations.declare(ORG, input({ effectiveFrom: AUG_01 }));
  const resolution = await resolve(expectations, TRANSITIONING, JUL_31);
  assert.equal(resolution.state, 'UNKNOWN');
  assert.equal(resolution.matches, 0);
  assert.equal(resolution.declaration, null);
});

test('6 · a gap between two declarations is UNKNOWN, not bridged', async () => {
  // Nobody said what was true between the 10th and the 20th. Carrying the earlier
  // declaration forward would be inventing a statement the record does not hold.
  const { expectations } = make();
  await expectations.declare(ORG, input({ effectiveFrom: AUG_01, effectiveTo: '2026-08-10' }));
  await expectations.declare(ORG, input({ state: 'EXCLUDED', exclusionReason: 'TEST_TRAFFIC', reason: 'Test rig traffic.', effectiveFrom: '2026-08-20' }));
  assert.equal((await resolve(expectations, TRANSITIONING, '2026-08-09')).state, 'EXPECTED');
  assert.equal((await resolve(expectations, TRANSITIONING, '2026-08-15')).state, 'UNKNOWN');
  assert.equal((await resolve(expectations, TRANSITIONING, '2026-08-20')).state, 'EXCLUDED');
});

test('7 · an open-ended declaration resolves dates far after it was made', async () => {
  const { expectations } = make();
  await expectations.declare(ORG, input({ memberExternalId: STEADY, effectiveFrom: AUG_01 }));
  assert.equal((await resolve(expectations, STEADY, '2027-03-14')).state, 'EXPECTED');
});

// --- 8–10. Transitions, and the history they must not touch -------------------------

test('8 · NOT_CONFIGURED -> EXPECTED preserves what was true before', async () => {
  // THE AUGUST 2026 SHAPE. A campaign whose webhook is attached on the 19th was
  // genuinely not connected on the 5th, and the 5th must keep saying so — or
  // every prior day retroactively becomes a delivery failure nobody could have
  // prevented.
  const { expectations } = make();
  await campaignA(expectations);
  assert.equal((await resolve(expectations, TRANSITIONING, AUG_05)).state, 'NOT_CONFIGURED');
  assert.equal((await resolve(expectations, TRANSITIONING, AUG_18)).state, 'NOT_CONFIGURED');
  assert.equal((await resolve(expectations, TRANSITIONING, AUG_19)).state, 'EXPECTED');
  assert.equal((await resolve(expectations, TRANSITIONING, '2026-09-01')).state, 'EXPECTED');
});

test('9 · EXPECTED -> EXCLUDED preserves history the same way', async () => {
  const { expectations } = make();
  await expectations.declare(ORG, input({ memberExternalId: EXCLUDED_MEMBER, effectiveFrom: AUG_01 }));
  const second = await expectations.declare(
    ORG,
    input({
      memberExternalId: EXCLUDED_MEMBER,
      state: 'EXCLUDED',
      exclusionReason: 'INTERNAL_TRAFFIC',
      reason: 'House traffic, outside the measured business.',
      effectiveFrom: AUG_19,
    }),
  );
  assert.equal(second.ok, true);
  assert.equal((await resolve(expectations, EXCLUDED_MEMBER, AUG_05)).state, 'EXPECTED');
  assert.equal((await resolve(expectations, EXCLUDED_MEMBER, AUG_19)).state, 'EXCLUDED');
});

test('10 · EXCLUDED -> EXPECTED preserves history too', async () => {
  const { expectations } = make();
  await expectations.declare(
    ORG,
    input({
      memberExternalId: EXCLUDED_MEMBER,
      state: 'EXCLUDED',
      exclusionReason: 'TEST_TRAFFIC',
      reason: 'Integration test traffic during setup.',
      effectiveFrom: AUG_01,
    }),
  );
  await expectations.declare(
    ORG,
    input({ memberExternalId: EXCLUDED_MEMBER, state: 'EXPECTED', reason: 'Now carrying real commercial traffic.', effectiveFrom: AUG_19 }),
  );
  assert.equal((await resolve(expectations, EXCLUDED_MEMBER, AUG_05)).state, 'EXCLUDED');
  assert.equal((await resolve(expectations, EXCLUDED_MEMBER, AUG_05)).declaration?.exclusionReason, 'TEST_TRAFFIC');
  assert.equal((await resolve(expectations, EXCLUDED_MEMBER, AUG_19)).state, 'EXPECTED');
});

// --- 11–12. Overlap, at both layers -------------------------------------------------

test('11 · a declaration that would swallow a later one is refused, not applied', async () => {
  // Succeeding a declaration is a transition. Back-dating over one somebody else
  // recorded is an overwrite, and this method will not make that decision.
  const { expectations } = make();
  await expectations.declare(ORG, input({ effectiveFrom: AUG_19 }));
  const backdated = await expectations.declare(
    ORG,
    input({ state: 'NOT_CONFIGURED', reason: 'Backfilling what we think was true.', effectiveFrom: AUG_01 }),
  );
  assert.equal(backdated.ok, false);
  if (backdated.ok) return;
  assert.equal(backdated.reason, 'OVERLAPS_EXISTING');
  assert.equal((await resolve(expectations, TRANSITIONING, AUG_19)).state, 'EXPECTED', 'and nothing was written');
});

test('11b · THE DATABASE refuses an overlap the repository never sees', async () => {
  // The invariant that matters under concurrency: two declarations that each pass
  // their own pre-check and both commit. The EXCLUDE constraint is what stops
  // that, so it is tested by writing around the repository entirely.
  const { prisma, expectations } = make();
  await expectations.declare(ORG, input({ effectiveFrom: AUG_01 }));
  await assert.rejects(
    () =>
      prisma.providerMemberExpectation.create({
        data: {
          organizationId: ORG,
          provider: CALLGRID_PROVIDER,
          stream: CALLS_STREAM,
          memberDimension: 'CAMPAIGN',
          memberExternalId: TRANSITIONING,
          state: 'EXCLUDED',
          exclusionReason: 'TEST_TRAFFIC',
          basis: 'OPERATOR_DECLARED',
          reason: 'A racing declaration.',
          effectiveFrom: businessDateToColumn(AUG_19),
          effectiveTo: null,
          declaredByUserId: null,
        },
      }),
    (e: Error & { code?: string }) => e.code === '23P01',
  );
});

test('11c · back-to-back declarations do NOT overlap — the boundary is half-open', async () => {
  // [Aug 1, Aug 19) and [Aug 19, ...) touch and share no date. If the constraint
  // treated the boundary as closed, every legitimate transition would be refused.
  const { prisma, expectations } = make();
  await campaignA(expectations);
  const rows = await prisma.providerMemberExpectation.findMany({
    where: { organizationId: ORG, memberExternalId: TRANSITIONING },
    orderBy: { effectiveFrom: 'asc' },
  });
  assert.equal(rows.length, 2);
});

test('12 · re-declaring what the record already says writes nothing', async () => {
  const { prisma, expectations } = make();
  const first = await expectations.declare(ORG, input());
  const again = await expectations.declare(ORG, input({ reason: 'Re-stated during a review.' }));
  assert.equal(again.ok, true);
  if (!again.ok || !first.ok) return;
  assert.equal(again.unchanged, true, 'an identical statement is not a change');
  assert.equal(again.declaration.id, first.declaration.id);
  assert.equal(await prisma.providerMemberExpectation.count(), 1, 'and no interval was fragmented');
});

// --- 13–17. Isolation, one key column at a time --------------------------------------

test('13 · organization isolation — one tenant never answers another tenant', async () => {
  const { expectations } = make();
  await expectations.declare(ORG, input());
  assert.equal((await resolve(expectations, TRANSITIONING, AUG_05)).state, 'EXPECTED');
  assert.equal(
    (await resolve(expectations, TRANSITIONING, AUG_05, { organizationId: OTHER_ORG })).state,
    'UNKNOWN',
  );
});

test('14 · provider isolation', async () => {
  const { expectations } = make();
  await expectations.declare(ORG, input());
  assert.equal(
    (await resolve(expectations, TRANSITIONING, AUG_05, { provider: 'other-provider' })).state,
    'UNKNOWN',
  );
});

test('15 · stream isolation — a campaign on the calls feed says nothing about reports', async () => {
  const { expectations } = make();
  await expectations.declare(ORG, input());
  assert.equal(
    (await resolve(expectations, TRANSITIONING, AUG_05, { stream: 'auction-reports' })).state,
    'UNKNOWN',
  );
});

test('16 · member dimension isolation', async () => {
  const { expectations } = make();
  await expectations.declare(ORG, input());
  assert.equal(
    (await resolve(expectations, TRANSITIONING, AUG_05, { dimension: 'SOURCE' })).state,
    'UNKNOWN',
  );
});

test('17 · member id isolation — declaring one campaign declares nothing about another', async () => {
  const { expectations } = make();
  await expectations.declare(ORG, input({ memberExternalId: STEADY }));
  assert.equal((await resolve(expectations, STEADY, AUG_05)).state, 'EXPECTED');
  assert.equal((await resolve(expectations, UNDECLARED, AUG_05)).state, 'UNKNOWN');
});

// --- 18–19. The vocabulary the resolver speaks ------------------------------------------

test('18 · a member nobody has declared is UNKNOWN, with nothing standing in for it', async () => {
  const { expectations } = make();
  const resolution = await resolve(expectations, UNDECLARED, AUG_05);
  assert.equal(resolution.state, 'UNKNOWN');
  assert.equal(resolution.matches, 0);
  assert.equal(resolution.declaration, null);
});

test('19 · the resolver returns the PR 1 vocabulary and never invents a second one', async () => {
  const { expectations } = make();
  await campaignA(expectations);
  const states = [
    (await resolve(expectations, TRANSITIONING, AUG_05)).state,
    (await resolve(expectations, TRANSITIONING, AUG_19)).state,
    (await resolve(expectations, UNDECLARED, AUG_19)).state,
  ];
  for (const state of states) {
    assert.ok(
      state === 'UNKNOWN' || (MEMBER_EXPECTATION_STATES as readonly string[]).includes(state),
      `${state} is not in the declared vocabulary`,
    );
  }
  assert.equal(
    (MEMBER_EXPECTATION_STATES as readonly string[]).includes('UNKNOWN'),
    false,
    'UNKNOWN is resolvable and never storable',
  );
});

test('19b · a stored state nobody can read resolves UNKNOWN rather than being guessed', async () => {
  // Legacy or hand-written data. The vocabularies are TEXT columns so they can
  // widen without production DDL, which means a row can outlive the build that
  // wrote it. Interpreting it would be exactly the fabrication this gate exists
  // to stop.
  const { prisma, expectations } = make();
  await prisma.providerMemberExpectation.create({
    data: {
      organizationId: ORG,
      provider: CALLGRID_PROVIDER,
      stream: CALLS_STREAM,
      memberDimension: 'CAMPAIGN',
      memberExternalId: TRANSITIONING,
      state: 'PROBABLY_FINE',
      exclusionReason: null,
      basis: 'OPERATOR_DECLARED',
      reason: 'Written by something that is not this repository.',
      effectiveFrom: businessDateToColumn(AUG_01),
      effectiveTo: null,
      declaredByUserId: null,
    },
  });
  const resolution = await resolve(expectations, TRANSITIONING, AUG_05);
  assert.equal(resolution.state, 'UNKNOWN');
  assert.equal(resolution.matches, 1, 'and it is counted, so a surface can say why');
});

test('19c · two declarations covering one date fail closed, with no tie-break', async () => {
  // Impossible through the repository and impossible in Postgres. Proven anyway:
  // corrupted data must not resolve confidently.
  const { prisma, expectations } = make();
  const base = {
    organizationId: ORG,
    provider: CALLGRID_PROVIDER,
    stream: CALLS_STREAM,
    memberDimension: 'CAMPAIGN',
    memberExternalId: TRANSITIONING,
    basis: 'OPERATOR_DECLARED',
    effectiveFrom: businessDateToColumn(AUG_01),
    effectiveTo: null,
    declaredByUserId: null,
  };
  await prisma.providerMemberExpectation.create({
    data: { ...base, state: 'EXPECTED', exclusionReason: null, reason: 'One statement.' },
  });
  // Straight into the table, bypassing both the repository and the constraint the
  // double enforces on `create`.
  prisma.providerMemberExpectation.__rows.push({
    ...base,
    id: 'row-conflicting',
    state: 'NOT_CONFIGURED',
    exclusionReason: null,
    reason: 'A second, contradictory statement.',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  });
  const resolution = await resolve(expectations, TRANSITIONING, AUG_05);
  assert.equal(resolution.state, 'UNKNOWN');
  assert.equal(resolution.matches, 2, 'and the operator is told which problem they have');
});

// --- 20. What may not be written -----------------------------------------------------

test('20 · an invalid interval is refused', async () => {
  const { expectations } = make();
  const empty = await expectations.declare(ORG, input({ effectiveFrom: AUG_19, effectiveTo: AUG_19 }));
  assert.equal(empty.ok, false);
  const inverted = await expectations.declare(ORG, input({ effectiveFrom: AUG_19, effectiveTo: AUG_01 }));
  assert.equal(inverted.ok, false);
  const malformed = await expectations.declare(ORG, input({ effectiveFrom: '19/08/2026' as BusinessDate }));
  assert.equal(malformed.ok, false);
});

test('20b · a declaration that is not well formed is refused with its problems named', async () => {
  const { prisma, expectations } = make();
  const noReasonForExclusion = await expectations.declare(ORG, input({ state: 'EXCLUDED' }));
  assert.equal(noReasonForExclusion.ok, false);
  if (!noReasonForExclusion.ok) {
    assert.equal(noReasonForExclusion.reason, 'INVALID_DECLARATION');
    assert.ok(noReasonForExclusion.problems.some((p) => p.includes('EXCLUDED requires a named reason')));
  }

  // An exclusion reason on a state that is not EXCLUDED is equally wrong: it
  // would read as a justification for something nobody excluded.
  const strayReason = await expectations.declare(ORG, input({ exclusionReason: 'TEST_TRAFFIC' }));
  assert.equal(strayReason.ok, false);

  const noMember = await expectations.declare(ORG, input({ memberExternalId: '   ' }));
  assert.equal(noMember.ok, false);

  const unsupportedDimension = await expectations.declare(ORG, input({ dimension: 'BUYER' }));
  assert.equal(unsupportedDimension.ok, false);

  const noWhy = await expectations.declare(ORG, input({ reason: '  ' }));
  assert.equal(noWhy.ok, false);
  if (!noWhy.ok) assert.equal(noWhy.reason, 'REASON_REQUIRED');

  assert.equal(await prisma.providerMemberExpectation.count(), 0, 'nothing was written by any of them');
});

// --- 21–22. Provenance, and the history it belongs to ------------------------------------

test('21 · who said it, why, and on what basis all survive', async () => {
  const { expectations } = make();
  const result = await expectations.declare(
    ORG,
    input({
      basis: 'PROVIDER_CONFIG_VERIFIED',
      reason: 'Checked the delivery webhook in the provider interface.',
      declaredByUserId: 'user-7',
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.declaration.basis, 'PROVIDER_CONFIG_VERIFIED');
  assert.equal(result.declaration.reason, 'Checked the delivery webhook in the provider interface.');
  assert.equal(result.declaration.declaredByUserId, 'user-7');

  const history = await expectations.declarationsFor(ORG, CALLGRID_PROVIDER, CALLS_STREAM, 'CAMPAIGN', TRANSITIONING);
  assert.equal(history[0]?.declaredByUserId, 'user-7');
  assert.equal(history[0]?.createdAt.length > 0, true);
});

test('21b · a declaration with no human actor is recorded as having none', async () => {
  // Never a stand-in identity. If no actor framework resolved a person, the
  // column says so rather than naming somebody who did not say it.
  const { expectations } = make();
  const result = await expectations.declare(ORG, input({ declaredByUserId: null }));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.declaration.declaredByUserId, null);
});

test('22 · a later declaration does not rewrite the row it succeeded', async () => {
  const { expectations } = make();
  await campaignA(expectations);
  const history = await expectations.declarationsFor(ORG, CALLGRID_PROVIDER, CALLS_STREAM, 'CAMPAIGN', TRANSITIONING);
  assert.equal(history.length, 2);

  const closed = history[0]!;
  assert.equal(closed.state, 'NOT_CONFIGURED', 'the old statement still says what it said');
  assert.equal(closed.reason, 'No delivery webhook attached at the provider.');
  assert.equal(closed.effectiveFrom, AUG_01);
  assert.equal(closed.effectiveTo, AUG_19, 'exactly one column moved: the day it stopped applying');

  const current = history[1]!;
  assert.equal(current.state, 'EXPECTED');
  assert.equal(current.effectiveFrom, AUG_19);
  assert.equal(current.effectiveTo, null);
});

test('22b · the succeeding declaration reports which one it ended', async () => {
  const { expectations } = make();
  const first = await expectations.declare(ORG, input({ state: 'NOT_CONFIGURED', reason: 'Not attached yet.' }));
  const second = await expectations.declare(ORG, input({ reason: 'Attached.', effectiveFrom: AUG_19 }));
  assert.equal(second.ok, true);
  if (!second.ok || !first.ok) return;
  assert.equal(second.supersededId, first.declaration.id);
});

// --- The discipline this table exists to keep ------------------------------------------

test('nothing here can change an expectation from observed traffic', async () => {
  // The whole point. There is exactly ONE write method, it takes no call count,
  // no event, no webhook configuration and no reconciliation result, and there is
  // no second path that could infer a state. A campaign that broke must not
  // un-expect itself the moment it stopped delivering.
  const { expectations } = make();
  // Named explicitly rather than by prefix. A prefix rule quietly absorbs the
  // next method somebody adds, which is the opposite of what this assertion is
  // for: a new method must force a decision here about whether it writes.
  const READ_ONLY = ['resolveOn', 'resolveSourceOn', 'declarationsFor', 'previewDeclaration'];
  const writes = Object.getOwnPropertyNames(ProviderMemberExpectationRepository.prototype).filter(
    (name) => name !== 'constructor' && !READ_ONLY.includes(name),
  );
  assert.deepEqual(writes, ['declare']);

  const shape = Object.keys(input());
  for (const forbidden of ['calls', 'localCalls', 'observed', 'traffic', 'events']) {
    assert.equal(shape.includes(forbidden), false, `declare() must not accept ${forbidden}`);
  }
  await expectations.declare(ORG, input());
  assert.equal((await resolve(expectations, TRANSITIONING, AUG_05)).state, 'EXPECTED');
});


// --- Previewing a declaration (the dry-run path) --------------------------------
//
// THE PROPERTY: a preview must tell the truth about the write that would follow
// it. An operator pointing a production write at a live tenant reads this to
// decide whether to proceed, so a preview that says CREATED and a write that then
// refuses would be worse than having no preview at all.
//
// The guarantee is structural rather than tested case by case: `previewDeclaration`
// and `declare` call the SAME shape check and the SAME decision function. These
// pin that they agree, and that the preview writes nothing while doing it.

test('a preview of a fresh member reports CREATED and writes nothing', async () => {
  const { prisma, expectations } = make();
  const result = await expectations.previewDeclaration(ORG, input());
  assert.equal(result.outcome, 'CREATED');
  assert.equal(result.effectiveNow, null);
  assert.equal(result.supersedes, null);
  assert.equal(prisma.providerMemberExpectation.__rows.length, 0);
});

test('a preview reports the declaration in force on the date it asks about', async () => {
  const { expectations } = make();
  await expectations.declare(ORG, input({ state: 'NOT_CONFIGURED', effectiveFrom: AUG_01 }));
  const result = await expectations.previewDeclaration(
    ORG,
    input({ state: 'EXPECTED', effectiveFrom: AUG_19 }),
  );
  assert.equal(result.outcome, 'CREATED');
  assert.equal(result.effectiveNow?.state, 'NOT_CONFIGURED');
  // And names what the write would END, which is the thing an operator most
  // needs to see before agreeing to it.
  assert.equal(result.supersedes?.state, 'NOT_CONFIGURED');
});

test('a preview of an identical declaration reports ALREADY_EQUIVALENT', async () => {
  const { prisma, expectations } = make();
  await expectations.declare(ORG, input());
  const before = prisma.providerMemberExpectation.__rows.length;
  const result = await expectations.previewDeclaration(ORG, input());
  assert.equal(result.outcome, 'ALREADY_EQUIVALENT');
  assert.equal(prisma.providerMemberExpectation.__rows.length, before);
});

test('a preview of an overlap reports BLOCKED and names the reason declare would give', async () => {
  const { expectations } = make();
  await expectations.declare(ORG, input({ effectiveFrom: AUG_19 }));
  const result = await expectations.previewDeclaration(
    ORG,
    input({ state: 'NOT_CONFIGURED', effectiveFrom: AUG_19 }),
  );
  assert.equal(result.outcome, 'BLOCKED');
  assert.equal(result.reason, 'OVERLAPS_EXISTING');
  assert.match(result.problems.join(' '), /already starts on/);
});

test('a preview of a malformed declaration reports BLOCKED with the same rejection declare uses', async () => {
  const { expectations } = make();
  const invalid = await expectations.previewDeclaration(
    ORG,
    input({ state: 'EXCLUDED', exclusionReason: null }),
  );
  assert.equal(invalid.outcome, 'BLOCKED');
  assert.equal(invalid.reason, 'INVALID_DECLARATION');

  const unexplained = await expectations.previewDeclaration(ORG, input({ reason: '   ' }));
  assert.equal(unexplained.outcome, 'BLOCKED');
  assert.equal(unexplained.reason, 'REASON_REQUIRED');
});

test('the preview and the write always agree — the same decision, asked twice', async () => {
  // Driven over every shape that matters rather than asserted once: a fresh
  // member, an identical restatement, a legitimate successor, and an overlap.
  const cases: Array<{ name: string; setup: DeclareExpectationInput[]; candidate: DeclareExpectationInput }> = [
    { name: 'fresh', setup: [], candidate: input() },
    { name: 'identical', setup: [input()], candidate: input() },
    {
      name: 'successor',
      setup: [input({ state: 'NOT_CONFIGURED', effectiveFrom: AUG_01 })],
      candidate: input({ state: 'EXPECTED', effectiveFrom: AUG_19 }),
    },
    {
      name: 'overlap',
      setup: [input({ effectiveFrom: AUG_19 })],
      candidate: input({ state: 'NOT_CONFIGURED', effectiveFrom: AUG_19 }),
    },
  ];

  for (const testCase of cases) {
    const { expectations } = make();
    for (const seed of testCase.setup) await expectations.declare(ORG, seed);
    const preview = await expectations.previewDeclaration(ORG, testCase.candidate);
    const write = await expectations.declare(ORG, testCase.candidate);

    if (preview.outcome === 'BLOCKED') {
      assert.equal(write.ok, false, `${testCase.name}: preview said BLOCKED so the write must refuse`);
      if (!write.ok) assert.equal(write.reason, preview.reason);
    } else if (preview.outcome === 'ALREADY_EQUIVALENT') {
      assert.equal(write.ok, true);
      if (write.ok) assert.equal(write.unchanged, true, `${testCase.name}: preview said nothing would change`);
    } else {
      assert.equal(write.ok, true);
      if (write.ok) {
        assert.equal(write.unchanged, false, `${testCase.name}: preview said CREATED`);
        assert.equal(
          write.supersededId,
          preview.supersedes?.id ?? null,
          `${testCase.name}: the preview named the wrong predecessor`,
        );
      }
    }
  }
});

test('a preview cannot see another organization\'s declarations', async () => {
  const { expectations } = make();
  await expectations.declare(OTHER_ORG, input());
  const result = await expectations.previewDeclaration(ORG, input());
  // The other tenant's identical declaration is invisible, so this reads as a
  // fresh member rather than as an equivalent restatement.
  assert.equal(result.outcome, 'CREATED');
  assert.equal(result.effectiveNow, null);
});
