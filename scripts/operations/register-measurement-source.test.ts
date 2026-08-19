// Tests for the source-registration operations bridge.
//
// WHAT THESE PROVE, AND WHY IN THIS SHAPE
//
// The runner's whole job is to reach exactly one production write and no other,
// so most of the value is in what it CANNOT do. Behaviour is driven through the
// three injected seams with a fake registrar; the boundaries are proved by
// reading the runner's and the workflow's own source, because a comment saying
// "the only write is registerSource()" is not a property and those are.
//
// The fake deliberately implements the repository's ADDITIVE semantics rather
// than a convenient stub: preview and write must agree, and a fake that let them
// disagree would assume away the property the dry run exists to provide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  RegisterSourceInput,
  RegisterSourcePreview,
  RegisterSourceResult,
} from '@emgloop/database';
import { decideSourceRegistration } from '@emgloop/database';
import type { MeasureMetric, MeasurementSourceDefinition } from '@emgloop/shared';

import {
  REFUSED_ORGANIZATION_STATUSES,
  parseArgs,
  readEnvironment,
  runRegistration,
  validateRequest,
  type RunDeps,
  type RunRequest,
} from './register-measurement-source';

const RUNNER_SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'register-measurement-source.ts'),
  'utf8',
);
const WORKFLOW_SOURCE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '.github',
    'workflows',
    'register-measurement-source.yml',
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

function request(over: Partial<RunRequest> = {}): RunRequest {
  return {
    organizationSlug: ORG.slug,
    key: 'stream-a',
    displayName: 'A polled stream',
    kind: 'PROVIDER_STREAM',
    provider: 'a-provider',
    stream: 'a-stream',
    metric: 'CALL_VOLUME',
    measureDefinitionId: 'stream.calls.v1',
    dryRun: false,
    ...over,
  };
}

function reportRequest(over: Partial<RunRequest> = {}): RunRequest {
  return request({
    key: 'report-a',
    displayName: 'A counterparty report',
    kind: 'BUYER_REPORT',
    provider: null,
    stream: null,
    metric: 'REVENUE',
    measureDefinitionId: 'counterparty.settled.v1',
    ...over,
  });
}

// --- A fake registrar with the repository's real semantics ------------------------

interface StoredSource {
  key: string;
  kind: string;
  displayName: string;
  provider: string | null;
  stream: string | null;
  metrics: Map<string, string>;
}

function makeDeps(over: Partial<RunDeps> = {}) {
  const lines: string[] = [];
  const store = new Map<string, StoredSource>();
  let writes = 0;

  const asDefinition = (s: StoredSource): MeasurementSourceDefinition => ({
    key: s.key,
    kind: s.kind as MeasurementSourceDefinition['kind'],
    displayName: s.displayName,
    supportedMetrics: [...s.metrics.keys()] as MeasurementSourceDefinition['supportedMetrics'],
    measureDefinitionIds: Object.fromEntries(s.metrics) as MeasurementSourceDefinition['measureDefinitionIds'],
    provider: s.provider,
    stream: s.stream,
  });

  const decide = (input: RegisterSourceInput) => {
    const existing = store.get(input.key) ?? null;
    return decideSourceRegistration(
      existing,
      existing?.metrics ?? new Map(),
      {
        kind: input.kind,
        provider: input.provider ?? null,
        stream: input.stream ?? null,
        metrics: input.metrics,
      },
    );
  };

  const sources = {
    async previewSourceRegistration(_org: string, input: RegisterSourceInput): Promise<RegisterSourcePreview> {
      const existing = store.get(input.key) ?? null;
      const decision = decide(input);
      if (decision.kind === 'BLOCKED') {
        return {
          outcome: 'BLOCKED',
          existing: existing ? asDefinition(existing) : null,
          wouldAddMetrics: [],
          reason: decision.reason,
          problems: decision.problems,
        };
      }
      return {
        outcome:
          decision.kind === 'CREATE' ? 'CREATED' : decision.kind === 'ADD_METRIC' ? 'ADDED_METRIC' : 'ALREADY_EQUIVALENT',
        existing: existing ? asDefinition(existing) : null,
        wouldAddMetrics:
          decision.kind === 'CREATE'
            ? input.metrics.map((m) => m.metric)
            : decision.kind === 'ADD_METRIC'
              ? decision.add
              : [],
        reason: null,
        problems: [],
      };
    },
    async registerSource(_org: string, input: RegisterSourceInput): Promise<RegisterSourceResult> {
      writes += 1;
      const decision = decide(input);
      if (decision.kind === 'BLOCKED') {
        return { ok: false, reason: decision.reason, problems: decision.problems };
      }
      const existing = store.get(input.key);
      const row: StoredSource = existing ?? {
        key: input.key,
        kind: input.kind,
        displayName: input.displayName,
        provider: input.provider ?? null,
        stream: input.stream ?? null,
        metrics: new Map(),
      };
      row.displayName = input.displayName;
      const added: MeasureMetric[] = [];
      for (const m of input.metrics) {
        if (!row.metrics.has(m.metric)) {
          row.metrics.set(m.metric, m.measureDefinitionId);
          added.push(m.metric);
        }
      }
      store.set(input.key, row);
      return {
        ok: true,
        source: asDefinition(row),
        outcome: decision.kind === 'CREATE' ? 'CREATED' : decision.kind === 'ADD_METRIC' ? 'ADDED_METRIC' : 'ALREADY_EQUIVALENT',
        addedMetrics: added,
      };
    },
    async findSource(_org: string, key: string): Promise<MeasurementSourceDefinition | null> {
      const row = store.get(key);
      return row ? asDefinition(row) : null;
    },
  };

  const deps: RunDeps = {
    sources,
    organizations: { async findBySlug(slug: string) { return slug === ORG.slug ? ORG : null; } },
    log: (l: string) => lines.push(l),
    ...over,
  };
  return { deps, lines, store, writeCount: () => writes };
}

// --- Input validation -------------------------------------------------------------

test('a PROVIDER_STREAM source with a provider and a stream is accepted', () => {
  const v = validateRequest(request());
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.value.provider, 'a-provider');
  assert.equal(v.value.stream, 'a-stream');
});

test('PROVIDER_STREAM without a provider is refused', () => {
  const v = validateRequest(request({ provider: null }));
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.ok(v.problems.some((p) => p.includes('--provider')));
});

test('PROVIDER_STREAM without a stream is refused', () => {
  const v = validateRequest(request({ stream: null }));
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.ok(v.problems.some((p) => p.includes('--stream')));
});

test('BUYER_REPORT carrying a provider is refused', () => {
  const v = validateRequest(reportRequest({ provider: 'a-provider' }));
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.ok(v.problems.some((p) => p.includes('--provider is only meaningful')));
});

test('BUYER_REPORT carrying a stream is refused', () => {
  const v = validateRequest(reportRequest({ stream: 'a-stream' }));
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.ok(v.problems.some((p) => p.includes('--stream is only meaningful')));
});

test('a BUYER_REPORT with neither is accepted and stores neither', () => {
  const v = validateRequest(reportRequest());
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.value.provider, null);
  assert.equal(v.value.stream, null);
});

test('a blank key, a blank display name and a blank definition id are each refused', () => {
  for (const over of [{ key: '   ' }, { displayName: ' ' }, { measureDefinitionId: '  ' }]) {
    const v = validateRequest(request(over));
    assert.equal(v.ok, false, `${JSON.stringify(over)} must be refused`);
  }
});

test('an unknown kind and an unknown metric are each refused against the shipped vocabulary', () => {
  const kind = validateRequest(request({ kind: 'SPREADSHEET' }));
  assert.equal(kind.ok, false);
  if (!kind.ok) assert.ok(kind.problems.some((p) => p.includes('PROVIDER_STREAM')));

  const metric = validateRequest(request({ metric: 'PROFIT' }));
  assert.equal(metric.ok, false);
  if (!metric.ok) assert.ok(metric.problems.some((p) => p.includes('CALL_VOLUME')));
});

test('the definition id is never generated — it must be supplied', () => {
  // A definition id names an agreement between two parties. Inventing one would
  // let two sources appear to agree because the runner made up the same string.
  assert.ok(!/measureDefinitionId\s*[:=]\s*[`'"]\w/.test(RUNNER_SOURCE.replace(/\/\/.*$/gm, '')));
  const v = validateRequest(request({ measureDefinitionId: '' }));
  assert.equal(v.ok, false);
});

// --- Preconditions ----------------------------------------------------------------

test('an unknown organization is refused and nothing is read further', async () => {
  const { deps, writeCount } = makeDeps();
  const result = await runRegistration(request({ organizationSlug: 'nope' }), deps);
  assert.equal(result.outcome, 'FAILED_PRECONDITION');
  assert.equal(writeCount(), 0);
});

test('a suspended or canceled organization is refused', async () => {
  for (const status of REFUSED_ORGANIZATION_STATUSES) {
    const { deps, writeCount } = makeDeps({
      organizations: { async findBySlug() { return { ...ORG, status }; } },
    });
    const result = await runRegistration(request(), deps);
    assert.equal(result.outcome, 'FAILED_PRECONDITION');
    assert.equal(writeCount(), 0);
  }
});

// --- Dry run ----------------------------------------------------------------------

test('a dry run reports WOULD_CREATE_SOURCE_AND_METRIC and writes nothing', async () => {
  const { deps, store, writeCount } = makeDeps();
  const result = await runRegistration(request({ dryRun: true }), deps);
  assert.equal(result.outcome, 'WOULD_CREATE_SOURCE_AND_METRIC');
  assert.equal(store.size, 0);
  assert.equal(writeCount(), 0, 'the mutating method must not be called at all');
});

test('a dry run over an existing source with a new metric reports WOULD_ADD_METRIC', async () => {
  const { deps, writeCount } = makeDeps();
  await runRegistration(request(), deps);
  const before = writeCount();
  const result = await runRegistration(request({ metric: 'NO_ROUTE_RATE', measureDefinitionId: 'stream.no-route.v1', dryRun: true }), deps);
  assert.equal(result.outcome, 'WOULD_ADD_METRIC');
  assert.equal(writeCount(), before, 'no further write may happen during a dry run');
});

test('a dry run over an identical registration reports WOULD_BE_ALREADY_EQUIVALENT', async () => {
  const { deps } = makeDeps();
  await runRegistration(request(), deps);
  const result = await runRegistration(request({ dryRun: true }), deps);
  assert.equal(result.outcome, 'WOULD_BE_ALREADY_EQUIVALENT');
});

// --- Real writes and idempotency --------------------------------------------------

test('a fresh registration creates the source and its metric', async () => {
  const { deps, store } = makeDeps();
  const result = await runRegistration(request(), deps);
  assert.equal(result.outcome, 'CREATED');
  assert.deepEqual([...(store.get('stream-a')?.metrics.keys() ?? [])], ['CALL_VOLUME']);
});

test('re-running the identical registration is ALREADY_EQUIVALENT', async () => {
  const { deps } = makeDeps();
  await runRegistration(request(), deps);
  const again = await runRegistration(request(), deps);
  assert.equal(again.outcome, 'ALREADY_EQUIVALENT');
});

test('ONE dispatch adds ONE metric and never removes the others', async () => {
  // The property that makes one-metric-per-dispatch safe. A replacing
  // registration would have silently deleted CALL_VOLUME here.
  const { deps, store } = makeDeps();
  await runRegistration(request(), deps);
  const added = await runRegistration(
    request({ metric: 'NO_ROUTE_RATE', measureDefinitionId: 'stream.no-route.v1' }),
    deps,
  );
  assert.equal(added.outcome, 'ADDED_METRIC');
  assert.deepEqual([...(store.get('stream-a')?.metrics.keys() ?? [])].sort(), ['CALL_VOLUME', 'NO_ROUTE_RATE']);
});

test('a conflicting source identity is BLOCKED and the stored source is untouched', async () => {
  const { deps, store } = makeDeps();
  await runRegistration(request(), deps);
  const conflict = await runRegistration(request({ stream: 'a-different-stream' }), deps);
  assert.equal(conflict.outcome, 'BLOCKED');
  assert.equal(store.get('stream-a')?.stream, 'a-stream');
});

test('a conflicting metric definition is BLOCKED and the stored definition is untouched', async () => {
  const { deps, store } = makeDeps();
  await runRegistration(request(), deps);
  const conflict = await runRegistration(request({ measureDefinitionId: 'something.else.v1' }), deps);
  assert.equal(conflict.outcome, 'BLOCKED');
  assert.equal(store.get('stream-a')?.metrics.get('CALL_VOLUME'), 'stream.calls.v1');
});

test('a BUYER_REPORT and a PROVIDER_STREAM coexist as separate sources', async () => {
  const { deps, store } = makeDeps();
  await runRegistration(request(), deps);
  await runRegistration(reportRequest(), deps);
  assert.equal(store.size, 2);
  assert.equal(store.get('report-a')?.provider, null);
});

test('the dry run and the write agree on every outcome', async () => {
  const cases = [
    request(),
    request({ metric: 'NO_ROUTE_RATE', measureDefinitionId: 'stream.no-route.v1' }),
    request(),
    request({ measureDefinitionId: 'divergent.v1' }),
    request({ stream: 'other' }),
  ];
  const expectedFromDry: Record<string, string> = {
    WOULD_CREATE_SOURCE_AND_METRIC: 'CREATED',
    WOULD_ADD_METRIC: 'ADDED_METRIC',
    WOULD_BE_ALREADY_EQUIVALENT: 'ALREADY_EQUIVALENT',
    BLOCKED: 'BLOCKED',
  };
  const { deps } = makeDeps();
  for (const c of cases) {
    const dry = await runRegistration({ ...c, dryRun: true }, deps);
    const wet = await runRegistration(c, deps);
    assert.equal(wet.outcome, expectedFromDry[dry.outcome], `dry ${dry.outcome} must be followed by ${expectedFromDry[dry.outcome]}`);
  }
});

test('the result is read back from the repository, not from the write', async () => {
  const { deps, lines } = makeDeps();
  await runRegistration(request(), deps);
  assert.ok(lines.some((l) => l.includes('readBack=CONFIRMED')));
});

test('a write that cannot be read back is reported BLOCKED rather than as success', async () => {
  const base = makeDeps();
  const deps: RunDeps = {
    ...base.deps,
    sources: { ...base.deps.sources, async findSource() { return null; } },
  };
  const result = await runRegistration(request(), deps);
  assert.equal(result.outcome, 'BLOCKED');
});

// --- Plumbing ---------------------------------------------------------------------

test('the runner needs the database credential and no provider credential', () => {
  assert.deepEqual(readEnvironment({} as NodeJS.ProcessEnv), { ok: false, missing: ['DATABASE_URL'] });
  assert.deepEqual(readEnvironment({ DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv), { ok: true });
  for (const symbol of ['CALLGRID_API_KEY', 'CALLGRID_ACCOUNT', 'RESEND_API_KEY', 'ANTHROPIC_API_KEY']) {
    assert.ok(!RUNNER_SOURCE.includes(symbol), `the runner must not name ${symbol}`);
  }
});

test('arguments parse into a request, and a bare --dry-run is a flag not a value', () => {
  const parsed = parseArgs([
    '--organization', 'fixture-org',
    '--key', 'k', '--display-name', 'D',
    '--kind', 'BUYER_REPORT',
    '--metric', 'REVENUE', '--measure-definition-id', 'def.v1',
    '--dry-run',
  ]);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.provider, null);
  assert.equal(parsed.measureDefinitionId, 'def.v1');
});

// --- Boundaries, proved by source inspection --------------------------------------

test('the runner declares no authority — that is a separate human act', () => {
  for (const symbol of ['declareAuthority', 'previewAuthorityDeclaration', 'MeasureSourceAuthority', 'authoritiesFor']) {
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

test('the runner decides no vocabulary of its own', () => {
  // Every closed list comes from @emgloop/shared. A literal list here would be a
  // second vocabulary that drifts from the contract the database enforces.
  assert.ok(RUNNER_SOURCE.includes('MEASUREMENT_SOURCE_KINDS'));
  assert.ok(RUNNER_SOURCE.includes('MEASURE_METRICS'));
  assert.ok(!/const\s+KINDS\s*=\s*\[/.test(RUNNER_SOURCE));
});

// --- The workflow -----------------------------------------------------------------

test('the workflow exists and invokes this runner', () => {
  assert.ok(WORKFLOW_SOURCE.includes('register:measurement-source'));
});

test('the workflow is human-started only — no schedule, push, pull_request or workflow_call', () => {
  assert.ok(WORKFLOW_SOURCE.includes('workflow_dispatch:'));
  for (const trigger of ['\n  schedule:', '\n  push:', '\n  pull_request:', '\n  workflow_call:']) {
    assert.ok(!WORKFLOW_SOURCE.includes(trigger), `the workflow must not carry ${trigger.trim()}`);
  }
});

test('the workflow takes ONE metric per dispatch and offers no batch input', () => {
  for (const f of ['metrics:', 'batch', 'all_metrics']) {
    assert.ok(!WORKFLOW_INPUTS.includes(f), `the workflow must not offer ${f}`);
  }
});

test('the workflow defaults to a dry run', () => {
  assert.ok(/dry_run:[\s\S]{0,300}default:\s*true/.test(WORKFLOW_SOURCE));
});

test('the workflow offers only the shipped vocabularies as choices', () => {
  for (const member of ['PROVIDER_STREAM', 'BUYER_REPORT', 'CALL_VOLUME', 'REVENUE', 'MONETIZED_RATE', 'CONVERSION_RATE', 'NO_ROUTE_RATE']) {
    assert.ok(WORKFLOW_SOURCE.includes(member), `the workflow must offer ${member}`);
  }
});

test('the workflow proves the write boundary BEFORE it touches production', () => {
  const proof = WORKFLOW_SOURCE.indexOf('test:operations');
  const write = WORKFLOW_SOURCE.indexOf('register:measurement-source');
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

test('no organization, source key, definition id or person is hard-coded anywhere', () => {
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
