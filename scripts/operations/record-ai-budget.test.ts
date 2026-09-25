// Record AI Budget (PR 1, 2026-09-26): the script (dry run, write, validation refusals, an unreadable
// current record, argument refusals), the read-only probe's OPERATING_BUDGET and STORED_KILL lines, and
// the workflow that runs them -- including its Confirm and Validate steps, executed. An UNREADABLE
// budget is recoverable: the run warns and records the corrected figures as the next version.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { PrismaClient } from '@prisma/client';
import { makeCognitivePrisma } from '../../packages/database/test/helpers/cognitive-prisma-fake';
import { AiControlRepository } from '@emgloop/database';
import { AI_OPERATING_BUDGET_INITIAL } from '@emgloop/shared';
import { parseArgs, requestRefusals, runRecordAiBudget, type RecordBudgetDeps } from './record-ai-budget';
import { KNOWN_BUDGET_CLASSES, PLATFORM_ONLY_ORGANIZATION, runReadAiProviderPolicy, usd } from './read-ai-provider-policy';

const WORKFLOW = join(__dirname, '..', '..', '.github', 'workflows', 'record-ai-budget.yml');
const REASON = 'Initial operating budget, blueprint section 8, approved by Matt 2026-09-25.';
const REFERENCE = 'github:record-ai-budget:run-1:matt';

function world(files: Record<string, string> = {}) {
  const fake: any = makeCognitivePrisma({ also: ['aiControl', 'aiControlCurrent', 'organizationMembership'] });
  const controls = new AiControlRepository(fake as PrismaClient);
  const lines: string[] = [];
  const recorded: { expectedVersion: number }[] = [];
  const deps: RecordBudgetDeps = {
    current: () => controls.operatingBudget(KNOWN_BUDGET_CLASSES),
    currentVersion: async () => (await controls.operatingBudgetVersion()).version,
    record: async (r) => {
      recorded.push({ expectedVersion: r.expectedVersion });
      const out = await controls.recordOperatingBudget({ ...r, knownClasses: KNOWN_BUDGET_CLASSES });
      return out.ok ? { ok: true, result: out.result, version: out.entry.version } : { ok: false, refusal: out.refusal };
    },
    readSettingsFile: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
    log: (l) => void lines.push(l),
  };
  return { fake, controls, lines, recorded, deps };
}

const initial = (extra: string[] = []) => parseArgs(['--preset', 'initial', '--reason', REASON, ...extra]);
const fromFile = (extra: string[] = []) => parseArgs(['--settings-file', '/tmp/budget.json', '--reason', REASON, ...extra]);
const plain = () => JSON.parse(JSON.stringify(AI_OPERATING_BUDGET_INITIAL));

test('dollars are exact: integer micro-dollars, at least two decimals', () => {
  assert.equal(usd(20_000_000), '20.00');
  assert.equal(usd(2_500_000), '2.50');
  assert.equal(usd(1_234_567), '1.234567');
  assert.equal(usd(0), '0.00');
});

test('preset initial: validates and dry-runs, printing the current and requested budget in dollars, and writes nothing', async () => {
  const w = world();
  assert.equal(await runRecordAiBudget(initial(), w.deps), 'DRY_RUN');
  assert.equal(w.fake.aiControl.__rows.length, 0);
  assert.equal(w.recorded.length, 0);
  assert.equal(w.lines[0], 'event=CURRENT state=NONE version=0 admission=reviewed-policy emergencyUsd=25.00');
  assert.ok(w.lines.includes('event=VALIDATION result=VALID'));
  assert.ok(w.lines.some((l) => l.startsWith('event=REQUESTED label=operating.initial.1 organizationDailyUsd=20.00 emergencyUsd=25.00 forwardReserveUsd=1.50 backgroundDeferAtOrganizationSpendUsd=12.00 backgroundDeferAtForwardUsed=0.75 organizationDailyInvocations=300 globalDailyInvocations=360 breaker=10/60min')));
  assert.ok(w.lines.includes('event=REQUESTED_LANE lane=FORWARD dailyUsd=8.00 maxInvocations=-'));
  assert.ok(w.lines.includes('event=REQUESTED_LANE lane=INTERACTIVE dailyUsd=2.50 maxInvocations=-'));
  assert.ok(w.lines.includes('event=REQUESTED_LANE lane=BACKGROUND dailyUsd=2.00 maxInvocations=60'));
  assert.ok(w.lines.includes('event=REQUESTED_CLASS class=telegram-content-triage maxInvocations=70'));
  assert.deepEqual(w.lines.slice(-2), [`event=WOULD_RECORD label=operating.initial.1 version=1 reasonChars=${REASON.length}`, 'event=SUMMARY mode=DRY_RUN wrote=0']);
});

test('--write records the budget as OPERATIONS, naming the version it read; the same again is UNCHANGED; a change appends v2', async () => {
  const w = world();
  assert.equal(await runRecordAiBudget(initial(['--reference', REFERENCE, '--write']), w.deps), 'RECORDED');
  assert.deepEqual(w.recorded, [{ expectedVersion: 0 }]);
  const row = w.fake.aiControl.__rows[0];
  assert.deepEqual([row.scope, row.value, row.state, row.actorKind, row.actorReference, row.version], ['BUDGET', 'operating', 'ACTIVE', 'OPERATIONS', REFERENCE, 1]);
  const read = await w.controls.operatingBudget(KNOWN_BUDGET_CLASSES);
  assert.equal(read.state, 'RECORDED');
  assert.ok(w.lines.includes(`event=RECORDED label=operating.initial.1 version=1 actor=OPERATIONS reasonChars=${REASON.length}`));

  // A dry run now sees the recorded budget and would change nothing.
  const again: string[] = [];
  assert.equal(await runRecordAiBudget(initial(), { ...w.deps, log: (l) => void again.push(l) }), 'DRY_RUN');
  assert.ok(again.some((l) => l.startsWith('event=CURRENT state=RECORDED version=1 recordedAt=') && l.includes('label=operating.initial.1 organizationDailyUsd=20.00')));
  assert.ok(again.includes(`event=WOULD_BE_UNCHANGED label=operating.initial.1 version=1 reasonChars=${REASON.length}`));

  assert.equal(await runRecordAiBudget(initial(['--reference', REFERENCE, '--write']), w.deps), 'UNCHANGED');
  assert.equal(w.fake.aiControl.__rows.length, 1, 'nothing appended');
  assert.deepEqual(w.recorded.at(-1), { expectedVersion: 1 });

  const raised = { ...plain(), label: 'operating.2026-10-01.1', organizationDailyCostMicros: 30_000_000, emergencyCostMicros: 35_000_000 };
  const files = { '/tmp/budget.json': JSON.stringify(raised) };
  const w2: RecordBudgetDeps = { ...w.deps, readSettingsFile: async (p) => files[p as keyof typeof files]! };
  assert.equal(await runRecordAiBudget(fromFile(['--reference', REFERENCE, '--write']), w2), 'RECORDED');
  assert.deepEqual(w.recorded.at(-1), { expectedVersion: 1 });
  const now = await w.controls.operatingBudget(KNOWN_BUDGET_CLASSES);
  assert.ok(now.state === 'RECORDED' && now.version === 2 && now.budget.organizationDailyCostMicros === 30_000_000);

  // Printed state is non-secret: no reason text, no reference, no URL.
  const out = [...w.lines, ...again].join('\n');
  assert.equal(out.includes(REASON), false);
  assert.equal(out.includes('run-1'), false);
  assert.doesNotMatch(out, /postgres(ql)?:\/\//);
});

test('an invalid settings file is refused with every code printed, and nothing is written (dry run or write)', async () => {
  const cases: [string, unknown, string[]][] = [
    ['unknown key', { ...plain(), organisationDailyCostMicros: 1 }, ['UNKNOWN_KEY']],
    ['above maximum', { ...plain(), organizationDailyCostMicros: 101_000_000, emergencyCostMicros: 126_000_000 }, ['AMOUNT_ABOVE_MAXIMUM']],
    ['lanes exceed the organization', { ...plain(), organizationDailyCostMicros: 10_000_000 }, ['LANES_EXCEED_ORGANIZATION']],
    ['unknown class', { ...plain(), classInvocations: { 'mystery-class': 5 } }, ['CLASS_UNKNOWN']],
  ];
  for (const [name, settings, codes] of cases) {
    for (const write of [false, true]) {
      const w = world({ '/tmp/budget.json': JSON.stringify(settings) });
      const result = await runRecordAiBudget(fromFile(write ? ['--reference', REFERENCE, '--write'] : []), w.deps);
      assert.equal(result, 'INVALID', name);
      const line = w.lines.find((l) => l.startsWith('event=VALIDATION'));
      assert.ok(line?.startsWith('event=VALIDATION result=INVALID refusals='), name);
      for (const code of codes) assert.ok(line!.split('refusals=')[1]!.split('+').includes(code), `${name}: ${code} in ${line}`);
      assert.equal(w.recorded.length, 0, `${name}: nothing sent to the store`);
      assert.equal(w.fake.aiControl.__rows.length, 0, `${name}: nothing written`);
      assert.equal(w.lines.at(-1), `event=SUMMARY mode=${write ? 'WRITE' : 'DRY_RUN'} wrote=0`);
    }
  }
  const notJson = world({ '/tmp/budget.json': '{not json' });
  assert.equal(await runRecordAiBudget(fromFile(), notJson.deps), 'FAILED_PRECONDITION');
  assert.deepEqual(notJson.lines, ['event=PRECONDITION_FAILED reasons=SETTINGS_NOT_JSON']);
  const missing = world();
  assert.equal(await runRecordAiBudget(fromFile(), missing.deps), 'FAILED_PRECONDITION');
  assert.deepEqual(missing.lines, ['event=PRECONDITION_FAILED reasons=SETTINGS_FILE_UNREADABLE']);
});

test('an UNREADABLE current budget is recoverable: a warning, then a dry run and a write naming its version', async () => {
  const w = world();
  assert.equal(await runRecordAiBudget(initial(['--reference', REFERENCE, '--write']), w.deps), 'RECORDED');
  // The stored figures stop validating (a class the reviewed policy no longer has, say): the gateway
  // now refuses every call.
  w.fake.aiControl.__rows[0].settings = { ...plain(), classInvocations: { 'retired-class': 5 } };
  assert.equal((await w.controls.operatingBudget(KNOWN_BUDGET_CLASSES)).state, 'UNREADABLE');

  const dry: string[] = [];
  assert.equal(await runRecordAiBudget(initial(), { ...w.deps, log: (l) => void dry.push(l) }), 'DRY_RUN');
  assert.deepEqual(dry.slice(0, 2), [
    'event=CURRENT state=UNREADABLE version=1',
    'event=RECOVERY current budget does not validate; the gateway is refusing every AI call until corrected figures are recorded',
  ]);
  assert.ok(dry.includes('event=VALIDATION result=VALID'));
  assert.ok(dry.includes(`event=WOULD_RECORD label=operating.initial.1 version=2 reasonChars=${REASON.length}`));
  assert.equal(w.fake.aiControl.__rows.length, 1, 'the dry run wrote nothing');
  assert.equal(w.recorded.length, 1);

  assert.equal(await runRecordAiBudget(initial(['--reference', REFERENCE, '--write']), w.deps), 'RECORDED');
  assert.deepEqual(w.recorded.at(-1), { expectedVersion: 1 }, 'the write names the unreadable version it replaces');
  const repaired = await w.controls.operatingBudget(KNOWN_BUDGET_CLASSES);
  assert.ok(repaired.state === 'RECORDED' && repaired.version === 2, 'the corrected figures are current');
});

test('a database error is not UNREADABLE: it throws, and nothing is written', async () => {
  const w = world();
  const deps: RecordBudgetDeps = {
    ...w.deps,
    current: async () => {
      throw new Error('connection reset');
    },
  };
  await assert.rejects(runRecordAiBudget(initial(['--reference', REFERENCE, '--write']), deps), /connection reset/);
  assert.equal(w.recorded.length, 0);
  assert.equal(w.fake.aiControl.__rows.length, 0);
});

test('a budget moved between the read and the write is refused as STALE; a database without the migration as NOT_MIGRATED', async () => {
  const w = world();
  await runRecordAiBudget(initial(['--reference', REFERENCE, '--write']), w.deps);
  const racing: RecordBudgetDeps = {
    ...w.deps,
    current: async () => {
      const read = await w.controls.operatingBudget(KNOWN_BUDGET_CLASSES);
      await w.controls.recordOperatingBudget({ settings: { ...plain(), label: 'other.1' }, knownClasses: KNOWN_BUDGET_CLASSES, reason: 'other', expectedVersion: 1, actor: { kind: 'OPERATIONS', reference: 'other-run' } });
      return read;
    },
  };
  assert.equal(await runRecordAiBudget(initial(['--reference', REFERENCE, '--write', '--reason', 'second']), racing), 'REFUSED');
  assert.ok(w.lines.includes('event=REFUSED refusal=STALE'));

  const unmigrated = world();
  const deps: RecordBudgetDeps = { ...unmigrated.deps, record: async () => ({ ok: false, refusal: 'NOT_MIGRATED' }) };
  assert.equal(await runRecordAiBudget(initial(['--reference', REFERENCE, '--write']), deps), 'REFUSED');
  assert.ok(unmigrated.lines.includes('event=REFUSED refusal=NOT_MIGRATED'));
});

test('argument refusals: both sources, neither, an unknown preset, no reason, a write without a reference', async () => {
  assert.deepEqual(requestRefusals(parseArgs(['--preset', 'initial', '--settings-file', '/tmp/b.json', '--reason', REASON])), ['SOURCE_AMBIGUOUS']);
  assert.deepEqual(requestRefusals(parseArgs(['--reason', REASON])), ['SOURCE_REQUIRED']);
  assert.deepEqual(requestRefusals(parseArgs(['--preset', 'generous', '--reason', REASON])), ['UNKNOWN_PRESET']);
  assert.deepEqual(requestRefusals(parseArgs(['--preset', 'initial'])), ['REASON_REQUIRED']);
  assert.deepEqual(requestRefusals(initial(['--reason', 'x'.repeat(501)])), ['REASON_REQUIRED']);
  assert.deepEqual(requestRefusals(initial(['--reason', 'two\nlines'])), ['REASON_REQUIRED']);
  assert.deepEqual(requestRefusals(initial(['--write'])), ['REFERENCE_REQUIRED']);
  assert.deepEqual(requestRefusals(initial()), [], 'a dry run needs no reference');
  // A reason that reads "--write" is a reason.
  const tricky = parseArgs(['--preset', 'initial', '--reason', '--write']);
  assert.equal(tricky.write, false);
  assert.equal(tricky.reason, '--write');

  const both = world();
  assert.equal(await runRecordAiBudget(parseArgs(['--preset', 'initial', '--settings-file', '/tmp/b.json', '--reason', REASON, '--reference', REFERENCE, '--write']), both.deps), 'FAILED_PRECONDITION');
  assert.deepEqual(both.lines, ['event=PRECONDITION_FAILED reasons=SOURCE_AMBIGUOUS']);
  const noReason = world();
  assert.equal(await runRecordAiBudget(parseArgs(['--preset', 'initial', '--reference', REFERENCE, '--write']), noReason.deps), 'FAILED_PRECONDITION');
  assert.deepEqual(noReason.lines, ['event=PRECONDITION_FAILED reasons=REASON_REQUIRED']);
  assert.equal(both.fake.aiControl.__rows.length + noReason.fake.aiControl.__rows.length, 0);
});

// --- The read-only probe -------------------------------------------------------------------------

async function probe(w: ReturnType<typeof world>): Promise<string[]> {
  const lines: string[] = [];
  await runReadAiProviderPolicy({
    current: () => w.controls.providerPolicies(),
    operatingBudget: () => w.controls.operatingBudget(KNOWN_BUDGET_CLASSES),
    platformControls: () => w.controls.currentFor(PLATFORM_ONLY_ORGANIZATION),
    log: (l) => void lines.push(l),
  });
  return lines;
}

test('the probe prints the operating budget: NONE with the default emergency ceiling, then RECORDED in dollars', async () => {
  const w = world();
  const before = await probe(w);
  assert.ok(before.includes('event=OPERATING_BUDGET state=NONE'));
  assert.ok(before.includes('event=EMERGENCY_CEILING source=DEFAULT usd=25.00 window=trailing-24h'));
  assert.ok(before.includes('event=STORED_KILL_SUMMARY killed=0'));
  assert.match(before.at(-1)!, /^event=SUMMARY providers=\d+ recorded=0 wrote=0$/, 'SUMMARY stays last and unchanged');

  await runRecordAiBudget(initial(['--reference', REFERENCE, '--write']), w.deps);
  const after = await probe(w);
  assert.ok(after.some((l) => /^event=OPERATING_BUDGET state=RECORDED version=1 recordedAt=\S+ label=operating\.initial\.1 organizationDailyUsd=20\.00 emergencyUsd=25\.00 forwardReserveUsd=1\.50 /.test(l)));
  assert.ok(after.includes('event=OPERATING_BUDGET_LANE lane=SYNTHESIS dailyUsd=6.00 maxInvocations=-'));
  assert.ok(after.includes('event=OPERATING_BUDGET_CLASS class=case-explanation maxInvocations=6'));
  assert.ok(after.includes('event=EMERGENCY_CEILING source=RECORDED usd=25.00 window=trailing-24h'));
  assert.equal(w.fake.aiControl.__rows.length, 1, 'the probe wrote nothing');

  const unreadable = await (async () => {
    const lines: string[] = [];
    await runReadAiProviderPolicy({ current: async () => [], operatingBudget: async () => ({ state: 'UNREADABLE' }), platformControls: async () => [], log: (l) => void lines.push(l) });
    return lines;
  })();
  assert.ok(unreadable.includes('event=OPERATING_BUDGET state=UNREADABLE'));
});

test('the probe prints every current KILLED platform switch -- and never an organization\'s own control', async () => {
  const w = world();
  const op = (scope: 'GLOBAL' | 'PROVIDER' | 'MODEL' | 'TASK', value: string | null, state: 'ACTIVE' | 'KILLED', expectedVersion = 0) =>
    w.controls.recordPlatformControl({ scope, value, state, reason: 'incident', expectedVersion, operationsReference: 'run-x' });
  assert.ok((await op('PROVIDER', 'openai', 'ACTIVE')).ok);
  assert.ok((await op('PROVIDER', 'openai', 'KILLED', 1)).ok);
  assert.ok((await op('TASK', 'telegram.content.triage', 'KILLED')).ok);
  assert.ok((await op('GLOBAL', null, 'ACTIVE')).ok, 'an ACTIVE switch is not a kill');
  // An organization's own TASK kill is that organization's, not a platform stop.
  await w.fake.organizationMembership.create({ data: { organizationId: 'org-1', userId: 'u-1', status: 'ACTIVE', role: 'OWNER' } });
  const orgKill = await w.controls.recordOrganizationControl('org-1', { scope: 'TASK', taskId: 'mail.reply.draft', state: 'KILLED', reason: 'org stop', expectedVersion: 0, actorUserId: 'u-1' });
  assert.ok(orgKill.ok, 'the organization kill is recorded (and must still not print)');

  const lines = await probe(w);
  const kills = lines.filter((l) => l.startsWith('event=STORED_KILL '));
  assert.equal(kills.length, 2);
  assert.match(kills[0]!, /^event=STORED_KILL scope=PROVIDER value=openai version=2 recordedAt=\S+$/);
  assert.match(kills[1]!, /^event=STORED_KILL scope=TASK value=telegram\.content\.triage version=1 recordedAt=\S+$/);
  assert.ok(lines.includes('event=STORED_KILL_SUMMARY killed=2'));
  assert.equal(kills.some((l) => l.includes('mail.reply.draft')), false, 'the organization\'s own kill is not a platform kill');
});

// --- The workflow --------------------------------------------------------------------------------

const workflow = readFileSync(WORKFLOW, 'utf8');
const code = workflow.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');

test('the workflow is manual only, environment-gated per stage, OIDC through the stage\'s migrate role, and pins both accounts', () => {
  assert.match(code, /^name: Record AI Budget$/m);
  assert.match(code, /^on:\n  workflow_dispatch:\n/m, 'manual only');
  assert.doesNotMatch(code, /^\s+(push|pull_request|pull_request_target|schedule|workflow_run|workflow_call):/m);
  assert.match(code, /^  id-token: write$/m);
  assert.match(code, /^  contents: read$/m);
  for (const input of ['stage', 'preset', 'settings_json', 'reason', 'confirm']) assert.match(code, new RegExp(`^      ${input}:$`, 'm'), input);
  assert.match(code, /^    environment: connections-\$\{\{ needs\.confirm\.outputs\.stage \}\}$/m);
  assert.match(code, /^      STAGING_ACCOUNT: '065148797865'$/m);
  assert.match(code, /^      PRODUCTION_ACCOUNT: '080891698678'$/m);
  assert.deepEqual([...new Set([...code.matchAll(/vars\.([A-Z_]+)/g)].map((m) => m[1]))].sort(), ['CONNECTIONS_PRODUCTION_ACCOUNT_ID', 'CONNECTIONS_PRODUCTION_MIGRATE_ROLE_ARN', 'CONNECTIONS_STAGING_MIGRATE_ROLE_ARN']);
  const actions = [...code.matchAll(/uses:\s*(aws-actions\/\S+)/g)].map((m) => m[1]);
  assert.deepEqual(actions, ['aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd'], 'pinned v6.3.0');
  assert.match(code, /if \[ "\$account" != "\$EXPECTED_ACCOUNT" \]; then/);
  assert.match(code, /DB_SECRET=loop\/connections\/\$\{STAGE\}\/database-url/);
  assert.doesNotMatch(code, /secrets\./, 'no GitHub secret');
  assert.doesNotMatch(code, /DIRECT_DATABASE_URL/);
  assert.match(code, /::add-mask::\$url/);
  assert.doesNotMatch(code, /echo\s+"?\$\{?DATABASE_URL/);
  // Inputs -- above all the custom JSON -- never travel through the expression context or GITHUB_ENV.
  assert.doesNotMatch(code, /\$\{\{[^}]*inputs\./, 'no input is interpolated');
  assert.doesNotMatch(code, /if:.*inputs\./);
  assert.doesNotMatch(code, /settings[^\n]*>>\s*"\$GITHUB_ENV"/);
  const order = ['- name: Confirm', 'The stage names its account', 'Validate the requested budget', 'AWS credentials (OIDC, short-lived)', "The credentials are for the stage's account", "Read the stage's DATABASE_URL", '- name: Controls before', '- name: Dry run', '- name: Record', '- name: Controls after', '- name: How to read the output'];
  const positions = order.map((needle) => code.indexOf(needle));
  assert.ok(positions.every((p) => p >= 0), `every step present: ${positions.join(',')}`);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'steps run in this order');
  assert.equal((code.match(/--write/g) ?? []).length, 1, 'only the Record step writes');
  assert.match(code, /npm run read:ai-provider-policy/);
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
  const dir = mkdtempSync(join(tmpdir(), 'record-ai-budget-confirm-'));
  const attempt = (stage: string, confirm: string) => {
    const event = join(dir, 'event.json');
    const output = join(dir, `out-${Math.random()}`);
    writeFileSync(event, JSON.stringify({ inputs: { stage, confirm } }));
    writeFileSync(output, '');
    const r = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH ?? '', GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output }, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, output: readFileSync(output, 'utf8') };
  };
  const ok = attempt('staging', 'record ai-budget staging');
  assert.equal(ok.status, 0);
  assert.equal(ok.output.trim(), 'stage=staging');
  assert.equal(attempt(' production ', '  Record  AI-Budget PRODUCTION \r\n').status, 0);
  const crossed = attempt('production', 'record ai-budget staging');
  assert.equal(crossed.status, 1, 'the staging phrase never records in production');
  assert.match(crossed.stdout, /Confirmation text required: record ai-budget production/);
  assert.equal(attempt('staging', 'record ai-provider-policy staging').status, 1, 'the other workflow\'s phrase refuses');
  assert.equal(attempt('staging', '').status, 1);
  assert.equal(attempt('dev', 'record ai-budget dev').status, 1);
});

test('the Validate step, executed: custom JSON reaches a file and must be one JSON object; initial takes none', () => {
  const script = stepScript('Validate the requested budget');
  const run = (inputs: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'record-ai-budget-validate-'));
    const event = join(dir, 'event.json');
    const genv = join(dir, 'env');
    writeFileSync(event, JSON.stringify({ inputs }));
    writeFileSync(genv, '');
    const r = spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH ?? '', GITHUB_EVENT_PATH: event, GITHUB_ENV: genv, RUNNER_TEMP: dir, STAGE: 'staging' }, encoding: 'utf8' });
    const read = (f: string) => {
      try {
        return readFileSync(join(dir, f), 'utf8');
      } catch {
        return null;
      }
    };
    return { status: r.status, env: readFileSync(genv, 'utf8'), settings: read('budget-settings.json'), reason: read('budget-reason.txt') };
  };
  const ok = run({ preset: 'initial', settings_json: '', reason: REASON });
  assert.equal(ok.status, 0);
  assert.equal(ok.env, 'BUDGET_PRESET=initial\n');
  assert.equal(ok.reason, REASON);
  assert.equal(ok.settings, null);

  const hostile = JSON.stringify({ ...plain(), label: 'x$(touch /tmp/pwned)`id`' });
  const custom = run({ preset: 'custom', settings_json: `  ${hostile} `, reason: REASON });
  assert.equal(custom.status, 0);
  assert.equal(custom.settings, hostile, 'the JSON reaches the file byte for byte, never a shell');
  assert.equal(custom.env, 'BUDGET_PRESET=custom\n', 'and never GITHUB_ENV');

  assert.equal(run({ preset: 'initial', settings_json: '{}', reason: REASON }).status, 1, 'initial takes no JSON');
  assert.equal(run({ preset: 'custom', settings_json: '', reason: REASON }).status, 1);
  assert.equal(run({ preset: 'custom', settings_json: '[1,2]', reason: REASON }).status, 1, 'an array is not an object');
  assert.equal(run({ preset: 'custom', settings_json: '{not json', reason: REASON }).status, 1);
  assert.equal(run({ preset: 'custom', settings_json: '{"a":1}\n{"b":2}', reason: REASON }).status, 1, 'one line only');
  assert.equal(run({ preset: 'generous', settings_json: '', reason: REASON }).status, 1);
  assert.equal(run({ preset: 'initial', settings_json: '', reason: '' }).status, 1);
});
