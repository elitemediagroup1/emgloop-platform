// Tests for the Stage 3 production bootstrap bridge.
//
// WHAT THESE PROVE, AND WHY IN THIS SHAPE
//
// This runner is the only path that writes MORE THAN ONE declaration in a single
// dispatch, so the tests spend most of their effort on the two properties that
// buys it the right to exist: that one bad entry writes nothing at all, and that
// it decides nothing a human did not write in the plan. The boundaries are
// proved by reading the runner's and the workflow's own source, because a
// comment saying "it cannot register a source" is not a property and those are.
//
// The fakes implement real effective-dating -- half-open ranges, supersession,
// overlap refusal, equivalence -- through `decideEffectiveDatedWrite`, the same
// function both repositories use, because a fake that let preflight and write
// disagree would assume away exactly the property the preflight exists to
// provide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideEffectiveDatedWrite } from '@emgloop/shared';
import type { BindingDimension, MeasureMetric } from '@emgloop/shared';
import type {
  AuthorityDeclarationPreview,
  AuthorityDeclarationView,
  DeclarationPreview,
  DeclareAuthorityInput,
  DeclareAuthorityResult,
  DeclareResult,
  ExpectationDeclarationView,
} from '@emgloop/database';

import type { DeclareInput } from './declare-member-expectations';
import {
  entryProblems,
  parseArgs,
  parsePlan,
  planConflicts,
  readEnvironment,
  runBootstrap,
  type BootstrapPlan,
  type RunDeps,
} from './bootstrap-stage3-production';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_SOURCE = readFileSync(join(HERE, 'bootstrap-stage3-production.ts'), 'utf8');
const WORKFLOW_SOURCE = readFileSync(
  join(HERE, '..', '..', '.github', 'workflows', 'bootstrap-stage3-production.yml'),
  'utf8',
);

// The runner with its `//` prose removed. The "must not reference" checks below
// are about CODE, and a header sentence saying the runner reads no webhook
// configuration must not read as the runner reaching a webhook.
const RUNNER_CODE = RUNNER_SOURCE.split('\n')
  .filter((l) => !l.trimStart().startsWith('//'))
  .join('\n');

// The workflow with its `#` prose removed. The "must not offer" checks below are
// about INPUTS, and a header sentence explaining what the job cannot do must not
// read as an input.
const WORKFLOW_INPUTS = WORKFLOW_SOURCE.split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n');

const ORG = { id: 'org_1', slug: 'fixture-org', name: 'Fixture Org', status: 'ACTIVE' };
const CAMPAIGN_A = 'campaign-fixture-a';
const CAMPAIGN_B = 'campaign-fixture-b';
const MEMBER_A = 'member-fixture-a';
const STREAM_KEY = 'stream-fixture';
const REPORT_KEY = 'report-fixture';
const FROM = '2026-08-05';

// --- Plan fixtures ----------------------------------------------------------------

function expectationEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaignId: CAMPAIGN_A,
    state: 'EXPECTED',
    basis: 'PROVIDER_CONFIG_VERIFIED',
    reason: 'The webhook is attached and records have been arriving since this date.',
    effectiveFrom: FROM,
    effectiveTo: null,
    exclusionReason: null,
    ...over,
  };
}

function authorityEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dimension: 'CAMPAIGN',
    memberExternalId: MEMBER_A,
    metric: 'CALL_VOLUME',
    sourceKey: STREAM_KEY,
    reason: 'The provider stream is the only record of how many calls arrived.',
    effectiveFrom: FROM,
    effectiveTo: null,
    ...over,
  };
}

function planJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    organizationSlug: ORG.slug,
    expectations: [expectationEntry()],
    authorities: [authorityEntry()],
    ...over,
  });
}

// --- Fakes with real effective-dating ---------------------------------------------

interface ExpectationRow {
  id: string;
  memberExternalId: string;
  state: string;
  exclusionReason: string | null;
  basis: string;
  reason: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  declaredByUserId: string | null;
}

interface AuthorityRow {
  id: string;
  dimension: string;
  memberExternalId: string;
  metric: string;
  sourceKey: string;
  reason: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  declaredByUserId: string | null;
}

/** Which sources this fake organization has registered, and what they support. */
const REGISTERED: Record<string, MeasureMetric[]> = {
  [STREAM_KEY]: ['CALL_VOLUME'],
  [REPORT_KEY]: ['REVENUE'],
};

interface Harness {
  deps: RunDeps;
  lines: string[];
  expectationRows: ExpectationRow[];
  authorityRows: AuthorityRow[];
  expectationWrites: () => number;
  authorityWrites: () => number;
}

function makeDeps(
  over: Partial<RunDeps> = {},
  members = [{ id: 'u_1', email: 'someone@example.com', status: 'ACTIVE' }],
): Harness {
  const lines: string[] = [];
  const expectationRows: ExpectationRow[] = [];
  const authorityRows: AuthorityRow[] = [];
  let seq = 0;
  let expectationWrites = 0;
  let authorityWrites = 0;

  const expectationView = (r: ExpectationRow): ExpectationDeclarationView =>
    ({
      id: r.id,
      provider: 'provider-fixture',
      stream: 'stream',
      dimension: 'CAMPAIGN',
      memberExternalId: r.memberExternalId,
      state: r.state,
      exclusionReason: r.exclusionReason,
      basis: r.basis,
      reason: r.reason,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      declaredByUserId: r.declaredByUserId,
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
    }) as unknown as ExpectationDeclarationView;

  const authorityView = (r: AuthorityRow): AuthorityDeclarationView =>
    ({
      id: r.id,
      dimension: r.dimension as BindingDimension,
      memberExternalId: r.memberExternalId,
      metric: r.metric as MeasureMetric,
      sourceKey: r.sourceKey,
      reason: r.reason,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      declaredByUserId: r.declaredByUserId,
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
    }) as unknown as AuthorityDeclarationView;

  const expectationDecision = (input: DeclareInput) =>
    decideEffectiveDatedWrite(
      expectationRows.filter((r) => r.memberExternalId === input.memberExternalId.trim()),
      { effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null },
      (r) => ({ effectiveFrom: r.effectiveFrom as never, effectiveTo: r.effectiveTo as never }),
      (r) =>
        r.state === input.state &&
        r.exclusionReason === (input.exclusionReason ?? null) &&
        r.basis === input.basis,
    );

  const expectationInForce = (input: DeclareInput) =>
    expectationRows.find(
      (r) =>
        r.memberExternalId === input.memberExternalId.trim() &&
        input.effectiveFrom >= r.effectiveFrom &&
        (r.effectiveTo === null || input.effectiveFrom < r.effectiveTo),
    ) ?? null;

  const expectations = {
    async previewDeclaration(_o: string, input: DeclareInput): Promise<DeclarationPreview> {
      const decision = expectationDecision(input);
      const now = expectationInForce(input);
      if (decision.kind === 'BLOCKED') {
        return {
          outcome: 'BLOCKED',
          effectiveNow: now ? expectationView(now) : null,
          supersedes: null,
          reason: 'OVERLAPS_EXISTING',
          problems: decision.problems,
        };
      }
      if (decision.kind === 'EQUIVALENT') {
        return {
          outcome: 'ALREADY_EQUIVALENT',
          effectiveNow: expectationView(decision.row),
          supersedes: null,
          reason: null,
          problems: [],
        };
      }
      return {
        outcome: 'CREATED',
        effectiveNow: now ? expectationView(now) : null,
        supersedes: decision.predecessor ? expectationView(decision.predecessor) : null,
        reason: null,
        problems: [],
      };
    },
    async declare(_o: string, input: DeclareInput): Promise<DeclareResult> {
      expectationWrites += 1;
      const decision = expectationDecision(input);
      if (decision.kind === 'BLOCKED') {
        return { ok: false, reason: 'OVERLAPS_EXISTING', problems: decision.problems };
      }
      if (decision.kind === 'EQUIVALENT') {
        return {
          ok: true,
          declaration: expectationView(decision.row),
          supersededId: null,
          unchanged: true,
        };
      }
      if (decision.predecessor) decision.predecessor.effectiveTo = input.effectiveFrom;
      seq += 1;
      const row: ExpectationRow = {
        id: `exp_${seq}`,
        memberExternalId: input.memberExternalId.trim(),
        state: input.state,
        exclusionReason: input.exclusionReason ?? null,
        basis: input.basis,
        reason: input.reason.trim(),
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        declaredByUserId: input.declaredByUserId ?? null,
      };
      expectationRows.push(row);
      return {
        ok: true,
        declaration: expectationView(row),
        supersededId: decision.predecessor?.id ?? null,
        unchanged: false,
      };
    },
    async declarationsFor(_o: string, _p: string, _s: string, _d: 'CAMPAIGN', member: string) {
      return expectationRows.filter((r) => r.memberExternalId === member).map(expectationView);
    },
  };

  const authorityPrecheck = (
    input: DeclareAuthorityInput,
  ): { reason: 'SOURCE_NOT_REGISTERED' | 'SOURCE_DOES_NOT_SUPPORT_METRIC'; problems: string[] } | null => {
    const supported = REGISTERED[input.sourceKey.trim()];
    if (!supported) {
      return { reason: 'SOURCE_NOT_REGISTERED', problems: ['no source is registered under that key'] };
    }
    if (!supported.includes(input.metric)) {
      return {
        reason: 'SOURCE_DOES_NOT_SUPPORT_METRIC',
        problems: [`that source declares no definition for ${input.metric}`],
      };
    }
    return null;
  };

  const authorityMatching = (input: DeclareAuthorityInput) =>
    authorityRows.filter(
      (r) =>
        r.dimension === input.dimension &&
        r.memberExternalId === input.memberExternalId.trim() &&
        r.metric === input.metric,
    );

  const authorityDecision = (input: DeclareAuthorityInput) =>
    decideEffectiveDatedWrite(
      authorityMatching(input),
      { effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null },
      (r) => ({ effectiveFrom: r.effectiveFrom as never, effectiveTo: r.effectiveTo as never }),
      (r) => r.sourceKey === input.sourceKey.trim(),
    );

  const authorityInForce = (input: DeclareAuthorityInput) =>
    authorityMatching(input).find(
      (r) =>
        input.effectiveFrom >= r.effectiveFrom && (r.effectiveTo === null || input.effectiveFrom < r.effectiveTo),
    ) ?? null;

  const authorities = {
    async previewAuthorityDeclaration(
      _o: string,
      input: DeclareAuthorityInput,
    ): Promise<AuthorityDeclarationPreview> {
      const bad = authorityPrecheck(input);
      if (bad) {
        return { outcome: 'BLOCKED', effectiveNow: null, supersedes: null, reason: bad.reason, problems: bad.problems };
      }
      const decision = authorityDecision(input);
      const now = authorityInForce(input);
      if (decision.kind === 'BLOCKED') {
        return {
          outcome: 'BLOCKED',
          effectiveNow: now ? authorityView(now) : null,
          supersedes: null,
          reason: 'OVERLAPS_EXISTING',
          problems: decision.problems,
        };
      }
      if (decision.kind === 'EQUIVALENT') {
        return {
          outcome: 'ALREADY_EQUIVALENT',
          effectiveNow: authorityView(decision.row),
          supersedes: null,
          reason: null,
          problems: [],
        };
      }
      return {
        outcome: decision.predecessor ? 'WOULD_SUPERSEDE' : 'WOULD_CREATE',
        effectiveNow: now ? authorityView(now) : null,
        supersedes: decision.predecessor ? authorityView(decision.predecessor) : null,
        reason: null,
        problems: [],
      };
    },
    async declareAuthority(_o: string, input: DeclareAuthorityInput): Promise<DeclareAuthorityResult> {
      authorityWrites += 1;
      const bad = authorityPrecheck(input);
      if (bad) return { ok: false, reason: bad.reason, problems: bad.problems };
      const decision = authorityDecision(input);
      if (decision.kind === 'BLOCKED') {
        return { ok: false, reason: 'OVERLAPS_EXISTING', problems: decision.problems };
      }
      if (decision.kind === 'EQUIVALENT') {
        return { ok: true, declaration: authorityView(decision.row), supersededId: null, unchanged: true };
      }
      if (decision.predecessor) decision.predecessor.effectiveTo = input.effectiveFrom;
      seq += 1;
      const row: AuthorityRow = {
        id: `auth_${seq}`,
        dimension: input.dimension,
        memberExternalId: input.memberExternalId.trim(),
        metric: input.metric,
        sourceKey: input.sourceKey.trim(),
        reason: input.reason.trim(),
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        declaredByUserId: input.declaredByUserId ?? null,
      };
      authorityRows.push(row);
      return {
        ok: true,
        declaration: authorityView(row),
        supersededId: decision.predecessor?.id ?? null,
        unchanged: false,
      };
    },
    async authoritiesFor(_o: string, dimension: BindingDimension, member: string, metric: MeasureMetric) {
      return authorityRows
        .filter((r) => r.dimension === dimension && r.memberExternalId === member && r.metric === metric)
        .map(authorityView);
    },
  };

  const deps: RunDeps = {
    expectations,
    authorities,
    organizations: {
      async findBySlug(slug: string) {
        return slug === ORG.slug ? ORG : null;
      },
    },
    directory: {
      async listUsers() {
        return members;
      },
    },
    log: (l: string) => lines.push(l),
    ...over,
  };

  return {
    deps,
    lines,
    expectationRows,
    authorityRows,
    expectationWrites: () => expectationWrites,
    authorityWrites: () => authorityWrites,
  };
}

function summaryOf(lines: readonly string[]): string {
  return lines.find((l) => l.includes('event=PLAN_SUMMARY')) ?? '';
}

function completionOf(lines: readonly string[]): string {
  return lines.find((l) => l.includes('event=RUN_COMPLETE')) ?? '';
}

// === 1-5, 9-19: the plan is refused before anything is resolved ===================

test('1. malformed plan JSON is rejected', async () => {
  const { deps, expectationWrites, authorityWrites } = makeDeps();
  const result = await runBootstrap({ planJson: '{not json', declarerEmail: null, dryRun: true }, deps);
  assert.equal(result.overall, 'FAILED_PRECONDITION');
  assert.equal(expectationWrites(), 0);
  assert.equal(authorityWrites(), 0);
});

test('2. an unknown organization is rejected', async () => {
  const { deps, expectationWrites } = makeDeps();
  const result = await runBootstrap(
    { planJson: planJson({ organizationSlug: 'no-such-org' }), declarerEmail: null, dryRun: false },
    deps,
  );
  assert.equal(result.overall, 'FAILED_PRECONDITION');
  assert.ok(result.problems.some((p) => p.includes('No organization with slug')));
  assert.equal(expectationWrites(), 0);
});

test('2b. a suspended or canceled organization is refused', async () => {
  for (const status of ['SUSPENDED', 'CANCELED']) {
    const { deps } = makeDeps({
      organizations: { async findBySlug() { return { ...ORG, status }; } },
    });
    const result = await runBootstrap({ planJson: planJson(), declarerEmail: null, dryRun: false }, deps);
    assert.equal(result.overall, 'FAILED_PRECONDITION');
  }
});

test('3. an unresolved declarer stops the whole run', async () => {
  const { deps, expectationWrites, authorityWrites } = makeDeps();
  const result = await runBootstrap(
    { planJson: planJson(), declarerEmail: 'nobody@example.com', dryRun: false },
    deps,
  );
  assert.equal(result.overall, 'FAILED_PRECONDITION');
  assert.equal(expectationWrites(), 0);
  assert.equal(authorityWrites(), 0);
});

test('4. an ambiguous declarer stops the whole run', async () => {
  const { deps } = makeDeps({}, [
    { id: 'u_1', email: 'shared@example.com', status: 'ACTIVE' },
    { id: 'u_2', email: 'SHARED@example.com', status: 'ACTIVE' },
  ]);
  const result = await runBootstrap(
    { planJson: planJson(), declarerEmail: 'shared@example.com', dryRun: false },
    deps,
  );
  assert.equal(result.overall, 'FAILED_PRECONDITION');
});

test('4b. the declarer email is never echoed into the log', async () => {
  const { deps, lines } = makeDeps();
  await runBootstrap({ planJson: planJson(), declarerEmail: 'someone@example.com', dryRun: true }, deps);
  assert.ok(!lines.join('\n').includes('someone@example.com'));
  assert.ok(lines.some((l) => l.includes('declarer=resolved')));
});

test('5. an empty plan is rejected rather than reported as a success', async () => {
  const { deps } = makeDeps();
  for (const empty of [
    JSON.stringify({ organizationSlug: ORG.slug, expectations: [], authorities: [] }),
    JSON.stringify({ organizationSlug: ORG.slug }),
  ]) {
    const result = await runBootstrap({ planJson: empty, declarerEmail: null, dryRun: true }, deps);
    assert.equal(result.overall, 'FAILED_PRECONDITION');
  }
});

test('5b. a plan that is not an object, and an unrecognised field, are refused', () => {
  assert.equal(parsePlan('[]').ok, false);
  assert.equal(parsePlan('"a string"').ok, false);
  const typo = parsePlan(
    JSON.stringify({ organizationSlug: ORG.slug, expectations: [expectationEntry({ exclusion_reason: 'TEST_TRAFFIC' })] }),
  );
  assert.equal(typo.ok, false);
  // A misspelled key must not read as "none supplied".
  assert.ok(!typo.ok && typo.problems.some((p) => p.includes('unrecognised field')));
});

// === 6-8: the three legitimate plan shapes ========================================

test('6. an expectation-only plan is accepted', async () => {
  const { deps, expectationRows, authorityWrites } = makeDeps();
  const result = await runBootstrap(
    {
      planJson: JSON.stringify({ organizationSlug: ORG.slug, expectations: [expectationEntry()] }),
      declarerEmail: null,
      dryRun: false,
    },
    deps,
  );
  assert.equal(result.overall, 'APPLIED');
  assert.equal(expectationRows.length, 1);
  assert.equal(authorityWrites(), 0);
});

test('7. an authority-only plan is accepted', async () => {
  const { deps, authorityRows, expectationWrites } = makeDeps();
  const result = await runBootstrap(
    {
      planJson: JSON.stringify({ organizationSlug: ORG.slug, authorities: [authorityEntry()] }),
      declarerEmail: null,
      dryRun: false,
    },
    deps,
  );
  assert.equal(result.overall, 'APPLIED');
  assert.equal(authorityRows.length, 1);
  assert.equal(expectationWrites(), 0);
});

test('8. a mixed plan is accepted, and each section is independent', async () => {
  const { deps, expectationRows, authorityRows } = makeDeps();
  const result = await runBootstrap({ planJson: planJson(), declarerEmail: null, dryRun: false }, deps);
  assert.equal(result.overall, 'APPLIED');
  assert.equal(expectationRows.length, 1);
  assert.equal(authorityRows.length, 1);
});

test('8b. EXPECTED never creates an authority, and an authority never creates EXPECTED', async () => {
  const expectationOnly = makeDeps();
  await runBootstrap(
    {
      planJson: JSON.stringify({ organizationSlug: ORG.slug, expectations: [expectationEntry()] }),
      declarerEmail: null,
      dryRun: false,
    },
    expectationOnly.deps,
  );
  assert.equal(expectationOnly.authorityRows.length, 0);

  const authorityOnly = makeDeps();
  await runBootstrap(
    {
      planJson: JSON.stringify({ organizationSlug: ORG.slug, authorities: [authorityEntry()] }),
      declarerEmail: null,
      dryRun: false,
    },
    authorityOnly.deps,
  );
  assert.equal(authorityOnly.expectationRows.length, 0);
});

// === 9-15: per-entry validation, borrowed from the shipped bridges ================

const REJECTED_ENTRIES: Array<[string, BootstrapPlan]> = [
  ['9. invalid expectation state', { organizationSlug: ORG.slug, expectations: [expectationEntry({ state: 'PROBABLY' })] as never, authorities: [] }],
  ['9b. invalid expectation basis', { organizationSlug: ORG.slug, expectations: [expectationEntry({ basis: 'A_HUNCH' })] as never, authorities: [] }],
  ['10. EXCLUDED without an exclusion reason', { organizationSlug: ORG.slug, expectations: [expectationEntry({ state: 'EXCLUDED' })] as never, authorities: [] }],
  ['10b. an exclusion reason on a state that forbids one', { organizationSlug: ORG.slug, expectations: [expectationEntry({ exclusionReason: 'TEST_TRAFFIC' })] as never, authorities: [] }],
  ['10c. an unrecognised exclusion reason', { organizationSlug: ORG.slug, expectations: [expectationEntry({ state: 'EXCLUDED', exclusionReason: 'BECAUSE' })] as never, authorities: [] }],
  ['11. invalid authority dimension', { organizationSlug: ORG.slug, expectations: [], authorities: [authorityEntry({ dimension: 'REGION' })] as never }],
  ['12. invalid authority metric', { organizationSlug: ORG.slug, expectations: [], authorities: [authorityEntry({ metric: 'PROFIT' })] as never }],
  ['15. malformed effective-from', { organizationSlug: ORG.slug, expectations: [expectationEntry({ effectiveFrom: '05/08/2026' })] as never, authorities: [] }],
  ['15b. malformed effective-to', { organizationSlug: ORG.slug, expectations: [], authorities: [authorityEntry({ effectiveTo: 'next week' })] as never }],
  ['15c. effective-to not strictly after effective-from', { organizationSlug: ORG.slug, expectations: [], authorities: [authorityEntry({ effectiveTo: FROM })] as never }],
  ['15d. a blank member id', { organizationSlug: ORG.slug, expectations: [expectationEntry({ campaignId: '   ' })] as never, authorities: [] }],
  ['15e. a blank reason', { organizationSlug: ORG.slug, expectations: [], authorities: [authorityEntry({ reason: '  ' })] as never }],
  ['15f. a blank source key', { organizationSlug: ORG.slug, expectations: [], authorities: [authorityEntry({ sourceKey: '' })] as never }],
];

for (const [label, plan] of REJECTED_ENTRIES) {
  test(`${label} is rejected before any production call`, async () => {
    assert.ok(entryProblems(plan).length > 0, 'the entry must be judged unacceptable');
    const { deps, expectationWrites, authorityWrites } = makeDeps();
    const result = await runBootstrap(
      { planJson: JSON.stringify(plan), declarerEmail: null, dryRun: false },
      deps,
    );
    assert.equal(result.overall, 'FAILED_PRECONDITION');
    assert.equal(expectationWrites(), 0);
    assert.equal(authorityWrites(), 0);
  });
}

// === 13-14: the source facts are the repository's, not the runner's ===============

test('13. a source that is not registered blocks the run, and the runner asks the repository', async () => {
  const { deps, expectationWrites, authorityWrites, lines } = makeDeps();
  const result = await runBootstrap(
    {
      planJson: JSON.stringify({
        organizationSlug: ORG.slug,
        expectations: [expectationEntry()],
        authorities: [authorityEntry({ sourceKey: 'never-registered' })],
      }),
      declarerEmail: null,
      dryRun: false,
    },
    deps,
  );
  assert.equal(result.overall, 'BLOCKED');
  assert.ok(lines.some((l) => l.includes('reason=SOURCE_NOT_REGISTERED')));
  // The clean expectation ahead of it is NOT written.
  assert.equal(expectationWrites(), 0);
  assert.equal(authorityWrites(), 0);
});

test('14. a metric the source does not declare blocks the run', async () => {
  const { deps, lines, authorityWrites } = makeDeps();
  const result = await runBootstrap(
    {
      planJson: JSON.stringify({
        organizationSlug: ORG.slug,
        authorities: [authorityEntry({ sourceKey: REPORT_KEY, metric: 'CALL_VOLUME' })],
      }),
      declarerEmail: null,
      dryRun: false,
    },
    deps,
  );
  assert.equal(result.overall, 'BLOCKED');
  assert.ok(lines.some((l) => l.includes('reason=SOURCE_DOES_NOT_SUPPORT_METRIC')));
  assert.equal(authorityWrites(), 0);
});

// === 16-19: contradictions WITHIN the plan ========================================

test('16. the same expectation stated twice is rejected', () => {
  const problems = planConflicts({
    organizationSlug: ORG.slug,
    expectations: [expectationEntry(), expectationEntry()] as never,
    authorities: [],
  });
  assert.ok(problems.some((p) => p.includes('stated twice')));
});

test('17. the same authority stated twice is rejected', () => {
  const problems = planConflicts({
    organizationSlug: ORG.slug,
    expectations: [],
    authorities: [authorityEntry(), authorityEntry()] as never,
  });
  assert.ok(problems.some((p) => p.includes('stated twice')));
});

test('18. contradictory expectations over the same effective range are rejected', async () => {
  const plan = {
    organizationSlug: ORG.slug,
    expectations: [expectationEntry(), expectationEntry({ state: 'NOT_CONFIGURED' })],
    authorities: [],
  };
  assert.ok(planConflicts(plan as never).some((p) => p.includes('contradictory')));
  const { deps, expectationWrites } = makeDeps();
  const result = await runBootstrap({ planJson: JSON.stringify(plan), declarerEmail: null, dryRun: false }, deps);
  assert.equal(result.overall, 'FAILED_PRECONDITION');
  assert.equal(expectationWrites(), 0);
});

test('19. conflicting authorities over the same effective range are rejected', async () => {
  const plan = {
    organizationSlug: ORG.slug,
    expectations: [],
    authorities: [authorityEntry(), authorityEntry({ sourceKey: REPORT_KEY })],
  };
  assert.ok(planConflicts(plan as never).some((p) => p.includes('conflicting')));
  const { deps, authorityWrites } = makeDeps();
  const result = await runBootstrap({ planJson: JSON.stringify(plan), declarerEmail: null, dryRun: false }, deps);
  assert.equal(result.overall, 'FAILED_PRECONDITION');
  assert.equal(authorityWrites(), 0);
});

test('19b. a successor inside the same plan is refused, because the preflight cannot see its own write', () => {
  const problems = planConflicts({
    organizationSlug: ORG.slug,
    expectations: [
      expectationEntry({ effectiveTo: '2026-09-01' }),
      expectationEntry({ state: 'NOT_CONFIGURED', effectiveFrom: '2026-09-01' }),
    ] as never,
    authorities: [],
  });
  assert.equal(problems.length, 1);
  assert.ok(problems[0]!.includes('cannot see its own earlier write'));
});

test('19c. entries about DIFFERENT subjects never conflict', () => {
  assert.deepEqual(
    planConflicts({
      organizationSlug: ORG.slug,
      expectations: [expectationEntry(), expectationEntry({ campaignId: CAMPAIGN_B, state: 'NOT_CONFIGURED' })] as never,
      authorities: [authorityEntry(), authorityEntry({ sourceKey: REPORT_KEY, metric: 'REVENUE' })] as never,
    }),
    [],
  );
});

// === 20-23: the preflight ========================================================

test('20. one blocked entry causes ZERO writes, including the entries around it', async () => {
  const { deps, expectationWrites, authorityWrites, expectationRows, authorityRows } = makeDeps();
  const result = await runBootstrap(
    {
      planJson: JSON.stringify({
        organizationSlug: ORG.slug,
        expectations: [expectationEntry(), expectationEntry({ campaignId: CAMPAIGN_B })],
        authorities: [authorityEntry(), authorityEntry({ memberExternalId: 'other', sourceKey: 'never-registered' })],
      }),
      declarerEmail: null,
      dryRun: false,
    },
    deps,
  );
  assert.equal(result.overall, 'BLOCKED');
  assert.equal(result.failedIndex, 'AUTHORITY[2]');
  assert.equal(expectationWrites(), 0);
  assert.equal(authorityWrites(), 0);
  assert.equal(expectationRows.length, 0);
  assert.equal(authorityRows.length, 0);
});

test('21. a dry run writes nothing and calls neither mutating method', async () => {
  const { deps, expectationWrites, authorityWrites, lines } = makeDeps();
  const result = await runBootstrap({ planJson: planJson(), declarerEmail: null, dryRun: true }, deps);
  assert.equal(result.overall, 'READY_TO_APPLY');
  assert.equal(expectationWrites(), 0);
  assert.equal(authorityWrites(), 0);
  assert.ok(completionOf(lines).includes('WRITTEN=false'));
  assert.ok(completionOf(lines).includes('OVERALL_RESULT=READY_TO_APPLY'));
});

test('22. a dry run previews EVERY entry, with its own index and the full summary', async () => {
  const { deps, lines } = makeDeps();
  await runBootstrap(
    {
      planJson: JSON.stringify({
        organizationSlug: ORG.slug,
        expectations: [expectationEntry(), expectationEntry({ campaignId: CAMPAIGN_B, state: 'NOT_CONFIGURED' })],
        authorities: [authorityEntry()],
      }),
      declarerEmail: null,
      dryRun: true,
    },
    deps,
  );
  for (const label of ['EXPECTATION[1]', 'EXPECTATION[2]', 'AUTHORITY[1]']) {
    assert.ok(lines.some((l) => l.startsWith(`entry=${label} `)), `${label} must have its own line`);
  }
  for (const field of ['type=', 'state=', 'effectiveFrom=', 'effectiveTo=', 'wouldBe=', 'existingId=', 'supersedes=', 'reason=']) {
    assert.ok(lines.some((l) => l.includes('type=EXPECTATION') && l.includes(field)), `an expectation line must carry ${field}`);
  }
  for (const field of ['dimension=', 'member=', 'metric=', 'sourceKey=', 'wouldBe=', 'existingId=', 'supersedes=']) {
    assert.ok(lines.some((l) => l.includes('type=AUTHORITY') && l.includes(field)), `an authority line must carry ${field}`);
  }
  const summary = summaryOf(lines);
  for (const token of [
    'EXPECTATIONS_REQUESTED=2',
    'EXPECTATIONS_CREATE=2',
    'EXPECTATIONS_EQUIVALENT=0',
    'EXPECTATIONS_SUPERSEDE=0',
    'EXPECTATIONS_BLOCKED=0',
    'AUTHORITIES_REQUESTED=1',
    'AUTHORITIES_CREATE=1',
    'AUTHORITIES_EQUIVALENT=0',
    'AUTHORITIES_SUPERSEDE=0',
    'AUTHORITIES_BLOCKED=0',
  ]) {
    assert.ok(summary.includes(token), `the summary must report ${token}`);
  }
});

test('23. a real run previews everything BEFORE the first write', async () => {
  const order: string[] = [];
  const base = makeDeps();
  const deps: RunDeps = {
    ...base.deps,
    expectations: {
      ...base.deps.expectations,
      async previewDeclaration(o, i) {
        order.push('preview:expectation');
        return base.deps.expectations.previewDeclaration(o, i);
      },
      async declare(o, i) {
        order.push('write:expectation');
        return base.deps.expectations.declare(o, i);
      },
    },
    authorities: {
      ...base.deps.authorities,
      async previewAuthorityDeclaration(o, i) {
        order.push('preview:authority');
        return base.deps.authorities.previewAuthorityDeclaration(o, i);
      },
      async declareAuthority(o, i) {
        order.push('write:authority');
        return base.deps.authorities.declareAuthority(o, i);
      },
    },
  };
  await runBootstrap(
    {
      planJson: JSON.stringify({
        organizationSlug: ORG.slug,
        expectations: [expectationEntry(), expectationEntry({ campaignId: CAMPAIGN_B })],
        authorities: [authorityEntry()],
      }),
      declarerEmail: null,
      dryRun: false,
    },
    deps,
  );
  const firstWrite = order.findIndex((o) => o.startsWith('write:'));
  const lastPreview = order.map((o) => o.startsWith('preview:')).lastIndexOf(true);
  assert.ok(firstWrite > lastPreview, `every preview must precede every write: ${order.join(',')}`);
});

// === 24-31: writing, equivalence, supersession and readback ======================

test('24. an equivalent expectation writes nothing', async () => {
  const h = makeDeps();
  await runBootstrap({ planJson: planJson(), declarerEmail: null, dryRun: false }, h.deps);
  const before = h.expectationRows.length;
  const second = await runBootstrap({ planJson: planJson(), declarerEmail: null, dryRun: false }, h.deps);
  assert.equal(h.expectationRows.length, before);
  assert.equal(second.writtenCount, 0);
  assert.ok(h.lines.some((l) => l.includes('entry=EXPECTATION[1]') && l.includes('result=ALREADY_EQUIVALENT')));
});

test('25. an equivalent authority writes nothing', async () => {
  const h = makeDeps();
  await runBootstrap({ planJson: planJson(), declarerEmail: null, dryRun: false }, h.deps);
  const before = h.authorityRows.length;
  await runBootstrap({ planJson: planJson(), declarerEmail: null, dryRun: false }, h.deps);
  assert.equal(h.authorityRows.length, before);
});

test('26/27. a fresh plan reaches the shipped write methods, once per entry', async () => {
  const h = makeDeps();
  const result = await runBootstrap({ planJson: planJson(), declarerEmail: null, dryRun: false }, h.deps);
  assert.equal(result.overall, 'APPLIED');
  assert.equal(h.expectationWrites(), 1);
  assert.equal(h.authorityWrites(), 1);
  assert.equal(result.writtenCount, 2);
});

test('28. a legitimate expectation successor supersedes rather than duplicating', async () => {
  const h = makeDeps();
  await runBootstrap(
    {
      planJson: JSON.stringify({ organizationSlug: ORG.slug, expectations: [expectationEntry()] }),
      declarerEmail: null,
      dryRun: false,
    },
    h.deps,
  );
  const result = await runBootstrap(
    {
      planJson: JSON.stringify({
        organizationSlug: ORG.slug,
        expectations: [expectationEntry({ state: 'NOT_CONFIGURED', effectiveFrom: '2026-09-01' })],
      }),
      declarerEmail: null,
      dryRun: false,
    },
    h.deps,
  );
  assert.equal(result.overall, 'APPLIED');
  assert.equal(result.supersededCount, 1);
  assert.equal(h.expectationRows[0]!.effectiveTo, '2026-09-01');
  assert.equal(h.expectationRows.length, 2);
});

test('29. a legitimate authority successor supersedes rather than duplicating', async () => {
  const h = makeDeps();
  await runBootstrap(
    {
      planJson: JSON.stringify({ organizationSlug: ORG.slug, authorities: [authorityEntry()] }),
      declarerEmail: null,
      dryRun: false,
    },
    h.deps,
  );
  const result = await runBootstrap(
    {
      planJson: JSON.stringify({
        organizationSlug: ORG.slug,
        authorities: [authorityEntry({ sourceKey: REPORT_KEY, metric: 'REVENUE', effectiveFrom: '2026-09-01' })],
      }),
      declarerEmail: null,
      dryRun: false,
    },
    h.deps,
  );
  assert.equal(result.overall, 'APPLIED');
  assert.equal(h.authorityRows.length, 2);
});

test('30/31. every written entry is read back through the repository before SUCCESS', async () => {
  const h = makeDeps();
  const result = await runBootstrap({ planJson: planJson(), declarerEmail: null, dryRun: false }, h.deps);
  assert.equal(result.overall, 'APPLIED');
  assert.ok(result.entries.every((e) => e.readBack === 'CONFIRMED'));
  assert.ok(h.lines.some((l) => l.includes('entry=EXPECTATION[1]') && l.includes('readBack=CONFIRMED')));
  assert.ok(h.lines.some((l) => l.includes('entry=AUTHORITY[1]') && l.includes('readBack=CONFIRMED')));
});

test('30b. a write that cannot be read back is never reported as applied', async () => {
  const base = makeDeps();
  const deps: RunDeps = {
    ...base.deps,
    expectations: {
      ...base.deps.expectations,
      async declarationsFor() {
        return [];
      },
    },
  };
  const result = await runBootstrap({ planJson: planJson(), declarerEmail: null, dryRun: false }, deps);
  assert.notEqual(result.overall, 'APPLIED');
  assert.equal(result.failedIndex, 'EXPECTATION[1]');
  assert.ok(result.problems.some((p) => p.includes('could not be read back')));
});

// === 32: idempotency =============================================================

test('32. re-running a completed plan converges on everything ALREADY_EQUIVALENT', async () => {
  const h = makeDeps();
  const first = await runBootstrap({ planJson: planJson(), declarerEmail: null, dryRun: false }, h.deps);
  assert.equal(first.writtenCount, 2);

  const rerun = await runBootstrap({ planJson: planJson(), declarerEmail: null, dryRun: false }, h.deps);
  assert.equal(rerun.overall, 'APPLIED');
  assert.equal(rerun.writtenCount, 0);
  assert.equal(rerun.equivalentCount, 2);
  assert.equal(h.expectationRows.length, 1);
  assert.equal(h.authorityRows.length, 1);

  const dry = await runBootstrap({ planJson: planJson(), declarerEmail: null, dryRun: true }, h.deps);
  assert.equal(dry.overall, 'READY_TO_APPLY');
  assert.ok(summaryOf(h.lines.slice(-3)).includes('EXPECTATIONS_EQUIVALENT=1'));
});

test('32b. an interrupted run re-run does not duplicate what already landed', async () => {
  const h = makeDeps();
  // Entry 1 lands, entry 2 is refused by a "concurrent" change.
  await runBootstrap(
    {
      planJson: JSON.stringify({ organizationSlug: ORG.slug, expectations: [expectationEntry()] }),
      declarerEmail: null,
      dryRun: false,
    },
    h.deps,
  );
  const full = await runBootstrap(
    {
      planJson: JSON.stringify({
        organizationSlug: ORG.slug,
        expectations: [expectationEntry(), expectationEntry({ campaignId: CAMPAIGN_B })],
      }),
      declarerEmail: null,
      dryRun: false,
    },
    h.deps,
  );
  assert.equal(full.overall, 'APPLIED');
  assert.equal(full.equivalentCount, 1);
  assert.equal(full.writtenCount, 1);
  assert.equal(h.expectationRows.filter((r) => r.memberExternalId === CAMPAIGN_A).length, 1);
});

// === 33-35: concurrency between the preflight and a write ========================

test('33. a conflict between the expectation preview and its write stops the run', async () => {
  const base = makeDeps();
  const deps: RunDeps = {
    ...base.deps,
    expectations: {
      ...base.deps.expectations,
      async declare() {
        return { ok: false, reason: 'OVERLAPS_EXISTING', problems: ['another declaration was recorded concurrently'] };
      },
    },
  };
  const result = await runBootstrap({ planJson: planJson(), declarerEmail: null, dryRun: false }, deps);
  assert.equal(result.overall, 'PARTIALLY_APPLIED');
  assert.equal(result.failedIndex, 'EXPECTATION[1]');
  assert.equal(base.authorityWrites(), 0, 'the run must stop, not continue to the next section');
});

test('34. a conflict between the authority preview and its write stops the run', async () => {
  const base = makeDeps();
  const deps: RunDeps = {
    ...base.deps,
    authorities: {
      ...base.deps.authorities,
      async declareAuthority() {
        return { ok: false, reason: 'OVERLAPS_EXISTING', problems: ['another authority was recorded concurrently'] };
      },
    },
  };
  const result = await runBootstrap({ planJson: planJson(), declarerEmail: null, dryRun: false }, deps);
  assert.equal(result.overall, 'PARTIALLY_APPLIED');
  assert.equal(result.failedIndex, 'AUTHORITY[1]');
});

test('35. a partial write is reported honestly, never as a success', async () => {
  const base = makeDeps();
  const deps: RunDeps = {
    ...base.deps,
    authorities: {
      ...base.deps.authorities,
      async declareAuthority() {
        return { ok: false, reason: 'OVERLAPS_EXISTING', problems: ['raced'] };
      },
    },
  };
  const result = await runBootstrap(
    {
      planJson: JSON.stringify({
        organizationSlug: ORG.slug,
        expectations: [expectationEntry(), expectationEntry({ campaignId: CAMPAIGN_B })],
        authorities: [authorityEntry()],
      }),
      declarerEmail: null,
      dryRun: false,
    },
    deps,
  );
  assert.equal(result.overall, 'PARTIALLY_APPLIED');
  assert.equal(result.writtenCount, 2, 'what DID land must be counted');
  assert.equal(result.failedIndex, 'AUTHORITY[1]');
  const completion = completionOf(base.lines);
  assert.ok(completion.includes('WRITTEN_COUNT=2'));
  assert.ok(completion.includes('FAILED_INDEX=AUTHORITY[1]'));
  assert.ok(completion.includes('OVERALL_RESULT=PARTIALLY_APPLIED'));
  assert.ok(!completion.includes('OVERALL_RESULT=APPLIED'));
  // Both applied entries still name themselves and what happened to them.
  assert.equal(base.lines.filter((l) => l.includes('event=ENTRY_RESULT')).length, 2);
});

// === 36-44: boundaries, proved by reading the runner's own source ================

test('36. the runner never touches a Prisma delegate directly', () => {
  assert.ok(!/prisma\.\w+\.(create|update|delete|upsert|deleteMany|updateMany|findFirst|findMany)/.test(RUNNER_SOURCE));
});

test('37. the runner contains no raw SQL', () => {
  assert.ok(!RUNNER_SOURCE.includes('$executeRaw'));
  assert.ok(!RUNNER_SOURCE.includes('$queryRaw'));
  assert.ok(!/\bSELECT\s|\bINSERT\s|\bUPDATE\s+\w+\s+SET\b/.test(RUNNER_SOURCE));
});

test('38. the runner registers no measurement source and no source metric', () => {
  for (const symbol of ['registerSource', 'previewSourceRegistration', 'RegisterSourceInput', 'MeasurementSourceMetric']) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not reference ${symbol}`);
  }
});

test('39. the runner corrects no metric definition and names no definition id', () => {
  for (const symbol of ['correctMeasureDefinition', 'previewMeasureDefinitionCorrection', 'measureDefinitionId', 'objective-measure-binding.v1']) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not reference ${symbol}`);
  }
});

test('40. the runner reconciles nothing and certifies nothing', () => {
  for (const symbol of [
    'ProviderReconciliationDay',
    'ProviderReconciliationMember',
    'ProviderReconciliationRepository',
    'reconcileDay',
    'ProviderObservationDay',
    'ProviderObservationRepository',
    'certifyDay',
    'recordDay',
  ]) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not reference ${symbol}`);
  }
});

test('41. the runner cannot reach a provider, ingestion, recovery, sync or replay', () => {
  for (const symbol of [
    'CallGrid',
    'callgrid',
    'CALLGRID',
    'IngestionService',
    'NormalizationEngine',
    'fetchAllCallGridCalls',
    'webhook',
    'replay',
    'backfill',
  ]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not reference ${symbol}`);
  }
  // 'sync' as a word, not as the tail of 'async'.
  assert.ok(!/\bsync\b|integrations\/\w+\/sync/.test(RUNNER_CODE), 'the runner must not sync');
  // And it asks for no credential but the database one.
  assert.deepEqual(readEnvironment({} as NodeJS.ProcessEnv), { ok: false, missing: ['DATABASE_URL'] });
  assert.deepEqual(readEnvironment({ DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv), { ok: true });
  for (const secret of ['CALLGRID_API_KEY', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_', 'SHEETS']) {
    assert.ok(!RUNNER_CODE.includes(secret), `the runner must not name ${secret}`);
  }
});

test('42/43/44. the runner reaches no SourceOutcomeDay, no measurement and no Headline', () => {
  for (const symbol of [
    'SourceOutcomeDay',
    'sourceOutcomeDay',
    'measureChange',
    'MeasurementService',
    'assessReadiness',
    'readinessFacts',
    'Headline',
    'HeadlineDetectionService',
    'buyerReport',
    'BuyerReport',
  ]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not reference ${symbol}`);
  }
});

test('the runner never closes a predecessor itself', () => {
  // Supersession is the repositories', enforced by an EXCLUDE constraint. A
  // runner that re-dated a row would be bypassing exactly that guarantee.
  assert.ok(!/\.effectiveTo\s*=[^=]/.test(RUNNER_SOURCE));
  assert.ok(!RUNNER_SOURCE.includes('supersede('));
});

test('the runner decides no vocabulary of its own', () => {
  // Every closed list it enforces is enforced by the shipped bridges' own
  // validators, imported rather than re-typed.
  assert.ok(RUNNER_SOURCE.includes('validateExpectationRequest'));
  assert.ok(RUNNER_SOURCE.includes('validateAuthorityRequest'));
  for (const literal of ['EXPECTED', 'NOT_CONFIGURED', 'EXCLUDED', 'TEST_TRAFFIC', 'OPERATOR_DECLARED', 'CALL_VOLUME', 'REVENUE']) {
    assert.ok(!RUNNER_CODE.includes(literal), `the runner must not name the vocabulary member ${literal}`);
  }
});

test('nothing is ever inferred from traffic, configuration or a verdict', () => {
  for (const forbidden of ['revenue', 'converted', 'billable', 'imported', 'reconciled', 'observedCount', 'callCount']) {
    assert.ok(
      !new RegExp(`\\b${forbidden}\\s*[:?]`).test(RUNNER_SOURCE),
      `no input or field named ${forbidden} may exist`,
    );
  }
});

test('no user id is ever accepted from outside', () => {
  assert.ok(!/--declarer-id|--user-id|declaredByUserId:\s*(entry|request|plan)/.test(RUNNER_SOURCE));
  assert.ok(!RUNNER_SOURCE.includes('declaredByUserId'.concat('"')));
});

// === 45-47: the workflow =========================================================

test('45. the workflow is human-started only — no schedule, push, pull_request or workflow_call', () => {
  assert.ok(WORKFLOW_SOURCE.includes('workflow_dispatch:'));
  for (const trigger of ['\n  schedule:', '\n  push:', '\n  pull_request:', '\n  workflow_call:']) {
    assert.ok(!WORKFLOW_SOURCE.includes(trigger), `the workflow must not carry ${trigger.trim()}`);
  }
});

test('46. the workflow defaults to a dry run', () => {
  assert.ok(/dry_run:[\s\S]{0,300}default:\s*true/.test(WORKFLOW_SOURCE));
});

test('47. no organization, campaign, member, source key, person or plan is hard-coded', () => {
  for (const literal of [
    'servicesinmycity',
    'callgrid-calls',
    'SSDI',
    '1696',
    'Retainer',
    'Spanish',
    'Home Security',
    '@elitemediagroup',
    'cmo93ju7606k306k1of3tttac',
    '2026-08-05',
  ]) {
    assert.ok(!RUNNER_SOURCE.includes(literal), `the runner must not hard-code ${literal}`);
    assert.ok(!WORKFLOW_SOURCE.includes(literal), `the workflow must not hard-code ${literal}`);
  }
  // And no plan is committed alongside them: neither file carries a populated
  // section. The runner's usage example names the field and elides every value.
  assert.ok(!WORKFLOW_SOURCE.includes('"expectations"'), 'the workflow must not carry plan content');
  assert.ok(!/"(expectations|authorities)"\s*:\s*\[\s*\{/.test(RUNNER_SOURCE + WORKFLOW_SOURCE));
});

test('the workflow invokes this runner and no other', () => {
  assert.ok(WORKFLOW_SOURCE.includes('bootstrap:stage3'));
  for (const other of ['register:measurement-source', 'correct:source-metric-definition', 'certify:observation-days', 'reconcile:provider-day']) {
    assert.ok(!WORKFLOW_SOURCE.includes(other), `the workflow must not invoke ${other}`);
  }
});

test('the workflow proves the write boundary BEFORE it touches production', () => {
  const proof = WORKFLOW_SOURCE.indexOf('test:operations');
  const write = WORKFLOW_SOURCE.indexOf('bootstrap:stage3');
  assert.ok(proof > 0 && proof < write, 'the safety suite must run before the write step');
});

test('the workflow requires the database secret only, never echoes it, and never echoes the plan', () => {
  assert.ok(WORKFLOW_SOURCE.includes('DIRECT_DATABASE_URL'));
  assert.ok(!/echo\s+"?\$\{?\{?\s*secrets\./.test(WORKFLOW_SOURCE));
  assert.ok(!/echo\s+"\$\{PLAN_JSON\}"/.test(WORKFLOW_SOURCE));
  assert.ok(!/cat\s+"?\$\{RUNNER_TEMP\}/.test(WORKFLOW_SOURCE));
});

test('the workflow serialises runs against itself', () => {
  assert.ok(WORKFLOW_SOURCE.includes('concurrency:'));
});

test('the workflow never interpolates an input into a script body', () => {
  // A `${{ }}` expansion inside `run:` is pasted as literal shell text. Every
  // input must arrive through `env:` and be used as a quoted variable.
  const runBlocks = WORKFLOW_SOURCE.split(/\n\s+run: \|/).slice(1);
  for (const block of runBlocks) {
    assert.ok(!/\$\{\{\s*inputs\./.test(block.split(/\n\s+- name:/)[0] ?? ''), 'no input may be interpolated into a run body');
  }
});

// === Plumbing ====================================================================

test('arguments parse into a request, and a dry run is the explicit flag', () => {
  const parsed = parseArgs(['--plan-file', '/tmp/plan.json', '--declarer-email', 'a@b.c', '--dry-run']);
  assert.equal(parsed.planFile, '/tmp/plan.json');
  assert.equal(parsed.declarerEmail, 'a@b.c');
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.planJson, null);

  const inline = parseArgs(['--plan-json', '{"organizationSlug":"x"}']);
  assert.equal(inline.planJson, '{"organizationSlug":"x"}');
  assert.equal(inline.dryRun, false);
});
