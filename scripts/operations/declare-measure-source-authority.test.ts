// Tests for the authority-declaration operations bridge.
//
// WHAT THESE PROVE, AND WHY IN THIS SHAPE
//
// This runner is the only path by which a person can state whose number a
// measure is, so the tests spend most of their effort on what it CANNOT do:
// declare over a source nobody registered, resolve a declarer from another
// tenant, write during a dry run, or reach any other Stage 3 subsystem. The
// boundaries are proved by reading the runner's and the workflow's own source,
// because a comment saying "the only write is declareAuthority()" is not a
// property and those are.
//
// The fake authority store implements real effective-dating — half-open ranges,
// supersession, overlap refusal — rather than a convenient stub, because a fake
// that let preview and write disagree would assume away exactly the property the
// dry run exists to provide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  AuthorityDeclarationPreview,
  AuthorityDeclarationView,
  DeclareAuthorityInput,
  DeclareAuthorityResult,
} from '@emgloop/database';
import { decideEffectiveDatedWrite } from '@emgloop/shared';
import type { BindingDimension, MeasureMetric } from '@emgloop/shared';

import {
  REFUSED_ORGANIZATION_STATUSES,
  parseArgs,
  readEnvironment,
  resolveDeclarer,
  runDeclaration,
  validateRequest,
  type RunDeps,
  type RunRequest,
} from './declare-measure-source-authority';

const RUNNER_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'declare-measure-source-authority.ts'),
  'utf8',
);
const WORKFLOW_SOURCE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '.github',
    'workflows',
    'declare-measure-source-authority.yml',
  ),
  'utf8',
);

// The workflow with its `#` prose removed. The "must not offer" checks below
// are about INPUTS, and a header sentence explaining that there is no batch
// mode must not read as an input named batch.
const WORKFLOW_INPUTS = WORKFLOW_SOURCE.split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n');

const ORG = { id: 'org_1', slug: 'fixture-org', name: 'Fixture Org', status: 'ACTIVE' };
const MEMBER = 'member-fixture-1';
const STREAM_KEY = 'stream-a';
const REPORT_KEY = 'report-a';

function request(over: Partial<RunRequest> = {}): RunRequest {
  return {
    organizationSlug: ORG.slug,
    dimension: 'CAMPAIGN',
    memberExternalId: MEMBER,
    metric: 'REVENUE',
    sourceKey: REPORT_KEY,
    reason: 'The counterparty settles the following day and reports the outcome.',
    effectiveFrom: '2026-08-05',
    effectiveTo: null,
    declarerEmail: null,
    dryRun: false,
    ...over,
  };
}

// --- A fake authority store with real effective-dating ----------------------------

interface Row {
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
  [STREAM_KEY]: ['CALL_VOLUME', 'REVENUE'],
  [REPORT_KEY]: ['REVENUE'],
};

function makeDeps(over: Partial<RunDeps> = {}, members = [{ id: 'u_1', email: 'someone@example.com', status: 'ACTIVE' }]) {
  const lines: string[] = [];
  const rows: Row[] = [];
  let seq = 0;
  let writes = 0;

  const view = (r: Row): AuthorityDeclarationView => ({
    id: r.id,
    dimension: r.dimension as BindingDimension,
    memberExternalId: r.memberExternalId,
    metric: r.metric as MeasureMetric,
    sourceKey: r.sourceKey,
    reason: r.reason,
    effectiveFrom: r.effectiveFrom as AuthorityDeclarationView['effectiveFrom'],
    effectiveTo: r.effectiveTo as AuthorityDeclarationView['effectiveTo'],
    declaredByUserId: r.declaredByUserId,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
  });

  /** The preconditions the repository resolves before effective-dating. */
  const precheck = (
    input: DeclareAuthorityInput,
  ): { reason: 'SOURCE_NOT_REGISTERED' | 'SOURCE_DOES_NOT_SUPPORT_METRIC'; problems: string[] } | null => {
    const supported = REGISTERED[input.sourceKey];
    if (!supported) {
      return { reason: 'SOURCE_NOT_REGISTERED', problems: ['no source is registered under that key'] };
    }
    if (!supported.includes(input.metric)) {
      return {
        reason: 'SOURCE_DOES_NOT_SUPPORT_METRIC',
        problems: [`${input.sourceKey} declares no definition for ${input.metric}`],
      };
    }
    return null;
  };

  const matching = (input: DeclareAuthorityInput) =>
    rows.filter(
      (r) =>
        r.dimension === input.dimension &&
        r.memberExternalId === input.memberExternalId.trim() &&
        r.metric === input.metric,
    );

  const decideFor = (input: DeclareAuthorityInput) =>
    decideEffectiveDatedWrite(
      matching(input),
      { effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null },
      (r) => ({ effectiveFrom: r.effectiveFrom as never, effectiveTo: r.effectiveTo as never }),
      (r) => r.sourceKey === input.sourceKey.trim(),
    );

  const inForceOn = (input: DeclareAuthorityInput) =>
    matching(input).find(
      (r) => input.effectiveFrom >= r.effectiveFrom && (r.effectiveTo === null || input.effectiveFrom < r.effectiveTo),
    ) ?? null;

  const authorities = {
    async previewAuthorityDeclaration(_org: string, input: DeclareAuthorityInput): Promise<AuthorityDeclarationPreview> {
      const bad = precheck(input);
      if (bad) {
        return { outcome: 'BLOCKED', effectiveNow: null, supersedes: null, reason: bad.reason, problems: bad.problems };
      }
      const decision = decideFor(input);
      const now = inForceOn(input);
      if (decision.kind === 'BLOCKED') {
        return {
          outcome: 'BLOCKED',
          effectiveNow: now ? view(now) : null,
          supersedes: null,
          reason: 'OVERLAPS_EXISTING',
          problems: decision.problems,
        };
      }
      if (decision.kind === 'EQUIVALENT') {
        return { outcome: 'ALREADY_EQUIVALENT', effectiveNow: view(decision.row), supersedes: null, reason: null, problems: [] };
      }
      return {
        outcome: decision.predecessor ? 'WOULD_SUPERSEDE' : 'WOULD_CREATE',
        effectiveNow: now ? view(now) : null,
        supersedes: decision.predecessor ? view(decision.predecessor) : null,
        reason: null,
        problems: [],
      };
    },
    async declareAuthority(_org: string, input: DeclareAuthorityInput): Promise<DeclareAuthorityResult> {
      writes += 1;
      const bad = precheck(input);
      if (bad) return { ok: false, reason: bad.reason, problems: bad.problems };
      const decision = decideFor(input);
      if (decision.kind === 'BLOCKED') {
        return { ok: false, reason: 'OVERLAPS_EXISTING', problems: decision.problems };
      }
      if (decision.kind === 'EQUIVALENT') {
        return { ok: true, declaration: view(decision.row), supersededId: null, unchanged: true };
      }
      if (decision.predecessor) decision.predecessor.effectiveTo = input.effectiveFrom;
      seq += 1;
      const row: Row = {
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
      rows.push(row);
      return { ok: true, declaration: view(row), supersededId: decision.predecessor?.id ?? null, unchanged: false };
    },
    async authoritiesFor(_o: string, dimension: BindingDimension, member: string, metric: MeasureMetric) {
      return rows
        .filter((r) => r.dimension === dimension && r.memberExternalId === member && r.metric === metric)
        .map(view);
    },
  };

  const deps: RunDeps = {
    authorities,
    organizations: { async findBySlug(slug: string) { return slug === ORG.slug ? ORG : null; } },
    directory: { async listUsers() { return members; } },
    log: (l: string) => lines.push(l),
    ...over,
  };
  return { deps, lines, rows, writeCount: () => writes };
}

// --- Vocabulary and shape ---------------------------------------------------------

test('every shipped dimension is accepted', () => {
  for (const dimension of ['CAMPAIGN', 'SOURCE', 'BUYER', 'VENDOR']) {
    const v = validateRequest(request({ dimension }));
    assert.equal(v.ok, true, `${dimension} must be accepted`);
  }
});

test('an unknown dimension and an unknown metric are refused', () => {
  const d = validateRequest(request({ dimension: 'VERTICAL' }));
  assert.equal(d.ok, false);
  if (!d.ok) assert.ok(d.problems.some((p) => p.includes('CAMPAIGN')));

  const m = validateRequest(request({ metric: 'PROFIT' }));
  assert.equal(m.ok, false);
  if (!m.ok) assert.ok(m.problems.some((p) => p.includes('REVENUE')));
});

test('a blank member, a blank source key and a blank reason are each refused', () => {
  for (const over of [{ memberExternalId: ' ' }, { sourceKey: '  ' }, { reason: '   ' }]) {
    const v = validateRequest(request(over));
    assert.equal(v.ok, false, `${JSON.stringify(over)} must be refused`);
  }
});

test('a malformed effective date is refused', () => {
  for (const bad of ['2026-8-5', 'yesterday', '05/08/2026', '']) {
    const v = validateRequest(request({ effectiveFrom: bad }));
    assert.equal(v.ok, false, `${bad} must be refused`);
  }
});

test('effectiveTo is EXCLUSIVE, so an end on or before the start is refused', () => {
  for (const to of ['2026-08-05', '2026-08-04']) {
    const v = validateRequest(request({ effectiveTo: to }));
    assert.equal(v.ok, false, `${to} must be refused`);
  }
  assert.equal(validateRequest(request({ effectiveTo: '2026-08-06' })).ok, true);
});

// --- Preconditions ----------------------------------------------------------------

test('an unknown organization is refused and nothing is written', async () => {
  const { deps, writeCount } = makeDeps();
  const result = await runDeclaration(request({ organizationSlug: 'nope' }), deps);
  assert.equal(result.outcome, 'FAILED_PRECONDITION');
  assert.equal(writeCount(), 0);
});

test('a suspended or canceled organization is refused', async () => {
  for (const status of REFUSED_ORGANIZATION_STATUSES) {
    const { deps, writeCount } = makeDeps({
      organizations: { async findBySlug() { return { ...ORG, status }; } },
    });
    assert.equal((await runDeclaration(request(), deps)).outcome, 'FAILED_PRECONDITION');
    assert.equal(writeCount(), 0);
  }
});

test('naming a source nobody registered is refused — the bridge never creates one', async () => {
  const { deps, rows } = makeDeps();
  const result = await runDeclaration(request({ sourceKey: 'never-registered' }), deps);
  assert.equal(result.outcome, 'BLOCKED');
  assert.equal(rows.length, 0);
});

test('naming a source that declares no definition for the measure is refused', async () => {
  const { deps, rows } = makeDeps();
  // The report source supports REVENUE only.
  const result = await runDeclaration(request({ sourceKey: REPORT_KEY, metric: 'CALL_VOLUME' }), deps);
  assert.equal(result.outcome, 'BLOCKED');
  assert.equal(rows.length, 0);
});

// --- Declarer resolution ----------------------------------------------------------

test('a declarer email resolves within the organization', async () => {
  const { deps } = makeDeps();
  const result = await runDeclaration(request({ declarerEmail: 'SOMEONE@example.com' }), deps);
  assert.equal(result.outcome, 'CREATED');
  assert.equal(result.declarerResolved, true);
});

test('a blank declarer records no actor, which is the honest value', async () => {
  const { deps } = makeDeps();
  const result = await runDeclaration(request({ declarerEmail: null }), deps);
  assert.equal(result.outcome, 'CREATED');
  assert.equal(result.declarerResolved, false);
});

test('a declarer email matching nobody FAILS CLOSED rather than recording no actor', async () => {
  const { deps, rows } = makeDeps();
  const result = await runDeclaration(request({ declarerEmail: 'ghost@example.com' }), deps);
  assert.equal(result.outcome, 'FAILED_PRECONDITION');
  assert.equal(rows.length, 0, 'nothing may be written when the signer cannot be resolved');
});

test('an ambiguous declarer email FAILS CLOSED', async () => {
  const { deps, rows } = makeDeps({}, [
    { id: 'u_1', email: 'dup@example.com', status: 'ACTIVE' },
    { id: 'u_2', email: 'dup@example.com', status: 'ACTIVE' },
  ]);
  const result = await runDeclaration(request({ declarerEmail: 'dup@example.com' }), deps);
  assert.equal(result.outcome, 'FAILED_PRECONDITION');
  assert.equal(rows.length, 0);
});

test('a user in another organization cannot resolve — the roster read is scoped', async () => {
  // The directory is asked for THIS organization's members and returns only
  // those; there is no input carrying a user id, so a foreign id has no route in.
  const scoped = { async listUsers(orgId: string) { return orgId === ORG.id ? [] : [{ id: 'u_other', email: 'outsider@example.com', status: 'ACTIVE' }]; } };
  const resolution = await resolveDeclarer(scoped, ORG.id, 'outsider@example.com');
  assert.equal(resolution.ok, false);
  assert.ok(!RUNNER_SOURCE.includes('declaredByUserId: request'), 'no user id may be accepted from outside');
  assert.ok(!/--declarer-id|--user-id/.test(RUNNER_SOURCE));
});

test('the declarer email is never echoed into the run log', async () => {
  const { deps, lines } = makeDeps();
  await runDeclaration(request({ declarerEmail: 'ghost@example.com' }), deps);
  assert.ok(!lines.join('\n').includes('ghost@example.com'));
});

// --- Dry run ----------------------------------------------------------------------

test('a dry run reports WOULD_CREATE and writes nothing', async () => {
  const { deps, rows, writeCount } = makeDeps();
  const result = await runDeclaration(request({ dryRun: true }), deps);
  assert.equal(result.outcome, 'WOULD_CREATE');
  assert.equal(rows.length, 0);
  assert.equal(writeCount(), 0, 'the mutating method must not be called at all');
});

test('a dry run over a legitimate successor reports WOULD_SUPERSEDE and names the predecessor', async () => {
  const { deps, rows, writeCount } = makeDeps();
  await runDeclaration(request(), deps);
  const before = writeCount();
  const result = await runDeclaration(
    request({ sourceKey: STREAM_KEY, effectiveFrom: '2026-09-01', dryRun: true }),
    deps,
  );
  assert.equal(result.outcome, 'WOULD_SUPERSEDE');
  assert.equal(result.supersededId, rows[0]!.id);
  assert.equal(writeCount(), before);
  assert.equal(rows[0]!.effectiveTo, null, 'the predecessor must not be closed by a dry run');
});

test('a dry run over an identical declaration reports WOULD_BE_ALREADY_EQUIVALENT', async () => {
  const { deps } = makeDeps();
  await runDeclaration(request(), deps);
  const result = await runDeclaration(request({ dryRun: true }), deps);
  assert.equal(result.outcome, 'WOULD_BE_ALREADY_EQUIVALENT');
});

// --- Real writes and effective dating ---------------------------------------------

test('a fresh declaration is CREATED and read back', async () => {
  const { deps, lines } = makeDeps();
  const result = await runDeclaration(request(), deps);
  assert.equal(result.outcome, 'CREATED');
  assert.ok(result.authorityId);
  assert.ok(lines.some((l) => l.includes('readBack=CONFIRMED')));
});

test('re-declaring the identical authority writes nothing', async () => {
  const { deps, rows } = makeDeps();
  await runDeclaration(request(), deps);
  const again = await runDeclaration(request(), deps);
  assert.equal(again.outcome, 'ALREADY_EQUIVALENT');
  assert.equal(rows.length, 1);
});

test('a successor CLOSES the predecessor at the new start date and preserves what it said', async () => {
  const { deps, rows } = makeDeps();
  await runDeclaration(request({ reason: 'The counterparty settles the day after.' }), deps);
  const result = await runDeclaration(request({ sourceKey: STREAM_KEY, effectiveFrom: '2026-09-01' }), deps);
  assert.equal(result.outcome, 'CREATED');
  assert.equal(result.supersededId, rows[0]!.id);
  assert.equal(rows[0]!.effectiveTo, '2026-09-01', 'half-open: the end date belongs to the successor');
  assert.equal(rows[0]!.sourceKey, REPORT_KEY, 'the predecessor keeps its source');
  assert.equal(rows[0]!.reason, 'The counterparty settles the day after.', 'and its reason');
});

test('a declaration that would swallow a later one is BLOCKED, not applied', async () => {
  const { deps, rows } = makeDeps();
  await runDeclaration(request({ effectiveFrom: '2026-09-01' }), deps);
  const earlier = await runDeclaration(request({ sourceKey: STREAM_KEY, effectiveFrom: '2026-08-05' }), deps);
  assert.equal(earlier.outcome, 'BLOCKED');
  assert.equal(rows.length, 1);
});

test('two metrics on ONE member take different sources on the same day', async () => {
  // The case the whole layer exists for, driven end to end through the runner.
  const { deps, rows } = makeDeps();
  await runDeclaration(request({ metric: 'REVENUE', sourceKey: REPORT_KEY }), deps);
  await runDeclaration(request({ metric: 'CALL_VOLUME', sourceKey: STREAM_KEY }), deps);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.metric === 'REVENUE')?.sourceKey, REPORT_KEY);
  assert.equal(rows.find((r) => r.metric === 'CALL_VOLUME')?.sourceKey, STREAM_KEY);
});

test('a write that cannot be read back is reported BLOCKED rather than as success', async () => {
  const base = makeDeps();
  const deps: RunDeps = {
    ...base.deps,
    authorities: { ...base.deps.authorities, async authoritiesFor() { return []; } },
  };
  const result = await runDeclaration(request(), deps);
  assert.equal(result.outcome, 'BLOCKED');
});

test('the dry run and the write agree on every outcome', async () => {
  const expected: Record<string, string> = {
    WOULD_CREATE: 'CREATED',
    WOULD_SUPERSEDE: 'CREATED',
    WOULD_BE_ALREADY_EQUIVALENT: 'ALREADY_EQUIVALENT',
    BLOCKED: 'BLOCKED',
  };
  const cases = [
    request(),
    request(),
    request({ sourceKey: STREAM_KEY, effectiveFrom: '2026-09-01' }),
    request({ sourceKey: 'never-registered' }),
  ];
  const { deps } = makeDeps();
  for (const c of cases) {
    const dry = await runDeclaration({ ...c, dryRun: true }, deps);
    const wet = await runDeclaration(c, deps);
    assert.equal(wet.outcome, expected[dry.outcome], `dry ${dry.outcome} must be followed by ${expected[dry.outcome]}`);
  }
});

// --- Plumbing ---------------------------------------------------------------------

test('the runner needs the database credential and no provider credential', () => {
  assert.deepEqual(readEnvironment({} as NodeJS.ProcessEnv), { ok: false, missing: ['DATABASE_URL'] });
  assert.deepEqual(readEnvironment({ DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv), { ok: true });
  for (const symbol of ['CALLGRID_API_KEY', 'CALLGRID_ACCOUNT', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY']) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not name ${symbol}`);
  }
});

test('arguments parse into a request', () => {
  const parsed = parseArgs([
    '--organization', 'fixture-org',
    '--dimension', 'CAMPAIGN',
    '--member', 'm-1',
    '--metric', 'REVENUE',
    '--source-key', 'k',
    '--reason', 'because',
    '--effective-from', '2026-08-05',
    '--dry-run',
  ]);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.effectiveTo, null);
  assert.equal(parsed.memberExternalId, 'm-1');
});

// --- Boundaries, proved by source inspection --------------------------------------

test('the runner registers no source — that is a separate human act', () => {
  for (const symbol of ['registerSource', 'previewSourceRegistration', 'MeasurementSourceMetric', 'measureDefinitionId']) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not reference ${symbol}`);
  }
});

test('the runner cannot reach reconciliation, certification, ingestion, recovery or measurement', () => {
  for (const symbol of [
    'ProviderReconciliationDay',
    'ProviderReconciliationMember',
    'ProviderReconciliationRepository',
    'ProviderMemberExpectation',
    'reconcileDay',
    'recordDay',
    'ProviderObservationDay',
    'ProviderObservationRepository',
    'certifyDay',
    'IngestionService',
    'NormalizationEngine',
    'MarketplaceCall',
    'CallGridReconciliationService',
    'HeadlineDetectionService',
    'SourceOutcomeDay',
    'assessReadiness',
    'readinessFacts',
    'ensureLiveOrganization',
    'createUser',
  ]) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not reference ${symbol}`);
  }
});

test('the runner never touches a Prisma delegate directly', () => {
  assert.ok(!/prisma\.\w+\.(create|update|delete|upsert|deleteMany|updateMany)/.test(RUNNER_SOURCE));
  assert.ok(!RUNNER_SOURCE.includes('$executeRaw'));
  assert.ok(!RUNNER_SOURCE.includes('$queryRaw'));
});

test('the runner never closes a predecessor itself', () => {
  // Supersession is the repository's, enforced by an EXCLUDE constraint. A
  // runner that re-dated a row would be bypassing exactly that guarantee.
  assert.ok(!/effectiveTo\s*=\s*/.test(RUNNER_SOURCE.replace(/effectiveTo: /g, '')));
  assert.ok(!RUNNER_SOURCE.includes('supersede('));
});

test('the runner decides no vocabulary of its own', () => {
  assert.ok(RUNNER_SOURCE.includes('BINDING_DIMENSIONS'));
  assert.ok(RUNNER_SOURCE.includes('MEASURE_METRICS'));
  assert.ok(!/const\s+DIMENSIONS\s*=\s*\[/.test(RUNNER_SOURCE));
});

test('authority is never inferred from data, configuration or a verdict', () => {
  // Structural: there is no input, field or call by which a value, a webhook, a
  // reconciliation or an import could reach this write.
  for (const forbidden of ['revenue', 'converted', 'billable', 'webhook', 'imported', 'reconciled', 'observedCount']) {
    assert.ok(
      !new RegExp(`\\b${forbidden}\\s*[:?]`).test(RUNNER_SOURCE),
      `no input named ${forbidden} may exist`,
    );
  }
});

// --- The workflow -----------------------------------------------------------------

test('the workflow exists and invokes this runner', () => {
  assert.ok(WORKFLOW_SOURCE.includes('declare:source-authority'));
});

test('the workflow is human-started only — no schedule, push, pull_request or workflow_call', () => {
  assert.ok(WORKFLOW_SOURCE.includes('workflow_dispatch:'));
  for (const trigger of ['\n  schedule:', '\n  push:', '\n  pull_request:', '\n  workflow_call:']) {
    assert.ok(!WORKFLOW_SOURCE.includes(trigger), `the workflow must not carry ${trigger.trim()}`);
  }
});

test('the workflow takes ONE member, metric and source per dispatch, with no batch input', () => {
  for (const f of ['members:', 'metrics:', 'batch', 'campaigns:']) {
    assert.ok(!WORKFLOW_INPUTS.includes(f), `the workflow must not offer ${f}`);
  }
});

test('the workflow defaults to a dry run', () => {
  assert.ok(/dry_run:[\s\S]{0,300}default:\s*true/.test(WORKFLOW_SOURCE));
});

test('the workflow offers only the shipped vocabularies as choices', () => {
  for (const member of ['CAMPAIGN', 'SOURCE', 'BUYER', 'VENDOR', 'CALL_VOLUME', 'REVENUE', 'MONETIZED_RATE', 'CONVERSION_RATE', 'NO_ROUTE_RATE']) {
    assert.ok(WORKFLOW_SOURCE.includes(member), `the workflow must offer ${member}`);
  }
});

test('the workflow cannot register a source', () => {
  assert.ok(!WORKFLOW_SOURCE.includes('register:measurement-source'));
  assert.ok(!WORKFLOW_SOURCE.includes('display_name'));
  assert.ok(!WORKFLOW_SOURCE.includes('measure_definition_id'));
});

test('the workflow proves the write boundary BEFORE it touches production', () => {
  const proof = WORKFLOW_SOURCE.indexOf('test:operations');
  const write = WORKFLOW_SOURCE.indexOf('declare:source-authority');
  assert.ok(proof > 0 && proof < write, 'the safety suite must run before the write step');
});

test('the workflow requires the database secret only, and never echoes it', () => {
  assert.ok(WORKFLOW_SOURCE.includes('DIRECT_DATABASE_URL'));
  assert.ok(!WORKFLOW_SOURCE.includes('CALLGRID'));
  assert.ok(!/echo\s+"?\$\{?\{?\s*secrets\./.test(WORKFLOW_SOURCE));
});

test('the workflow serialises runs against itself', () => {
  assert.ok(WORKFLOW_SOURCE.includes('concurrency:'));
});

test('no organization, member, source key or person is hard-coded anywhere', () => {
  for (const literal of [
    'servicesinmycity',
    'callgrid-calls',
    'SSDI',
    '1696',
    'Retainer',
    'Spanish',
    'Home Security',
    '@elitemediagroup',
    'cmng68vp2001d06inikyf6zqh',
    'cmo1siqoq033t07jngw973suv',
  ]) {
    assert.ok(!RUNNER_SOURCE.includes(literal), `the runner must not hard-code ${literal}`);
    assert.ok(!WORKFLOW_SOURCE.includes(literal), `the workflow must not hard-code ${literal}`);
  }
});
