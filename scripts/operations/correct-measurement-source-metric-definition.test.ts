// Tests for the metric-definition correction bridge.
//
// WHAT THESE PROVE, AND WHY IN THIS SHAPE
//
// This runner is the only path that may change a definition id after
// registration, and the invariant protecting it has NO database constraint
// behind it — nothing references a metric row, so Postgres would accept the
// update at any moment. Every guard is the application's, so the tests spend
// most of their effort on the guard: that an authority blocks it, that identity
// cannot be changed through it, and that a dry run writes nothing.
//
// The fake implements the repository's real decision function rather than a
// convenient stub, so preview and write cannot be made to agree by accident.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  CorrectDefinitionInput,
  CorrectDefinitionPreview,
  CorrectDefinitionResult,
  CorrectionState,
} from '@emgloop/database';
import { decideMeasureDefinitionCorrection } from '@emgloop/database';

import {
  REFUSED_ORGANIZATION_STATUSES,
  parseArgs,
  readEnvironment,
  runCorrection,
  validateRequest,
  type RunDeps,
  type RunRequest,
} from './correct-measurement-source-metric-definition';

const RUNNER_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'correct-measurement-source-metric-definition.ts'),
  'utf8',
);
const WORKFLOW_SOURCE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '.github',
    'workflows',
    'correct-measurement-source-metric-definition.yml',
  ),
  'utf8',
);

// The runner with its `//` prose removed. The field checks below are about
// CODE — a sentence explaining that there is no stream input must not read as
// a stream field.
const RUNNER_CODE = RUNNER_SOURCE.split('\n')
  .filter((l) => !l.trimStart().startsWith('//'))
  .join('\n');

const ORG = { id: 'org_1', slug: 'fixture-org', name: 'Fixture Org', status: 'ACTIVE' };
const SOURCE_KEY = 'a-stream';
const CURRENT = 'the-mistyped-value';
const WANTED = 'the-intended-value';

function request(over: Partial<RunRequest> = {}): RunRequest {
  return {
    organizationSlug: ORG.slug,
    sourceKey: SOURCE_KEY,
    metric: 'CALL_VOLUME',
    measureDefinitionId: WANTED,
    reason: 'The first registration recorded the metric name in the definition field.',
    dryRun: false,
    ...over,
  };
}

// --- A fake using the repository's own decision function --------------------------

interface FakeOptions {
  /** metric -> stored definition id. Absent metric means METRIC_NOT_FOUND. */
  metrics?: Record<string, string>;
  /** Whether the source exists at all. */
  sourceExists?: boolean;
  /** metric -> how many authorities name this source for it. */
  authorities?: Record<string, number>;
}

function makeDeps(options: FakeOptions = {}, over: Partial<RunDeps> = {}) {
  const lines: string[] = [];
  const metrics: Record<string, string> = { ...(options.metrics ?? { CALL_VOLUME: CURRENT }) };
  const sourceExists = options.sourceExists ?? true;
  const authorities = options.authorities ?? {};
  let writes = 0;

  const stateFor = (input: CorrectDefinitionInput): CorrectionState => ({
    sourceId: sourceExists ? 'src_1' : null,
    metricRowId: sourceExists && metrics[input.metric] !== undefined ? 'm_1' : null,
    currentDefinitionId: sourceExists ? (metrics[input.metric] ?? null) : null,
    authorityCount: sourceExists ? (authorities[input.metric] ?? 0) : 0,
  });

  const sources = {
    async previewMeasureDefinitionCorrection(
      _org: string,
      input: CorrectDefinitionInput,
    ): Promise<CorrectDefinitionPreview> {
      const requested = input.measureDefinitionId.trim();
      const state = stateFor(input);
      const decision = decideMeasureDefinitionCorrection(state, requested);
      return {
        outcome: decision.kind === 'CORRECT' ? 'WOULD_CORRECT' : decision.kind,
        currentDefinitionId: state.currentDefinitionId,
        requestedDefinitionId: requested,
        authorityCount: state.authorityCount,
        problems: decision.kind === 'CORRECT' ? [] : decision.problems,
      };
    },
    async correctMeasureDefinition(
      _org: string,
      input: CorrectDefinitionInput,
    ): Promise<CorrectDefinitionResult> {
      writes += 1;
      const requested = input.measureDefinitionId.trim();
      const state = stateFor(input);
      const decision = decideMeasureDefinitionCorrection(state, requested);
      if (decision.kind !== 'CORRECT') {
        return {
          ok: false,
          reason: decision.kind,
          problems: decision.problems,
          currentDefinitionId: state.currentDefinitionId,
          authorityCount: state.authorityCount,
        };
      }
      metrics[input.metric] = requested;
      return {
        ok: true,
        sourceKey: input.sourceKey,
        metric: input.metric,
        from: decision.from,
        to: decision.to,
        authorityCount: 0,
      };
    },
  };

  const deps: RunDeps = {
    sources,
    organizations: { async findBySlug(slug: string) { return slug === ORG.slug ? ORG : null; } },
    log: (l: string) => lines.push(l),
    ...over,
  };
  return { deps, lines, metrics, writeCount: () => writes };
}

// --- Input validation -------------------------------------------------------------

test('a well-formed correction is accepted', () => {
  const v = validateRequest(request());
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.value.metric, 'CALL_VOLUME');
  assert.equal(v.value.measureDefinitionId, WANTED);
});

test('a blank new definition id is refused', () => {
  const v = validateRequest(request({ measureDefinitionId: '   ' }));
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.ok(v.problems.some((p) => p.includes('--measure-definition-id')));
});

test('a blank reason is refused — the run log is the only record', () => {
  const v = validateRequest(request({ reason: '  ' }));
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.ok(v.problems.some((p) => p.includes('--reason')));
});

test('a blank source key and an unknown metric are each refused', () => {
  assert.equal(validateRequest(request({ sourceKey: ' ' })).ok, false);
  const m = validateRequest(request({ metric: 'PROFIT' }));
  assert.equal(m.ok, false);
  if (!m.ok) assert.ok(m.problems.some((p) => p.includes('CALL_VOLUME')));
});

// --- Preconditions ----------------------------------------------------------------

test('an unknown organization is refused and nothing is written', async () => {
  const { deps, writeCount } = makeDeps();
  const result = await runCorrection(request({ organizationSlug: 'nope' }), deps);
  assert.equal(result.outcome, 'FAILED_PRECONDITION');
  assert.equal(writeCount(), 0);
});

test('a suspended or canceled organization is refused', async () => {
  for (const status of REFUSED_ORGANIZATION_STATUSES) {
    const { deps, writeCount } = makeDeps({}, {
      organizations: { async findBySlug() { return { ...ORG, status }; } },
    });
    assert.equal((await runCorrection(request(), deps)).outcome, 'FAILED_PRECONDITION');
    assert.equal(writeCount(), 0);
  }
});

test('an unregistered source reports SOURCE_NOT_FOUND and writes nothing', async () => {
  const { deps, writeCount } = makeDeps({ sourceExists: false });
  const result = await runCorrection(request(), deps);
  assert.equal(result.outcome, 'SOURCE_NOT_FOUND');
  assert.equal(writeCount(), 0);
});

test('a metric the source does not declare reports METRIC_NOT_FOUND', async () => {
  const { deps, writeCount } = makeDeps({ metrics: { REVENUE: 'x' } });
  const result = await runCorrection(request(), deps);
  assert.equal(result.outcome, 'METRIC_NOT_FOUND');
  assert.equal(writeCount(), 0);
});

// --- The authority guard ----------------------------------------------------------

test('an authority naming this source for this measure BLOCKS the correction', async () => {
  const { deps, metrics, writeCount } = makeDeps({ authorities: { CALL_VOLUME: 1 } });
  const result = await runCorrection(request(), deps);
  assert.equal(result.outcome, 'BLOCKED_AUTHORITY_EXISTS');
  assert.equal(result.authorityCount, 1);
  assert.equal(metrics.CALL_VOLUME, CURRENT, 'the stored definition must be untouched');
  assert.equal(writeCount(), 0, 'the mutating method must not even be reached');
});

test('the blocked run still reports what is stored, which is the next question', async () => {
  const { deps, lines } = makeDeps({ authorities: { CALL_VOLUME: 2 } });
  const result = await runCorrection(request(), deps);
  assert.equal(result.from, CURRENT);
  assert.ok(lines.some((l) => l.includes(`currentDefinitionId=${CURRENT}`)));
  assert.ok(lines.some((l) => l.includes('authorityCount=2')));
});

test('an authority on a DIFFERENT measure of the same source does not block', async () => {
  const { deps, metrics } = makeDeps({
    metrics: { CALL_VOLUME: CURRENT, REVENUE: 'r' },
    authorities: { REVENUE: 1 },
  });
  const result = await runCorrection(request(), deps);
  assert.equal(result.outcome, 'CORRECTED');
  assert.equal(metrics.CALL_VOLUME, WANTED);
  assert.equal(metrics.REVENUE, 'r', 'the other metric is untouched');
});

test('the guard is re-asked by the write, not carried over from the preview', async () => {
  // An authority declared between the preview and the write must still block.
  // The runner reports the refusal rather than the success the preview promised.
  const base = makeDeps();
  let previewed = false;
  const deps: RunDeps = {
    ...base.deps,
    sources: {
      async previewMeasureDefinitionCorrection(o, i) {
        previewed = true;
        return base.deps.sources.previewMeasureDefinitionCorrection(o, i);
      },
      async correctMeasureDefinition() {
        return {
          ok: false,
          reason: 'BLOCKED_AUTHORITY_EXISTS',
          problems: ['an authority landed between the check and the write'],
          currentDefinitionId: CURRENT,
          authorityCount: 1,
        };
      },
    },
  };
  const result = await runCorrection(request(), deps);
  assert.equal(previewed, true);
  assert.equal(result.outcome, 'BLOCKED_AUTHORITY_EXISTS');
});

// --- Dry run and idempotency ------------------------------------------------------

test('a dry run reports WOULD_CORRECT with both ids and writes nothing', async () => {
  const { deps, metrics, writeCount, lines } = makeDeps();
  const result = await runCorrection(request({ dryRun: true }), deps);
  assert.equal(result.outcome, 'WOULD_CORRECT');
  assert.equal(result.from, CURRENT);
  assert.equal(result.to, WANTED);
  assert.equal(metrics.CALL_VOLUME, CURRENT);
  assert.equal(writeCount(), 0, 'the mutating method must not be called at all');
  // Both values in the record, which is the whole provenance this has.
  assert.ok(lines.some((l) => l.includes(`from=${CURRENT}`) && l.includes(`to=${WANTED}`)));
});

test('an identical definition is ALREADY_EQUIVALENT and writes nothing', async () => {
  const { deps, writeCount } = makeDeps();
  const result = await runCorrection(request({ measureDefinitionId: CURRENT }), deps);
  assert.equal(result.outcome, 'ALREADY_EQUIVALENT');
  assert.equal(writeCount(), 0);
});

test('re-running a completed correction settles on ALREADY_EQUIVALENT', async () => {
  const { deps } = makeDeps();
  assert.equal((await runCorrection(request(), deps)).outcome, 'CORRECTED');
  assert.equal((await runCorrection(request(), deps)).outcome, 'ALREADY_EQUIVALENT');
});

// --- The real write ---------------------------------------------------------------

test('a correction changes the definition and reports both ids', async () => {
  const { deps, metrics, lines } = makeDeps();
  const result = await runCorrection(request(), deps);
  assert.equal(result.outcome, 'CORRECTED');
  assert.equal(result.from, CURRENT);
  assert.equal(result.to, WANTED);
  assert.equal(metrics.CALL_VOLUME, WANTED);
  assert.ok(lines.some((l) => l.includes('readBack=CONFIRMED')));
});

test('the correction is read back, and a disagreeing row is reported not celebrated', async () => {
  const base = makeDeps();
  const deps: RunDeps = {
    ...base.deps,
    sources: {
      ...base.deps.sources,
      async previewMeasureDefinitionCorrection(o, i) {
        // Report the write as having happened, but never move the stored value.
        return { ...(await base.deps.sources.previewMeasureDefinitionCorrection(o, i)), currentDefinitionId: CURRENT };
      },
    },
  };
  const result = await runCorrection(request(), deps);
  assert.equal(result.outcome, 'FAILED_PRECONDITION');
  assert.ok(result.problems.some((p) => p.includes('does not agree')));
});

test('the runner has no way to change source identity or the metric itself', () => {
  // Structural: there is no input, field or argument through which kind,
  // provider, stream, a row id or a different metric could be written.
  const parsed = parseArgs(['--organization', 'o', '--kind', 'BUYER_REPORT', '--provider', 'p', '--stream', 's']);
  assert.equal(Object.keys(parsed).sort().join(','), 'dryRun,measureDefinitionId,metric,organizationSlug,reason,sourceKey');
  for (const flag of ['--kind', '--provider', '--stream', '--source-id', '--metric-row-id', '--display-name']) {
    assert.ok(!RUNNER_CODE.includes(`'${flag}'`), `the runner must not accept ${flag}`);
  }
  for (const field of ['kind:', 'provider:', 'stream:', 'displayName:']) {
    assert.ok(!RUNNER_CODE.includes(field), `the correction input must not carry ${field}`);
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
    '--source-key', 'k',
    '--metric', 'CALL_VOLUME',
    '--measure-definition-id', 'd.v1',
    '--reason', 'because',
    '--dry-run',
  ]);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.measureDefinitionId, 'd.v1');
});

// --- Boundaries, proved by source inspection --------------------------------------

test('the runner declares no authority and registers no source', () => {
  for (const symbol of ['declareAuthority', 'previewAuthorityDeclaration', 'registerSource', 'previewSourceRegistration', 'authoritiesFor']) {
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
    'projectInteraction',
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

test('the runner never touches a Prisma delegate or raw SQL', () => {
  assert.ok(!/prisma\.\w+\.(create|update|delete|upsert|deleteMany|updateMany)/.test(RUNNER_SOURCE));
  assert.ok(!RUNNER_SOURCE.includes('$executeRaw'));
  assert.ok(!RUNNER_SOURCE.includes('$queryRaw'));
  assert.ok(!RUNNER_SOURCE.includes('$transaction'));
  assert.ok(!/\bSELECT\b|\bUPDATE\b\s|\bALTER TABLE\b/.test(RUNNER_SOURCE));
});

test('the runner decides no vocabulary of its own', () => {
  assert.ok(RUNNER_SOURCE.includes('MEASURE_METRICS'));
  assert.ok(!/const\s+METRICS\s*=\s*\[/.test(RUNNER_SOURCE));
});

// --- The workflow -----------------------------------------------------------------

const WORKFLOW_INPUTS = WORKFLOW_SOURCE.split('\n')
  .filter((l) => !l.trimStart().startsWith('#'))
  .join('\n');

test('the workflow exists and invokes this runner', () => {
  assert.ok(WORKFLOW_SOURCE.includes('correct:source-metric-definition'));
});

test('the workflow is human-started only — no schedule, push, pull_request or workflow_call', () => {
  assert.ok(WORKFLOW_SOURCE.includes('workflow_dispatch:'));
  for (const trigger of ['\n  schedule:', '\n  push:', '\n  pull_request:', '\n  workflow_call:']) {
    assert.ok(!WORKFLOW_SOURCE.includes(trigger), `the workflow must not carry ${trigger.trim()}`);
  }
});

test('the workflow offers no identity input at all', () => {
  for (const f of ['kind:', 'provider:', 'stream:', 'display_name', 'source_id', 'metric_row_id', 'batch']) {
    assert.ok(!WORKFLOW_INPUTS.includes(f), `the workflow must not offer ${f}`);
  }
});

test('the workflow defaults to a dry run and requires a reason', () => {
  assert.ok(/dry_run:[\s\S]{0,300}default:\s*true/.test(WORKFLOW_SOURCE));
  assert.ok(/reason:[\s\S]{0,200}required:\s*true/.test(WORKFLOW_SOURCE));
});

test('the workflow offers only the shipped metric vocabulary', () => {
  for (const member of ['CALL_VOLUME', 'REVENUE', 'MONETIZED_RATE', 'CONVERSION_RATE', 'NO_ROUTE_RATE']) {
    assert.ok(WORKFLOW_SOURCE.includes(member), `the workflow must offer ${member}`);
  }
});

test('the workflow proves the write boundary BEFORE it touches production', () => {
  const proof = WORKFLOW_SOURCE.indexOf('test:operations');
  const write = WORKFLOW_SOURCE.indexOf('correct:source-metric-definition');
  assert.ok(proof > 0 && proof < write, 'the safety suite must run before the write step');
});

test('the workflow requires the database secret only, and never echoes it', () => {
  assert.ok(WORKFLOW_SOURCE.includes('DIRECT_DATABASE_URL'));
  assert.ok(!WORKFLOW_SOURCE.includes('CALLGRID'));
  assert.ok(!/echo\s+"?\$\{?\{?\s*secrets\./.test(WORKFLOW_SOURCE));
});

test('the workflow tells the operator to register a new source rather than force it', () => {
  // The blocked case has exactly one correct next step, and the run summary says
  // it — otherwise the pressure is to find a way around the guard.
  assert.ok(WORKFLOW_SOURCE.includes('BLOCKED_AUTHORITY_EXISTS'));
  assert.ok(/Register a NEW source/i.test(WORKFLOW_SOURCE));
});

test('the workflow serialises runs against itself', () => {
  assert.ok(WORKFLOW_SOURCE.includes('concurrency:'));
});

test('no organization, source key, definition id or person is hard-coded anywhere', () => {
  for (const literal of [
    'servicesinmycity',
    'callgrid-calls',
    'objective-measure-binding.v1:CALL_VOLUME',
    'SSDI',
    '1696',
    'Retainer',
    'Spanish',
    'Home Security',
    '@elitemediagroup',
  ]) {
    assert.ok(!RUNNER_SOURCE.includes(literal), `the runner must not hard-code ${literal}`);
    assert.ok(!WORKFLOW_SOURCE.includes(literal), `the workflow must not hard-code ${literal}`);
  }
});
