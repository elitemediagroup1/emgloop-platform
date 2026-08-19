// The declaration runner — behaviour, and what it is structurally unable to do.
//
// THE PROPERTY UNDER TEST, ONCE
//
// A dry run must tell the truth about the write that follows it, and a write
// must be the only mutation this file can reach. Everything below is a way one of
// those could fail: a preview that disagrees with the write, an input the runner
// accepts and the repository then refuses, a declarer resolved from outside the
// organization, an exclusion reason attached to a state that forbids one, or a
// dry run that quietly wrote something.
//
// The source-constraint tests read this runner's own source and fail if it ever
// names reconciliation, certification, ingestion, recovery, a provider adapter or
// a Prisma delegate. A comment saying "the only write is declare()" is not a
// property; those are.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DeclarationPreview, DeclareResult, ExpectationDeclarationView } from '@emgloop/database';

import {
  DIMENSION,
  PROVIDER,
  REFUSED_ORGANIZATION_STATUSES,
  STREAM,
  parseArgs,
  readEnvironment,
  resolveDeclarer,
  runDeclaration,
  validateRequest,
  type DeclareInput,
  type RunDeps,
  type RunRequest,
} from './declare-member-expectations';

const RUNNER_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'declare-member-expectations.ts'),
  'utf8',
);
const WORKFLOW_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'declare-member-expectations.yml'),
  'utf8',
);

const ORG = { id: 'org_1', slug: 'fixture-org', name: 'Fixture Org', status: 'ACTIVE' };
const CAMPAIGN = 'cmp-fixture-1';
const DATE = '2026-08-05';

function request(over: Partial<RunRequest> = {}): RunRequest {
  return {
    organizationSlug: ORG.slug,
    memberExternalId: CAMPAIGN,
    state: 'NOT_CONFIGURED',
    exclusionReason: null,
    basis: 'PROVIDER_CONFIG_VERIFIED',
    reason: 'No production webhook was attached to this campaign.',
    effectiveFrom: DATE,
    effectiveTo: null,
    declarerEmail: null,
    dryRun: false,
    ...over,
  };
}

function view(over: Partial<ExpectationDeclarationView> = {}): ExpectationDeclarationView {
  return {
    id: 'decl_1',
    provider: PROVIDER,
    stream: STREAM,
    dimension: DIMENSION,
    memberExternalId: CAMPAIGN,
    state: 'NOT_CONFIGURED',
    exclusionReason: null,
    basis: 'PROVIDER_CONFIG_VERIFIED',
    reason: 'fixture',
    effectiveFrom: DATE,
    effectiveTo: null,
    declaredByUserId: null,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    ...over,
  };
}

function preview(over: Partial<DeclarationPreview> = {}): DeclarationPreview {
  return { outcome: 'CREATED', effectiveNow: null, supersedes: null, reason: null, problems: [], ...over };
}

interface Harness {
  lines: string[];
  previewed: DeclareInput[];
  declared: DeclareInput[];
  deps: RunDeps;
}

function harness(options: {
  preview?: DeclarationPreview;
  declare?: DeclareResult;
  stored?: ExpectationDeclarationView[];
  organization?: { id: string; slug: string; name: string; status: string } | null;
  members?: Array<{ id: string; email: string; status: string }>;
} = {}): Harness {
  const lines: string[] = [];
  const previewed: DeclareInput[] = [];
  const declared: DeclareInput[] = [];
  const organization = options.organization === undefined ? ORG : options.organization;
  return {
    lines,
    previewed,
    declared,
    deps: {
      expectations: {
        async previewDeclaration(_org, input) {
          previewed.push(input);
          return options.preview ?? preview();
        },
        async declare(_org, input) {
          declared.push(input);
          return options.declare ?? { ok: true, declaration: view(), supersededId: null, unchanged: false };
        },
        async declarationsFor() {
          return options.stored ?? [view()];
        },
      },
      organizations: { async findBySlug() { return organization; } },
      directory: { async listUsers() { return options.members ?? []; } },
      log: (l) => lines.push(l),
    },
  };
}

// --- 1-4. Dry run --------------------------------------------------------------

test('a valid EXPECTED dry run reports what would happen and writes nothing', async () => {
  const h = harness({ preview: preview({ outcome: 'CREATED' }) });
  const result = await runDeclaration(request({ state: 'EXPECTED', dryRun: true }), h.deps);
  assert.equal(result.outcome, 'WOULD_CREATE');
  assert.equal(result.dryRun, true);
  assert.equal(h.previewed.length, 1);
  assert.deepEqual(h.declared, []);
});

test('a valid NOT_CONFIGURED dry run reports what would happen and writes nothing', async () => {
  const h = harness({ preview: preview({ outcome: 'CREATED' }) });
  const result = await runDeclaration(request({ state: 'NOT_CONFIGURED', dryRun: true }), h.deps);
  assert.equal(result.outcome, 'WOULD_CREATE');
  assert.deepEqual(h.declared, []);
});

test('a valid EXCLUDED dry run reports what would happen and writes nothing', async () => {
  const h = harness({ preview: preview({ outcome: 'CREATED' }) });
  const result = await runDeclaration(
    request({ state: 'EXCLUDED', exclusionReason: 'INTERNAL_TRAFFIC', dryRun: true }),
    h.deps,
  );
  assert.equal(result.outcome, 'WOULD_CREATE');
  assert.equal(h.previewed[0]?.exclusionReason, 'INTERNAL_TRAFFIC');
  assert.deepEqual(h.declared, []);
});

test('a dry run NEVER calls declare — it mutates, and a dry run that invoked it would be a write with a comment on it', async () => {
  const h = harness();
  await runDeclaration(request({ dryRun: true }), h.deps);
  assert.deepEqual(h.declared, []);
  const done = h.lines.find((l) => l.startsWith('event=DRY_RUN_COMPLETE'));
  assert.match(String(done), /written=false/);
});

test('a dry run prints the declaration currently in force for that campaign on that date', async () => {
  const h = harness({
    preview: preview({ outcome: 'CREATED', effectiveNow: view({ id: 'decl_old', state: 'EXPECTED' }) }),
  });
  await runDeclaration(request({ dryRun: true }), h.deps);
  const check = h.lines.find((l) => l.startsWith('event=PRE_WRITE_CHECK'));
  assert.match(String(check), /existing=EXPECTED/);
  assert.match(String(check), /existingId=decl_old/);
  assert.match(String(check), /wouldBe=CREATED/);
});

test('the pre-write check runs on a REAL run too, so the log explains itself without a second dispatch', async () => {
  const h = harness();
  await runDeclaration(request({ dryRun: false }), h.deps);
  assert.ok(h.lines.some((l) => l.startsWith('event=PRE_WRITE_CHECK')));
  assert.equal(h.declared.length, 1);
});

// --- 5-14. Input validation ----------------------------------------------------

test('EXPECTED with an exclusion reason is rejected', () => {
  const result = validateRequest(request({ state: 'EXPECTED', exclusionReason: 'TEST_TRAFFIC' }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.problems.join(' '), /only meaningful on EXCLUDED/);
});

test('NOT_CONFIGURED with an exclusion reason is rejected — it is not a synonym for EXCLUDED', () => {
  // One says the records could not arrive. The other says they were deliberately
  // left out of the measurement. Collapsing them would file a delivery failure
  // as a decision.
  const result = validateRequest(request({ state: 'NOT_CONFIGURED', exclusionReason: 'INTERNAL_TRAFFIC' }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.problems.join(' '), /only meaningful on EXCLUDED/);
});

test('EXCLUDED without an exclusion reason is rejected', () => {
  const result = validateRequest(request({ state: 'EXCLUDED', exclusionReason: null }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.problems.join(' '), /EXCLUDED requires/);
});

test('an exclusion reason outside the shipped vocabulary is rejected', () => {
  const result = validateRequest(request({ state: 'EXCLUDED', exclusionReason: 'BECAUSE_I_SAID_SO' }));
  assert.equal(result.ok, false);
});

test('a state outside the shipped vocabulary is rejected, including UNKNOWN', () => {
  for (const state of ['UNKNOWN', 'DISABLED', 'expected', '']) {
    const result = validateRequest(request({ state }));
    assert.equal(result.ok, false, `${state} must not be declarable`);
  }
});

test('a basis outside the shipped vocabulary is rejected', () => {
  for (const basis of ['GUESSED', 'provider_config_verified', '']) {
    assert.equal(validateRequest(request({ basis })).ok, false);
  }
});

test('a date that is not YYYY-MM-DD is rejected rather than coerced', () => {
  for (const date of ['05/08/2026', '2026-8-5', 'yesterday', '']) {
    assert.equal(validateRequest(request({ effectiveFrom: date })).ok, false);
  }
  assert.equal(validateRequest(request({ effectiveTo: '2026-8-5' })).ok, false);
});

test('an effective range that ends on or before it starts is rejected', () => {
  // `effectiveTo` is EXCLUSIVE, so equal bounds describe no date at all.
  assert.equal(validateRequest(request({ effectiveFrom: DATE, effectiveTo: DATE })).ok, false);
  assert.equal(validateRequest(request({ effectiveFrom: DATE, effectiveTo: '2026-08-04' })).ok, false);
  assert.equal(validateRequest(request({ effectiveFrom: DATE, effectiveTo: '2026-08-06' })).ok, true);
});

test('a blank campaign id is rejected — a declaration keyed on a label is not identity', () => {
  assert.equal(validateRequest(request({ memberExternalId: '   ' })).ok, false);
});

test('a blank reason is rejected — an unexplained declaration is a place to hide', () => {
  assert.equal(validateRequest(request({ reason: '   ' })).ok, false);
});

test('an unknown organization is a precondition failure, and nothing is previewed or written', async () => {
  const h = harness({ organization: null });
  const result = await runDeclaration(request(), h.deps);
  assert.equal(result.outcome, 'FAILED_PRECONDITION');
  assert.deepEqual(h.previewed, []);
  assert.deepEqual(h.declared, []);
});

test('a suspended or cancelled organization is refused before anything is read', async () => {
  for (const status of REFUSED_ORGANIZATION_STATUSES) {
    const h = harness({ organization: { ...ORG, status } });
    const result = await runDeclaration(request(), h.deps);
    assert.equal(result.outcome, 'FAILED_PRECONDITION');
    assert.deepEqual(h.declared, []);
  }
});

test('an invalid input never reaches the repository at all', async () => {
  const h = harness();
  const result = await runDeclaration(request({ state: 'UNKNOWN' }), h.deps);
  assert.equal(result.outcome, 'FAILED_PRECONDITION');
  assert.deepEqual(h.previewed, []);
  assert.deepEqual(h.declared, []);
});

// --- 15-18. Declarer resolution ------------------------------------------------

const directoryOf = (members: Array<{ id: string; email: string; status: string }>) => ({
  async listUsers() { return members; },
});

test('a declarer email resolves to the member of THIS organization who holds it', async () => {
  const resolved = await resolveDeclarer(
    directoryOf([
      { id: 'user_1', email: 'someone@example.com', status: 'ACTIVE' },
      { id: 'user_2', email: 'other@example.com', status: 'ACTIVE' },
    ]),
    ORG.id,
    'someone@example.com',
  );
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.userId, 'user_1');
});

test('a declarer email matches case-insensitively and ignores surrounding whitespace', async () => {
  const resolved = await resolveDeclarer(
    directoryOf([{ id: 'user_1', email: 'Someone@Example.com', status: 'ACTIVE' }]),
    ORG.id,
    '  SOMEONE@example.COM  ',
  );
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.userId, 'user_1');
});

test('a declarer email that matches nobody FAILS CLOSED rather than recording no actor', async () => {
  // Silently recording "nobody said this" when a person believed they were
  // signing it puts a weaker provenance on the row than the operator intended,
  // and the weakness would be invisible afterwards.
  const resolved = await resolveDeclarer(directoryOf([]), ORG.id, 'ghost@example.com');
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.match(resolved.problem, /matches no active member/);
});

test('an ambiguous declarer email FAILS CLOSED rather than guessing', async () => {
  const resolved = await resolveDeclarer(
    directoryOf([
      { id: 'user_1', email: 'dup@example.com', status: 'ACTIVE' },
      { id: 'user_2', email: 'dup@example.com', status: 'ACTIVE' },
    ]),
    ORG.id,
    'dup@example.com',
  );
  assert.equal(resolved.ok, false);
  if (!resolved.ok) assert.match(resolved.problem, /matches 2 members/);
});

test('a declarer outside the organization cannot resolve — the roster read is org-scoped', async () => {
  // The directory seam takes an organizationId and returns only that
  // organization's members, so a member of another tenant is simply not in the
  // list. There is no input anywhere that carries a user id.
  const h = harness({ members: [{ id: 'user_other', email: 'outsider@example.com', status: 'ACTIVE' }] });
  const asked: string[] = [];
  h.deps.directory = {
    async listUsers(organizationId) {
      asked.push(organizationId);
      return organizationId === ORG.id ? [] : [{ id: 'user_other', email: 'outsider@example.com', status: 'ACTIVE' }];
    },
  };
  const result = await runDeclaration(request({ declarerEmail: 'outsider@example.com' }), h.deps);
  assert.deepEqual(asked, [ORG.id]);
  assert.equal(result.outcome, 'FAILED_PRECONDITION');
  assert.deepEqual(h.declared, []);
});

test('an unresolvable declarer blocks the write entirely — nothing is previewed or written', async () => {
  const h = harness();
  const result = await runDeclaration(request({ declarerEmail: 'ghost@example.com' }), h.deps);
  assert.equal(result.outcome, 'FAILED_PRECONDITION');
  assert.deepEqual(h.previewed, []);
  assert.deepEqual(h.declared, []);
});

test('a blank declarer email is legitimate and records no actor rather than a stand-in', async () => {
  const h = harness();
  const result = await runDeclaration(request({ declarerEmail: null }), h.deps);
  assert.equal(result.outcome, 'CREATED');
  assert.equal(result.declarerResolved, false);
  assert.equal(h.declared[0]?.declaredByUserId, null);
});

test('a resolved declarer is passed to the write as an id the runner never received', async () => {
  const h = harness({ members: [{ id: 'user_1', email: 'someone@example.com', status: 'ACTIVE' }] });
  const result = await runDeclaration(request({ declarerEmail: 'someone@example.com' }), h.deps);
  assert.equal(result.declarerResolved, true);
  assert.equal(h.declared[0]?.declaredByUserId, 'user_1');
});

// --- 19-22. The write ----------------------------------------------------------

test('a real run uses declare(), and passes the fixed provider scope', async () => {
  const h = harness();
  const result = await runDeclaration(request({ dryRun: false }), h.deps);
  assert.equal(result.outcome, 'CREATED');
  assert.equal(h.declared.length, 1);
  assert.equal(h.declared[0]?.provider, PROVIDER);
  assert.equal(h.declared[0]?.stream, STREAM);
  assert.equal(h.declared[0]?.dimension, DIMENSION);
});

test('an identical declaration already in force reports ALREADY_EQUIVALENT', async () => {
  const h = harness({
    preview: preview({ outcome: 'ALREADY_EQUIVALENT', effectiveNow: view() }),
    declare: { ok: true, declaration: view(), supersededId: null, unchanged: true },
  });
  const result = await runDeclaration(request(), h.deps);
  assert.equal(result.outcome, 'ALREADY_EQUIVALENT');
  const done = h.lines.find((l) => l.startsWith('event=DECLARATION_RESULT'));
  assert.match(String(done), /result=ALREADY_EQUIVALENT/);
  assert.match(String(done), /written=false/);
});

test('a dry run over an identical declaration says so without writing', async () => {
  const h = harness({ preview: preview({ outcome: 'ALREADY_EQUIVALENT', effectiveNow: view() }) });
  const result = await runDeclaration(request({ dryRun: true }), h.deps);
  assert.equal(result.outcome, 'WOULD_BE_ALREADY_EQUIVALENT');
  assert.deepEqual(h.declared, []);
});

test('a conflicting overlap is BLOCKED, writes nothing, and the runner exits non-zero', async () => {
  const h = harness({
    preview: preview({
      outcome: 'BLOCKED',
      reason: 'OVERLAPS_EXISTING',
      problems: ['a declaration already starts on 2026-08-10 for this member'],
    }),
  });
  const result = await runDeclaration(request(), h.deps);
  assert.equal(result.outcome, 'BLOCKED');
  assert.deepEqual(h.declared, [], 'a blocked preview must not be followed by a write attempt');
  assert.match(result.problems.join(' '), /already starts on/);
});

test('an overlap that appears BETWEEN the preview and the write is still refused by the repository', async () => {
  // The preview is advice. The repository and its EXCLUDE constraint are the
  // decision, and a concurrent declaration landing in between must not slip past.
  const h = harness({
    preview: preview({ outcome: 'CREATED' }),
    declare: { ok: false, reason: 'OVERLAPS_EXISTING', problems: ['another declaration was recorded concurrently'] },
  });
  const result = await runDeclaration(request(), h.deps);
  assert.equal(result.outcome, 'BLOCKED');
  assert.equal(result.expectationId, null);
});

test('the post-write readback comes from the repository, not from the write’s own return value', async () => {
  const h = harness({
    declare: { ok: true, declaration: view({ id: 'decl_new' }), supersededId: 'decl_old', unchanged: false },
    stored: [view({ id: 'decl_new', state: 'NOT_CONFIGURED', effectiveFrom: DATE, effectiveTo: null })],
  });
  const result = await runDeclaration(request(), h.deps);
  assert.equal(result.expectationId, 'decl_new');
  const done = h.lines.find((l) => l.startsWith('event=DECLARATION_RESULT'));
  assert.match(String(done), /readBack=CONFIRMED/);
  assert.match(String(done), /state=NOT_CONFIGURED/);
  assert.match(String(done), /effectiveFrom=2026-08-05/);
  assert.match(String(done), /supersededId=decl_old/);
});

test('a write reported as succeeding that cannot be read back is a failure, not a success', async () => {
  const h = harness({
    declare: { ok: true, declaration: view({ id: 'decl_new' }), supersededId: null, unchanged: false },
    stored: [],
  });
  const result = await runDeclaration(request(), h.deps);
  assert.equal(result.outcome, 'BLOCKED');
  assert.match(result.problems.join(' '), /could not be read back/);
});

test('the readback line names the full identity of what was stored', async () => {
  const h = harness();
  await runDeclaration(request(), h.deps);
  const done = String(h.lines.find((l) => l.startsWith('event=DECLARATION_RESULT')));
  for (const field of ['organization=', 'provider=callgrid', 'stream=calls', 'dimension=CAMPAIGN', 'campaign=', 'expectationId=', 'basis=']) {
    assert.ok(done.includes(field), `the result line must carry ${field}`);
  }
});

// --- Plumbing ------------------------------------------------------------------

test('flags parse, and --dry-run is a switch rather than a value', () => {
  const parsed = parseArgs([
    '--organization', 'a', '--campaign', 'c1', '--state', 'EXPECTED',
    '--basis', 'OPERATOR_DECLARED', '--reason', 'because', '--effective-from', DATE, '--dry-run',
  ]);
  assert.equal(parsed.organizationSlug, 'a');
  assert.equal(parsed.memberExternalId, 'c1');
  assert.equal(parsed.state, 'EXPECTED');
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.effectiveTo, null);
  assert.equal(parsed.declarerEmail, null);
});

test('omitting the optional flags leaves them null rather than empty strings', () => {
  const parsed = parseArgs(['--organization', 'a', '--campaign', 'c1']);
  assert.equal(parsed.effectiveTo, null);
  assert.equal(parsed.exclusionReason, null);
  assert.equal(parsed.declarerEmail, null);
  assert.equal(parsed.dryRun, false);
});

test('the runner requires the database credential and NO provider credential', () => {
  const missing = readEnvironment({} as NodeJS.ProcessEnv);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.deepEqual(missing.missing, ['DATABASE_URL']);
  // A declaration never reads traffic, so a provider key is not requested and
  // must never become required here.
  assert.equal(readEnvironment({ DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv).ok, true);
});

// --- Source constraints --------------------------------------------------------

test('the only business-data mutation the runner can reach is declare()', () => {
  assert.ok(RUNNER_SOURCE.includes('.declare('), 'the declaration is invoked, not reimplemented');
  // `prisma.$disconnect()` is deliberately allowed and deliberately not matched
  // — closing the connection this script opened is hygiene, not data access —
  // so the pattern targets `prisma.<model>` rather than the client itself.
  assert.equal(/prisma\.[a-z]/.test(RUNNER_SOURCE), false, 'no Prisma model delegate');
  for (const verb of ['.create(', '.update(', '.upsert(', '.delete(', '.deleteMany(', '.updateMany(', '$executeRaw', '$queryRaw', '$transaction']) {
    assert.ok(!RUNNER_SOURCE.includes(verb), `the runner must not call ${verb}`);
  }
});

test('the runner cannot reach reconciliation, certification, ingestion, recovery or measurement', () => {
  for (const symbol of [
    'ProviderReconciliationDay',
    'ProviderReconciliationMember',
    'ProviderReconciliationRepository',
    'ProviderReconciliationService',
    'reconcileDay',
    'recordDay',
    'ProviderObservationDay',
    'ProviderObservationService',
    'ProviderObservationRepository',
    'certifyDay',
    'IngestionService',
    'NormalizationEngine',
    'MarketplaceCall',
    'projectInteraction',
    'projectWindow',
    'CallGridReconciliationService',
    'HeadlineDetectionService',
    'CommercialSignal',
    'ObjectiveMeasureBinding',
    'OperationalPriority',
    'ensureLiveOrganization',
    'createUser',
  ]) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not reference ${symbol}`);
  }
});

test('the runner contacts no provider and holds no provider credential', () => {
  // Expectation is DECLARED, never inferred. A runner that could read traffic is
  // one edit away from letting a campaign that broke un-expect itself.
  for (const symbol of ['getCallGridProvider', 'CALLGRID_API_KEY', 'apiKey', 'poll(', 'fetch(', '@emgloop/providers']) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not reference ${symbol}`);
  }
});

test('the runner accepts no user id from outside, only an email it resolves itself', () => {
  // A raw declaredByUserId input would be an id from an untrusted source pointed
  // at a column with a foreign key — the shape that let a caller name another
  // tenant's row in Sprint 29A.
  assert.equal(RUNNER_SOURCE.includes('--declarer-id'), false);
  assert.equal(RUNNER_SOURCE.includes('declarer_id'), false);
  assert.equal(/pick\('--declarer-user/.test(RUNNER_SOURCE), false);
  assert.ok(RUNNER_SOURCE.includes('listUsers'), 'the declarer resolves through the org-scoped roster');
});

test('the runner decides no vocabulary of its own', () => {
  // Every state, basis and exclusion reason comes from @emgloop/shared. A literal
  // list here would be a second vocabulary that drifts from the contract.
  assert.ok(RUNNER_SOURCE.includes('MEMBER_EXPECTATION_STATES'));
  assert.ok(RUNNER_SOURCE.includes('MEMBER_EXPECTATION_BASES'));
  assert.ok(RUNNER_SOURCE.includes('MEMBER_EXCLUSION_REASONS'));
  assert.ok(RUNNER_SOURCE.includes('isBusinessDate'), 'dates use the shared predicate');
});

test('the provider, stream and dimension are fixed constants, not inputs', () => {
  assert.match(RUNNER_SOURCE, /export const PROVIDER = 'callgrid'/);
  assert.match(RUNNER_SOURCE, /export const STREAM = 'calls'/);
  assert.match(RUNNER_SOURCE, /export const DIMENSION = 'CAMPAIGN'/);
  assert.equal(RUNNER_SOURCE.includes("pick('--provider'"), false);
  assert.equal(RUNNER_SOURCE.includes("pick('--stream'"), false);
  assert.equal(RUNNER_SOURCE.includes("pick('--dimension'"), false);
});

// --- The workflow --------------------------------------------------------------

test('the workflow exists and invokes this runner', () => {
  assert.match(WORKFLOW_SOURCE, /npm run declare:member-expectations/);
  assert.match(WORKFLOW_SOURCE, /--organization/);
  assert.match(WORKFLOW_SOURCE, /--campaign/);
});

test('the workflow is human-started only — no schedule, push, pull_request or workflow_call', () => {
  assert.match(WORKFLOW_SOURCE, /workflow_dispatch:/);
  assert.equal(/^\s{0,4}schedule:/m.test(WORKFLOW_SOURCE), false, 'no schedule trigger');
  assert.equal(/^\s{0,4}push:/m.test(WORKFLOW_SOURCE), false, 'no push trigger');
  assert.equal(/^\s{0,4}pull_request:/m.test(WORKFLOW_SOURCE), false, 'no pull_request trigger');
  assert.equal(/^\s{0,4}workflow_call:/m.test(WORKFLOW_SOURCE), false, 'no workflow_call trigger');
  assert.equal(WORKFLOW_SOURCE.includes('cron:'), false, 'no cron');
});

test('the workflow takes ONE campaign per dispatch and offers no batch input', () => {
  assert.match(WORKFLOW_SOURCE, /campaign_id:/);
  for (const batch of ['campaign_ids', 'campaigns:', 'declarations:', '--campaigns']) {
    assert.equal(WORKFLOW_SOURCE.includes(batch), false, `no batch input (${batch})`);
  }
});

test('the workflow defaults to a dry run', () => {
  const dryRun = WORKFLOW_SOURCE.slice(WORKFLOW_SOURCE.indexOf('dry_run:'));
  assert.match(dryRun, /default:\s*true/);
});

test('the workflow exposes no provider, stream or dimension input', () => {
  for (const widened of ['provider:', 'stream:', 'member_dimension:', 'dimension:']) {
    assert.equal(
      new RegExp(`^\\s{6}${widened}`, 'm').test(WORKFLOW_SOURCE),
      false,
      `${widened} must stay a constant, not an input`,
    );
  }
});

test('the workflow offers only the shipped vocabularies as choices', () => {
  for (const state of ['NOT_CONFIGURED', 'EXPECTED', 'EXCLUDED']) {
    assert.ok(WORKFLOW_SOURCE.includes(`- ${state}`), `${state} must be offered`);
  }
  // UNKNOWN is not storable and must never appear as something to pick.
  assert.equal(WORKFLOW_SOURCE.includes('- UNKNOWN'), false);
  for (const basis of ['PROVIDER_CONFIG_VERIFIED', 'OPERATOR_DECLARED']) {
    assert.ok(WORKFLOW_SOURCE.includes(`- ${basis}`));
  }
  for (const reason of ['TEST_TRAFFIC', 'INTERNAL_TRAFFIC']) {
    assert.ok(WORKFLOW_SOURCE.includes(`- ${reason}`));
  }
});

test('the workflow proves the write boundary BEFORE it touches production', () => {
  const safety = WORKFLOW_SOURCE.indexOf('npm run test:operations');
  const production = WORKFLOW_SOURCE.indexOf('npm run declare:member-expectations');
  assert.ok(safety > 0 && production > 0);
  assert.ok(safety < production, 'the constraint tests must run before the credential is used');
});

test('the workflow requires the database secret only, and never echoes it', () => {
  assert.match(WORKFLOW_SOURCE, /DIRECT_DATABASE_URL/);
  assert.equal(WORKFLOW_SOURCE.includes('CALLGRID_API_KEY'), false, 'no provider credential');
  assert.equal(/echo[^\n]*\$\{\{\s*secrets\./.test(WORKFLOW_SOURCE), false);
});

test('the workflow serialises runs against itself', () => {
  assert.match(WORKFLOW_SOURCE, /concurrency:/);
  assert.match(WORKFLOW_SOURCE, /cancel-in-progress:\s*false/);
});

test('no campaign id and no person is hard-coded anywhere', () => {
  // The four August 5 declarations are OPERATOR INPUT, not source. A campaign id
  // or an email committed here would be business data living in a code file, and
  // it would outlive the fact it recorded.
  //
  // An organization SLUG is deliberately not on this list: it appears only in
  // the dispatch form's help text, exactly as certify-observation-days.yml
  // already does, and a worked example is what stops an operator guessing.
  for (const literal of [
    'cmo1siqoq033t07jngw973suv',
    'cmo93ju7606k306k1of3tttac',
    'cmphdtnu504eh07ii5aul38mz',
    'cmng68vp2001d06inikyf6zqh',
    '@elitemediagroup',
    '@emgloop.com',
  ]) {
    assert.equal(WORKFLOW_SOURCE.includes(literal), false, `${literal} must not be hard-coded in the workflow`);
    assert.equal(RUNNER_SOURCE.includes(literal), false, `${literal} must not be hard-coded in the runner`);
  }
  // And the slug is never a DEFAULT — an operator must state which tenant.
  assert.equal(/organization_slug:[\s\S]{0,200}?default:/.test(WORKFLOW_SOURCE), false);
});
