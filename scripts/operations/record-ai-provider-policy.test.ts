// Record AI Provider Policy (G2, 2026-09-24): the script (dry run, write, kill, refusals), the
// read-only probe, and the workflow that runs them -- including its Confirm step, executed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { PrismaClient } from '@prisma/client';
import { makeCognitivePrisma } from '../../packages/database/test/helpers/cognitive-prisma-fake';
import { AiControlRepository } from '@emgloop/database';
import { parseArgs, requestRefusals, runRecordAiProviderPolicy, type RecordPolicyDeps } from './record-ai-provider-policy';
import { KNOWN_BUDGET_CLASSES, PLATFORM_ONLY_ORGANIZATION, runReadAiProviderPolicy } from './read-ai-provider-policy';

const WORKFLOW = join(__dirname, '..', '..', '.github', 'workflows', 'record-ai-provider-policy.yml');
const REASON = 'Anthropic commercial terms reviewed 2026-09-24: no training on inputs, 30-day retention, US region.';

function world() {
  const fake: any = makeCognitivePrisma({ also: ['aiControl', 'aiControlCurrent'] });
  const controls = new AiControlRepository(fake as PrismaClient);
  const lines: string[] = [];
  const deps: RecordPolicyDeps = {
    current: () => controls.providerPolicies(),
    record: async (r) => {
      const out = await controls.recordProviderPolicy(r);
      return out.ok ? { ok: true, result: out.result, version: out.entry.version } : { ok: false, refusal: out.refusal };
    },
    log: (l) => void lines.push(l),
  };
  return { fake, controls, lines, deps };
}

const args = (over: Partial<ReturnType<typeof parseArgs>> = {}) => ({
  ...parseArgs(['--provider', 'anthropic', '--ceiling', 'COMMUNICATION_CONTENT', '--state', 'ACTIVE', '--reason', REASON, '--reference', 'github:record-ai-provider-policy:run-1:matt']),
  ...over,
});

test('parsing: dry run unless --write, and a reason that reads "--write" is a reason', () => {
  assert.equal(args().write, false);
  assert.equal(parseArgs(['--provider', 'anthropic', '--write']).write, true);
  const tricky = parseArgs(['--provider', 'anthropic', '--reason', '--write']);
  assert.equal(tricky.write, false);
  assert.equal(tricky.reason, '--write');
  assert.equal(parseArgs(['--ceiling', 'communication_content']).ceiling, 'COMMUNICATION_CONTENT');
});

test('dry run: prints the current state and what it would record, and writes nothing', async () => {
  const w = world();
  assert.equal(await runRecordAiProviderPolicy(args(), w.deps), 'DRY_RUN');
  assert.equal(w.fake.aiControl.__rows.length, 0);
  assert.deepEqual(w.lines, [
    'event=CURRENT provider=anthropic state=NONE ceiling=- version=0',
    `event=WOULD_RECORD provider=anthropic state=ACTIVE ceiling=COMMUNICATION_CONTENT version=1 reasonChars=${REASON.length}`,
    'event=SUMMARY mode=DRY_RUN wrote=0',
  ]);
});

test('write: records the policy as OPERATIONS with the run as its reference; the same again is UNCHANGED', async () => {
  const w = world();
  assert.equal(await runRecordAiProviderPolicy(args({ write: true }), w.deps), 'RECORDED');
  const row = w.fake.aiControl.__rows[0];
  assert.deepEqual([row.scope, row.value, row.state, row.ceiling, row.actorKind, row.actorReference, row.version], ['PROVIDER_POLICY', 'anthropic', 'ACTIVE', 'COMMUNICATION_CONTENT', 'OPERATIONS', 'github:record-ai-provider-policy:run-1:matt', 1]);
  assert.equal(row.reason, REASON);
  assert.deepEqual(await w.controls.providerPolicies().then((p) => p.map((x) => [x.providerId, x.state, x.ceiling])), [['anthropic', 'ACTIVE', 'COMMUNICATION_CONTENT']]);
  assert.equal(await runRecordAiProviderPolicy(args({ write: true }), w.deps), 'UNCHANGED');
  assert.equal(w.fake.aiControl.__rows.length, 1, 'nothing appended');
  // Printed state is non-secret: no reason text, no reference, no URL.
  const out = w.lines.join('\n');
  assert.equal(out.includes(REASON), false);
  assert.equal(out.includes('run-1'), false);
  assert.doesNotMatch(out, /postgres(ql)?:\/\//);
});

test('kill: KILLED is recorded as the next version and the gateway would refuse the provider', async () => {
  const w = world();
  await runRecordAiProviderPolicy(args({ write: true }), w.deps);
  assert.equal(await runRecordAiProviderPolicy(args({ write: true, state: 'KILLED', ceiling: '', reason: 'Incident 2026-09-25: stop all sends.' }), w.deps), 'RECORDED');
  const [policy] = await w.controls.providerPolicies();
  assert.deepEqual([policy!.state, policy!.ceiling, policy!.version], ['KILLED', null, 2]);
});

test('refusals: unknown provider, state or ceiling; ACTIVE without a ceiling; no reason; a write without a reference', async () => {
  assert.deepEqual(requestRefusals(args({ provider: 'mystery' })), ['UNKNOWN_PROVIDER']);
  assert.deepEqual(requestRefusals(args({ state: 'ON' })), ['UNKNOWN_STATE']);
  assert.deepEqual(requestRefusals(args({ ceiling: 'EVERYTHING' })), ['UNKNOWN_CEILING']);
  assert.deepEqual(requestRefusals(args({ ceiling: '' })), ['CEILING_REQUIRED']);
  assert.deepEqual(requestRefusals(args({ reason: '' })), ['REASON_REQUIRED']);
  assert.deepEqual(requestRefusals(args({ reason: 'x'.repeat(501) })), ['REASON_REQUIRED']);
  assert.deepEqual(requestRefusals(args({ reason: 'two\nlines' })), ['REASON_REQUIRED']);
  assert.deepEqual(requestRefusals(args({ write: true, reference: '' })), ['REFERENCE_REQUIRED']);
  assert.deepEqual(requestRefusals(args({ write: false, reference: '' })), [], 'a dry run needs no reference');
  const w = world();
  assert.equal(await runRecordAiProviderPolicy(args({ write: true, ceiling: '' }), w.deps), 'FAILED_PRECONDITION');
  assert.equal(w.fake.aiControl.__rows.length, 0);
});

test('a policy moved between the read and the write is refused as STALE, never overwritten', async () => {
  const w = world();
  await runRecordAiProviderPolicy(args({ write: true }), w.deps);
  const racing: RecordPolicyDeps = {
    ...w.deps,
    // Somebody else recorded version 2 after this run read version 1.
    current: async () => {
      const read = await w.controls.providerPolicies();
      await w.controls.recordProviderPolicy({ providerId: 'anthropic', state: 'ACTIVE', ceiling: 'OPERATIONAL', reason: 'other', expectedVersion: 1, actor: { kind: 'OPERATIONS', reference: 'other-run' } });
      return read;
    },
  };
  assert.equal(await runRecordAiProviderPolicy(args({ write: true, state: 'KILLED', ceiling: '' }), racing), 'REFUSED');
  assert.ok(w.lines.includes('event=REFUSED provider=anthropic refusal=STALE'));
  assert.equal((await w.controls.providerPolicies())[0]!.ceiling, 'OPERATIONAL', 'the other decision stands');
});

/** The read-only probe over the same fake store (the budget and kill readers are exercised in record-ai-budget.test.ts). */
function readDeps(w: ReturnType<typeof world>, lines: string[]) {
  return {
    current: () => w.controls.providerPolicies(),
    operatingBudget: () => w.controls.operatingBudget(KNOWN_BUDGET_CLASSES),
    platformControls: () => w.controls.currentFor(PLATFORM_ONLY_ORGANIZATION),
    log: (l: string) => void lines.push(l),
  };
}

test('the read-only probe prints every provider and whether each task is admitted by G2 -- and writes nothing', async () => {
  const w = world();
  const lines: string[] = [];
  await runReadAiProviderPolicy(readDeps(w, lines));
  assert.ok(lines.includes('event=PROVIDER_POLICY provider=anthropic state=NONE ceiling=- version=0'));
  assert.ok(lines.includes('event=TASK_POLICY task=telegram.content.triage needs=COMMUNICATION_CONTENT admittedBy=none'));
  await runRecordAiProviderPolicy(args({ write: true }), w.deps);
  const after: string[] = [];
  await runReadAiProviderPolicy(readDeps(w, after));
  assert.ok(after.includes('event=TASK_POLICY task=telegram.content.triage needs=COMMUNICATION_CONTENT admittedBy=anthropic'), 'the staging record admits triage');
  assert.ok(after.some((l) => /^event=PROVIDER_POLICY provider=anthropic state=ACTIVE ceiling=COMMUNICATION_CONTENT version=1 recordedAt=/.test(l)));
  assert.ok(after.includes('event=PROVIDER_POLICY provider=openai state=NONE ceiling=- version=0'));
  assert.equal(w.fake.aiControl.__rows.length, 1, 'the probe wrote nothing');
});

// --- The workflow --------------------------------------------------------------------------------

const workflow = readFileSync(WORKFLOW, 'utf8');
const code = workflow.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

test('the workflow is manual only, environment-gated per stage, OIDC through the stage\'s migrate role, and pins both accounts', () => {
  assert.match(code, /^name: Record AI Provider Policy$/m);
  assert.match(code, /^on:\n  workflow_dispatch:\n/m, 'manual only');
  assert.doesNotMatch(code, /^\s+(push|pull_request|pull_request_target|schedule|workflow_run|workflow_call):/m);
  assert.match(code, /^  id-token: write$/m);
  assert.match(code, /^  contents: read$/m);
  for (const input of ['stage', 'provider', 'ceiling', 'state', 'reason', 'confirm']) assert.match(code, new RegExp(`^      ${input}:$`, 'm'), input);
  assert.match(code, /^    environment: connections-\$\{\{ needs\.confirm\.outputs\.stage \}\}$/m, 'the environment is the validated stage');
  assert.match(code, /^      STAGING_ACCOUNT: '065148797865'$/m);
  assert.match(code, /^      PRODUCTION_ACCOUNT: '080891698678'$/m);
  assert.deepEqual([...new Set([...code.matchAll(/vars\.([A-Z_]+)/g)].map((m) => m[1]))].sort(), ['CONNECTIONS_PRODUCTION_ACCOUNT_ID', 'CONNECTIONS_PRODUCTION_MIGRATE_ROLE_ARN', 'CONNECTIONS_STAGING_MIGRATE_ROLE_ARN']);
  const actions = [...code.matchAll(/uses:\s*(aws-actions\/\S+)/g)].map((m) => m[1]);
  assert.deepEqual(actions, ['aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd'], 'pinned v6.3.0');
  assert.match(code, /role-to-assume: \$\{\{ steps\.guard\.outputs\.role_arn \}\}/);
  assert.match(code, /allowed-account-ids: \$\{\{ steps\.guard\.outputs\.account \}\}/);
  assert.match(code, /if \[ "\$account" != "\$EXPECTED_ACCOUNT" \]; then/, 'STS must agree with the pinned account');
  // Reads only the stage's database-url secret; no GitHub secret at all.
  assert.match(code, /DB_SECRET=loop\/connections\/\$\{STAGE\}\/database-url/);
  assert.doesNotMatch(code, /secrets\./, 'no GitHub secret');
  assert.doesNotMatch(code, /DIRECT_DATABASE_URL/);
  assert.match(code, /::add-mask::\$url/);
  assert.doesNotMatch(code, /echo\s+"?\$\{?DATABASE_URL/);
  // Inputs never travel through the expression context.
  assert.doesNotMatch(code, /\$\{\{[^}]*inputs\./, 'no input is interpolated');
  assert.doesNotMatch(code, /if:.*inputs\./);
  // Dry run first, then the write, with a before and after read.
  const order = ['- name: Confirm', 'The stage names its account', 'Validate the requested policy', 'AWS credentials (OIDC, short-lived)', "The credentials are for the stage's account", "Read the stage's DATABASE_URL", '- name: Policies before', '- name: Dry run', '- name: Record', '- name: Policies after'];
  const positions = order.map((needle) => code.indexOf(needle));
  assert.ok(positions.every((p) => p >= 0), `every step present: ${positions.join(',')}`);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'steps run in this order');
  assert.match(code, /--write$/m, 'only the Record step writes');
  assert.equal((code.match(/--write/g) ?? []).length, 1);
});

/** The `run: |` body of the named step, dedented. */
function stepScript(name: string): string {
  const lines = workflow.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `the workflow has a step named ${name}`);
  const run = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  const indent = lines[run]!.search(/\S/) + 2;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

test('the Confirm step, executed: the stage and the phrase must agree; only padding and case are forgiven', () => {
  const script = stepScript('Confirm');
  const dir = mkdtempSync(join(tmpdir(), 'record-ai-policy-confirm-'));
  const attempt = (stage: string, confirm: string) => {
    const event = join(dir, 'event.json');
    const output = join(dir, `out-${Math.random()}`);
    writeFileSync(event, JSON.stringify({ inputs: { stage, confirm } }));
    writeFileSync(output, '');
    const r = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH ?? '', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output }, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, output: readFileSync(output, 'utf8') };
  };
  const ok = attempt('staging', 'record ai-provider-policy staging');
  assert.equal(ok.status, 0);
  assert.equal(ok.output.trim(), 'stage=staging', 'the validated stage is what the next job uses');
  assert.equal(attempt(' production ', '  Record  AI-Provider-Policy PRODUCTION \r\n').status, 0, 'padding, NBSP, CR and case are forgiven');
  const crossed = attempt('production', 'record ai-provider-policy staging');
  assert.equal(crossed.status, 1, 'the staging phrase never records in production');
  assert.match(crossed.stdout, /Confirmation text required: record ai-provider-policy production/);
  assert.match(crossed.stdout, /Received \d+ bytes; with whitespace made visible:/);
  assert.equal(attempt('staging', '').status, 1);
  assert.equal(attempt('staging', 'record ai-provider-policy stagingx').status, 1, 'a superstring refuses');
  assert.equal(attempt('dev', 'record ai-provider-policy dev').status, 1, 'an unknown stage refuses');
  assert.equal(attempt('', 'record ai-provider-policy ').status, 1);
});

test('the guard step, executed: the stage selects its pinned account, and a role elsewhere is refused', () => {
  const script = stepScript('The stage names its account, and the migrate role lives in it');
  const dir = mkdtempSync(join(tmpdir(), 'record-ai-policy-guard-'));
  const run = (env: Record<string, string>) => {
    const output = join(dir, `out-${Math.random()}`);
    const genv = join(dir, `env-${Math.random()}`);
    writeFileSync(output, '');
    writeFileSync(genv, '');
    const r = spawnSync('bash', ['-c', script], {
      env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: output, GITHUB_ENV: genv, STAGING_ACCOUNT: '065148797865', PRODUCTION_ACCOUNT: '080891698678', ...env },
      encoding: 'utf8',
    });
    return { status: r.status, output: readFileSync(output, 'utf8'), env: readFileSync(genv, 'utf8') };
  };
  const staging = run({ STAGE: 'staging', STAGING_ROLE_VAR: ' arn:aws:iam::065148797865:role/loop-connections-migrate-github ' });
  assert.equal(staging.status, 0);
  assert.match(staging.output, /^account=065148797865$/m);
  assert.match(staging.env, /^DB_SECRET=loop\/connections\/staging\/database-url$/m);
  assert.equal(run({ STAGE: 'staging', STAGING_ROLE_VAR: 'arn:aws:iam::080891698678:role/x' }).status, 1, 'a production role for staging is refused');
  const production = run({ STAGE: 'production', PRODUCTION_ROLE_VAR: 'arn:aws:iam::080891698678:role/loop-connections-migrate-github-production', PRODUCTION_ACCOUNT_ID_VAR: '080891698678' });
  assert.equal(production.status, 0);
  assert.match(production.env, /^DB_SECRET=loop\/connections\/production\/database-url$/m);
  assert.equal(run({ STAGE: 'production', PRODUCTION_ROLE_VAR: 'arn:aws:iam::080891698678:role/x', PRODUCTION_ACCOUNT_ID_VAR: '123456789012' }).status, 1, 'the environment must name the pinned account');
  assert.equal(run({ STAGE: 'production', PRODUCTION_ROLE_VAR: 'arn:aws:iam::065148797865:role/x', PRODUCTION_ACCOUNT_ID_VAR: '080891698678' }).status, 1);
  assert.equal(run({ STAGE: 'nope' }).status, 1);
});
