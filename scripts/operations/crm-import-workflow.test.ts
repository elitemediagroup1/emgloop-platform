// The "CRM Outreach Import" production workflow (CRM slice 5, PR B) and the command's production target.
//
// Static checks read the committed workflow; the guard step is EXECUTED with crafted dispatch payloads,
// the way GitHub would run it, so its refusals are proven rather than read. Nothing here reaches AWS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { checkTarget, PRODUCTION_COMMANDS, readSourceBytes, sourceInventory } from './crm-import';

const WORKFLOW = readFileSync(fileURLToPath(new URL('../../.github/workflows/crm-outreach-import.yml', import.meta.url)), 'utf8');
const SHA = 'a'.repeat(64);

/** The body of one step's `run:` block, as the runner sees it. */
function step(name: string): string {
  const at = WORKFLOW.indexOf(`- name: ${name}`);
  assert.ok(at >= 0, `step "${name}" exists`);
  const next = WORKFLOW.indexOf('\n      - name:', at + 1);
  const block = WORKFLOW.slice(at, next < 0 ? undefined : next);
  const run = block.indexOf('run: |\n');
  return block
    .slice(run + 'run: |\n'.length)
    .split('\n')
    .map((l) => l.replace(/^ {10}/, ''))
    .join('\n');
}

const GOOD_ENV = {
  GITHUB_REF: 'refs/heads/main',
  PRODUCTION_ACCOUNT: '080891698678',
  PRODUCTION_ACCOUNT_ID_VAR: '080891698678',
  MIGRATE_ROLE_VAR: 'arn:aws:iam::080891698678:role/loop-connections-migrate-github-production',
  IMPORT_ROLE_VAR: 'arn:aws:iam::080891698678:role/loop-crm-import-github-production',
  IMPORT_BUCKET_VAR: 'loop-crm-import-080891698678',
  ORGANIZATION_VAR: 'emg-talent',
};

function runGuard(inputs: Record<string, string>, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'crm-import-guard-'));
  const event = join(dir, 'event.json');
  writeFileSync(event, JSON.stringify({ inputs }));
  for (const f of ['env', 'out']) writeFileSync(join(dir, f), '');
  const r = spawnSync('bash', ['-c', step('Guard and validate the inputs (before any credential)')], {
    env: { PATH: process.env.PATH ?? '', ...GOOD_ENV, ...env, GITHUB_EVENT_PATH: event, GITHUB_ENV: join(dir, 'env'), GITHUB_OUTPUT: join(dir, 'out'), RUNNER_TEMP: dir, GITHUB_SHA: 'deadbeef' },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, env: readFileSync(join(dir, 'env'), 'utf8'), outputs: readFileSync(join(dir, 'out'), 'utf8') };
}

const DRY = {
  mode: 'dry-run',
  source_key: 'crm-import/source/outreach-2026-10.csv',
  expected_source_sha256: SHA,
  config_key: 'crm-import/config/outreach-2026-10.json',
  expected_config_sha256: 'b'.repeat(64),
  organization: 'emg-talent',
  actor_user_id: 'cmabcdef0123456789',
  importer_version: 'crm-outreach-import.v2',
  confirm: 'crm import dry-run emg-talent',
};

test('the guard admits a well-formed dry run and writes only validated values', () => {
  const r = runGuard(DRY);
  assert.equal(r.code, 0, r.out);
  assert.match(r.env, /^MODE=dry-run$/m);
  assert.match(r.env, /^SOURCE_KEY=crm-import\/source\/outreach-2026-10\.csv$/m);
  assert.match(r.env, /^ACTOR_USER_ID=cmabcdef0123456789$/m);
  assert.match(r.outputs, /^needs_db=true$/m);
  assert.match(r.outputs, /^import_role=arn:aws:iam::080891698678:role\/loop-crm-import-github-production$/m);
});

test('the guard refuses everything else, before any credential is requested', () => {
  const refusals: [string, Record<string, string>, Record<string, string>?][] = [
    ['a feature branch', DRY, { GITHUB_REF: 'refs/heads/feat/x' }],
    ['an unknown mode', { ...DRY, mode: 'apply', confirm: 'crm import apply emg-talent' }],
    ['approve without a dry run id', { ...DRY, mode: 'approve', source_key: '', expected_source_sha256: '', config_key: '', expected_config_sha256: '', confirm: 'crm import approve emg-talent' }],
    ['the wrong organization', { ...DRY, organization: 'someone-else', confirm: 'crm import dry-run someone-else' }],
    ['an unpinned environment organization', DRY, { ORGANIZATION_VAR: '' }],
    ['another importer version', { ...DRY, importer_version: 'crm-outreach-import.v1' }],
    ['a missing confirmation', { ...DRY, confirm: 'yes' }],
    ['a source outside the source prefix', { ...DRY, source_key: 'crm-import/review/x.csv' }],
    ['a traversal', { ...DRY, source_key: 'crm-import/source/../review/x.csv' }],
    ['a missing hash', { ...DRY, expected_source_sha256: '' }],
    ['an uppercase or short hash', { ...DRY, expected_source_sha256: 'A'.repeat(64) }],
    ['an email as the actor', { ...DRY, actor_user_id: 'matt@example.test' }],
    ['the wrong account', DRY, { PRODUCTION_ACCOUNT_ID_VAR: '065148797865' }],
    ['another role', DRY, { IMPORT_ROLE_VAR: 'arn:aws:iam::080891698678:role/loop-connections-github-deploy-production' }],
    ['another bucket', DRY, { IMPORT_BUCKET_VAR: 'some-public-bucket' }],
    ['a migrate role in another account', DRY, { MIGRATE_ROLE_VAR: 'arn:aws:iam::065148797865:role/loop-connections-migrate-github' }],
  ];
  for (const [label, inputs, env] of refusals) {
    const r = runGuard(inputs, env);
    assert.notEqual(r.code, 0, `${label} is refused`);
    assert.equal(r.outputs, '', `${label}: no credential output was written`);
    assert.equal(r.env, '', `${label}: nothing was handed to a later step`);
  }
});

test('record-config replacement is explicit, record-config-only, and reaches only the record-config CLI path', () => {
  const base = {
    mode: 'record-config',
    source_key: '',
    expected_source_sha256: '',
    config_key: DRY.config_key,
    expected_config_sha256: DRY.expected_config_sha256,
    organization: 'emg-talent',
    actor_user_id: DRY.actor_user_id,
    replace_existing_config: 'true',
    importer_version: 'crm-outreach-import.v2',
    confirm: 'crm import record-config emg-talent',
  };
  const r = runGuard(base);
  assert.equal(r.code, 0, r.out);
  assert.match(r.env, /^REPLACE_EXISTING_CONFIG=true$/m);

  const dry = runGuard({ ...DRY, replace_existing_config: 'true' });
  assert.notEqual(dry.code, 0, 'dry-run cannot request mapping replacement');
  assert.match(dry.out, /allowed only for record-config/);

  const run = step('Run the importer (codes, counts, ids and hashes only)');
  assert.match(run, /record_args=.*record-config/);
  assert.match(run, /record_args\+\=\(--replace\)/);
  assert.match(run, /REPLACE_EXISTING_CONFIG/);
});

test('approve is production-commissioned only for a specific reviewed dry-run id', () => {
  const input = {
    mode: 'approve',
    source_key: '',
    expected_source_sha256: '',
    config_key: '',
    expected_config_sha256: '',
    organization: 'emg-talent',
    actor_user_id: DRY.actor_user_id,
    dry_run_id: 'cmuyw5rv90002szaez29oo7yc',
    replace_existing_config: 'false',
    importer_version: 'crm-outreach-import.v2',
    confirm: 'crm import approve emg-talent',
  };
  const r = runGuard(input);
  assert.equal(r.code, 0, r.out);
  assert.match(r.env, /^MODE=approve$/m);
  assert.match(r.env, /^DRY_RUN_ID=cmuyw5rv90002szaez29oo7yc$/m);
  assert.match(r.outputs, /^needs_db=true$/m);

  const run = step('Run the importer (codes, counts, ids and hashes only)');
  assert.match(run, /approve --dry-run-id "\$\{DRY_RUN_ID\}"/);
});

test('validate and inventory need no database and no actor', () => {
  const r = runGuard({ mode: 'inventory', source_key: DRY.source_key, expected_source_sha256: SHA, organization: 'emg-talent', importer_version: 'crm-outreach-import.v2', confirm: 'crm import inventory emg-talent' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.outputs, /^needs_db=false$/m);
  assert.doesNotMatch(r.env, /ACTOR_USER_ID/);
});

test('record-config passes --replace only when the reviewed replacement input is true', () => {
  const run = step('Run the importer (codes, counts, ids and hashes only)');
  assert.match(run, /REPLACE_EXISTING_CONFIG:-false/);
  assert.match(run, /record_args\+\=\(--replace\)/);
  assert.match(run, /"\$\{cli\[@\]\}" "\$\{record_args\[@\]\}"/);
});

test('the workflow never offers APPLY or abandon, never traces, never prints the source, never publishes an artifact', () => {
  assert.doesNotMatch(WORKFLOW, /set -x|set -o xtrace|bash -x/);
  assert.doesNotMatch(WORKFLOW, /cat\s+"?\$\{?WORK\}?\/(source|config)/, 'the source and config are never printed');
  assert.doesNotMatch(WORKFLOW, /upload-artifact/, 'review files never become GitHub artifacts');
  assert.doesNotMatch(WORKFLOW, /\b(apply|abandon)\s+--/);
  assert.match(WORKFLOW, /\bapprove\s+--dry-run-id/);
  assert.match(WORKFLOW, /umask 077/);
  assert.match(step('Remove the source, the configuration and the review files from the runner'), /rm -rf "\$\{RUNNER_TEMP\}\/crm-import"/);
  assert.match(WORKFLOW, /- name: Remove the source, the configuration and the review files from the runner\n {8}if: always\(\)/);
  assert.match(WORKFLOW, /crm-import\/review\/run-\$\{GITHUB_RUN_ID\}/, 'review artifacts go to the private review prefix');
});

test('the SHA-256 is verified before the importer runs, and the hash key reaches only the importer step', () => {
  const fetchAt = WORKFLOW.indexOf('- name: Fetch the private objects and verify their SHA-256');
  const runAt = WORKFLOW.indexOf('- name: Run the importer');
  assert.ok(fetchAt > 0 && runAt > fetchAt);
  assert.match(step('Fetch the private objects and verify their SHA-256 (before anything parses them)'), /SHA256_MISMATCH/);
  assert.equal(WORKFLOW.match(/secrets\.COGNITIVE_HASH_SECRET/g)?.length, 1);
  const runStep = WORKFLOW.slice(runAt, WORKFLOW.indexOf('\n      - name:', runAt + 1));
  assert.match(runStep, /COGNITIVE_HASH_SECRET: \$\{\{ secrets\.COGNITIVE_HASH_SECRET \}\}/);
  assert.match(runStep, /--expected-sha256/, 'the importer re-checks the hash itself');
  assert.match(runStep, /LOOP_CRM_IMPORT_TARGET: production/);
  assert.match(runStep, /LOOP_PRISMA_LOG: none/, 'no Prisma client logging: an error line can carry query arguments');
  assert.match(runStep, /exec 2> "\$\{WORK\}\/stderr\.log"/, 'stderr is withheld from the log');
  assert.match(WORKFLOW, /echo "SOURCE_REF=s3:\$\{SOURCE_KEY\}" >> "\$GITHUB_ENV"/, 'provenance names the object; the SHA pins its content');
});

test('a malformed header never echoes a cell: an unknown column is reported by position', () => {
  const inv = sourceInventory('r1,Trevon,lund,Not due,pat@lund.example.test\n', new Date());
  assert.deepEqual(inv, { ok: false, problem: 'UNKNOWN_COLUMN', column: null, position: 1 });
});

test('the command\'s production target: reviewed approval but no APPLY, from main in Actions, for the pinned organization', () => {
  const env = { LOOP_CRM_IMPORT_TARGET: 'production', GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', CRM_IMPORT_ORGANIZATION_SLUG: 'emg-talent', COGNITIVE_HASH_SECRET: 'x' };
  assert.deepEqual(PRODUCTION_COMMANDS, ['validate', 'inventory', 'record-config', 'dry-run', 'approve']);
  assert.deepEqual(checkTarget(env, 'dry-run', 'emg-talent'), { ok: true });
  assert.deepEqual(checkTarget(env, 'approve', 'emg-talent'), { ok: true });
  for (const command of ['apply', 'abandon'] as const) {
    assert.deepEqual(checkTarget(env, command, 'emg-talent'), { ok: false, reason: 'PRODUCTION_APPLY_NOT_COMMISSIONED' }, command);
  }
  assert.deepEqual(checkTarget({ ...env, GITHUB_ACTIONS: '' }, 'dry-run', 'emg-talent'), { ok: false, reason: 'PRODUCTION_ONLY_FROM_GITHUB_ACTIONS' });
  assert.deepEqual(checkTarget({ ...env, GITHUB_REF: 'refs/heads/feat/x' }, 'dry-run', 'emg-talent'), { ok: false, reason: 'PRODUCTION_ONLY_FROM_MAIN' });
  assert.deepEqual(checkTarget({ ...env, CRM_IMPORT_ORGANIZATION_SLUG: '' }, 'dry-run', 'emg-talent'), { ok: false, reason: 'PRODUCTION_ORGANIZATION_NOT_CONFIGURED' });
  assert.deepEqual(checkTarget(env, 'dry-run', 'another-org'), { ok: false, reason: 'ORGANIZATION_NOT_THE_CONFIGURED_ONE' });
  assert.deepEqual(checkTarget({ ...env, COGNITIVE_HASH_SECRET: '' }, 'dry-run', 'emg-talent'), { ok: false, reason: 'HASH_KEY_NOT_CONFIGURED' });
});

test('the source is hashed over its bytes and refused before parsing on a mismatch; invalid UTF-8 is refused, never replaced', () => {
  const bytes = new TextEncoder().encode('source_row_key,creator_alias,route_key,source_status\nr1,A,b,c\n');
  const ok = readSourceBytes(bytes, null);
  assert.ok(ok.ok);
  assert.equal(readSourceBytes(bytes, ok.sha256).ok, true);
  assert.deepEqual(readSourceBytes(bytes, SHA), { ok: false, reason: 'SOURCE_SHA256_MISMATCH' });
  assert.deepEqual(readSourceBytes(new Uint8Array([0x61, 0xff, 0x62]), null), { ok: false, reason: 'SOURCE_NOT_UTF8' });
  assert.deepEqual(readSourceBytes(new Uint8Array(), null), { ok: false, reason: 'SOURCE_EMPTY' });
  // A BOM survives decoding, so the text re-encodes to exactly the hashed bytes.
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]);
  const withBom = readSourceBytes(bom, null);
  assert.ok(withBom.ok);
  assert.deepEqual(new Uint8Array(Buffer.from(withBom.text, 'utf8')), bom);
});

test('the inventory counts everything the contract cares about; the detail is separate from the counts', () => {
  const csv = [
    'source_row_key,creator_alias,route_key,source_status,route_name,contact_name,contact_name_verified,contact_kind,contact_title,email,phone,source_notes,source_last_contacted_at',
    'r1,Trevon Hill,lund,Not due,Lund,Pat Rivera,TRUE,INDIVIDUAL,VP,pat@lund.example.test,,note,2026-01-01',
    'r2,trevon  hill,lund,Historical,,Name not verified,TRUE,INDIVIDUAL,,x@lund.example.test,4155550100,,',
    'r2,Katrina,brother,Not due,,,,ROLE_INBOX,,team@brother.example.test,+14155550100,,2999-01-01',
    'r4,Katrina,brother,Not due,,,,,,,,,',
    'bad key,Katrina,brother,Not due,,,,,,,,,',
  ].join('\n');
  const inv = sourceInventory(csv, new Date('2026-10-07T00:00:00Z'));
  assert.ok(inv.ok);
  assert.deepEqual(inv.counts, {
    totalRows: 5,
    validRows: 4,
    invalidRows: 1,
    invalidByViolation: { SOURCE_ROW_KEY_INVALID: 1 },
    distinctSourceRowKeys: 3,
    duplicatedSourceRowKeys: 1,
    rowsWithDuplicatedKeys: 2,
    distinctCreatorAliases: 2,
    rowsWithoutCreatorAlias: 0,
    distinctRouteKeys: 2,
    distinctSourceStatuses: 2,
    personEligibleRows: 1,
    verifiedNamedRows: 2,
    unverifiedOrBlankNameRows: 2,
    contactKindIndividual: 2,
    contactKindRoleInbox: 1,
    contactKindMissing: 1,
    emails: 3,
    invalidEmails: 0,
    phones: 2,
    invalidPhones: 1,
    rowsWithNoContactValue: 1,
    futureLastContacted: 1,
    titlesPresent: 1,
    notesPresent: 1,
  });
  const counts = JSON.stringify(inv.counts);
  for (const s of ['@', '415', 'Pat', 'Trevon', 'Not due', 'Historical', '"VP"']) assert.ok(!counts.includes(s), `counts never carry "${s}"`);
  assert.deepEqual(inv.detail.sourceStatuses.map((s) => [s.status, s.rows]), [['Historical', 1], ['Not due', 3]]);
  assert.deepEqual(inv.detail.creatorAliases.map((a) => [a.key, a.rows]), [['katrina', 2], ['trevon hill', 2]]);
  assert.deepEqual(inv.detail.duplicatedSourceRowKeys, ['r2']);
  assert.ok(!JSON.stringify(inv.detail).includes('@'), 'even the private detail carries no contact value');
});
