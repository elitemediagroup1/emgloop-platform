// Read employee sources: a read-only diagnosis that prints states and counts, never content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GoogleConnectionInventoryRow, WorkCursorRecord, WorkSyncRunRecord } from '@emgloop/database';
import { runEmployeeSources, parseArgs, readEnvironment, RECENT_RUNS } from './read-employee-sources';
import { deriveSourceState } from '@emgloop/shared';
import { employeeRef } from './cycle-employee-sources';

const ORG = { id: 'org_live_1', slug: 'servicesinmycity-demo' };
const NOW = new Date('2026-09-19T13:00:00Z');
const G = 'https://www.googleapis.com/auth/';
const ALL = [`${G}gmail.readonly`, `${G}gmail.send`, `${G}calendar.events.readonly`, `${G}drive.metadata.readonly`];

function connection(userId: string, overrides: Partial<GoogleConnectionInventoryRow['connection']> = {}): GoogleConnectionInventoryRow['connection'] {
  return {
    id: `gc_${userId}`,
    organizationId: ORG.id,
    userId,
    googleSubject: `sub-${userId}`,
    emailAtLink: `${userId}@elitemediagroup.example`,
    hostedDomain: 'elitemediagroup.example',
    status: 'CONNECTED',
    grantedScopes: ALL,
    requestedScopes: ALL,
    connectedAt: new Date('2026-09-19T09:10:00Z'),
    lastUsedAt: null,
    expiredAt: null,
    lastFailureClass: null,
    revokedAt: null,
    revocationReason: null,
    revocationConfirmedAt: null,
    ...overrides,
  };
}

function world(opts: { rows?: GoogleConnectionInventoryRow[]; cursors?: Record<string, WorkCursorRecord>; runs?: Record<string, WorkSyncRunRecord[]> } = {}) {
  const rows = opts.rows ?? [
    { userId: 'user_matt', nameInitial: 'M', membershipStatus: 'ACTIVE', systemRole: 'OWNER', connection: connection('user_matt'), hasCredential: true },
    {
      userId: 'user_charlie',
      nameInitial: 'C',
      membershipStatus: 'ACTIVE',
      systemRole: 'ADMIN',
      connection: connection('user_charlie', { grantedScopes: ALL.filter((s) => !s.endsWith('gmail.send')) }),
      hasCredential: true,
    },
  ];
  const out: string[] = [];
  const calls: string[] = [];
  const deps = {
    organizations: { findBySlug: async (slug: string) => (slug === ORG.slug ? ORG : null) },
    connections: {
      inventory: async (organizationId: string) => (calls.push(`inventory:${organizationId}`), organizationId === ORG.id ? rows : []),
      connectedMembers: async (organizationId: string, capability: string) =>
        rows
          .filter((r) => organizationId === ORG.id && r.connection.status === 'CONNECTED')
          .filter((r) => (capability === 'gmail' ? r.connection.grantedScopes.includes(`${G}gmail.send`) : true))
          .map((r) => ({ userId: r.userId })),
    },
    sources: {
      cursor: async (p: { organizationId: string; userId: string }, source: string) => opts.cursors?.[`${p.userId}:${source}`] ?? null,
      recentRuns: async (p: { organizationId: string; userId: string }, limit = 20, source?: string) =>
        (opts.runs?.[`${p.userId}:${source}`] ?? []).slice(0, limit),
    },
    footprint: {
      counts: async (p: { organizationId: string; userId: string }) =>
        p.userId === 'user_matt'
          ? { threads: 120, messages: 250, correspondents: 80, items: 9, events: 14, documents: 0 }
          : { threads: 0, messages: 0, correspondents: 0, items: 0, events: 6, documents: 0 },
    },
    now: () => NOW,
    log: (l: string) => void out.push(l),
  };
  return { deps, out, calls };
}

test('parseArgs and the environment check', () => {
  assert.deepEqual(parseArgs(['--organization', 'servicesinmycity-demo']), { organization: 'servicesinmycity-demo' });
  assert.deepEqual(readEnvironment({}), { ok: false, missing: ['DATABASE_URL'] });
});

test('a malformed or unknown organization is refused before anything is read', async () => {
  const { deps, out, calls } = world();
  assert.equal((await runEmployeeSources({ organizationSlug: 'Bad Slug' }, deps)).overall, 'FAILED_PRECONDITION');
  assert.equal((await runEmployeeSources({ organizationSlug: 'nobody' }, deps)).overall, 'FAILED_PRECONDITION');
  assert.deepEqual(calls, []);
  assert.ok(out.every((l) => l.startsWith('event=PRECONDITION_FAILED')));
});

test('each connection is reported by the cycle ref, with scopes, eligibility, freshness, runs and counts', async () => {
  const matt = { organizationId: ORG.id, userId: 'user_matt' };
  const { deps, out } = world({
    cursors: {
      'user_matt:GMAIL': { source: 'GMAIL', cursor: 'h-1', cursorKind: 'GMAIL_HISTORY_ID', lastSyncStartedAt: new Date('2026-09-19T12:50:00Z'), lastSyncCompletedAt: new Date('2026-09-19T12:51:00Z'), lastFailureClass: null, backoffUntil: null },
    },
    runs: {
      'user_matt:GMAIL': [
        { id: 'r1', source: 'GMAIL', startedAt: new Date('2026-09-19T12:50:00Z'), finishedAt: new Date('2026-09-19T12:51:00Z'), outcome: 'SUCCEEDED', examined: 4, written: 4, failureClass: null },
      ],
    },
  });
  const result = await runEmployeeSources({ organizationSlug: ORG.slug }, deps);
  assert.equal(result.overall, 'READ');
  assert.equal(result.connections, 2);
  const text = out.join('\n');

  // The same digest the cycle logs, so a line here follows into a cycle run.
  assert.match(text, new RegExp(`event=EMPLOYEE ref=${employeeRef(matt)} initial=M role=OWNER membership=ACTIVE connection=CONNECTED`));
  // Charlie did not grant send: Gmail is not a usable capability, and the cycle would skip him.
  assert.match(text, /event=SCOPES ref=\w+ gmail.readonly=true gmail.send=false calendar.events.readonly=true drive.metadata.readonly=true legacy.gmail.metadata=false/);
  assert.match(text, /event=CAPABILITIES ref=\w+ gmail=INSUFFICIENT_SCOPE calendar=CONNECTED drive=CONNECTED/);
  assert.match(text, /source=GMAIL eligible=false readiness=PERMISSION_NEEDED freshness=CAPABILITY_NOT_GRANTED position=false/);
  assert.match(text, /source=GMAIL eligible=true readiness=READY freshness=CURRENT position=true cursor=GMAIL_HISTORY_ID/);
  assert.match(text, /source=CALENDAR eligible=true readiness=INITIALIZING freshness=NEVER_SYNCED position=false cursor=-/);
  assert.match(text, /event=RUN ref=\w+ source=GMAIL startedAt=2026-09-19T12:50:00.000Z finishedAt=2026-09-19T12:51:00.000Z outcome=SUCCEEDED examined=4 written=4 failure=-/);
  assert.match(text, /event=ROWS ref=\w+ threads=120 messages=250 correspondents=80 items=9 events=14 documents=0/);
  assert.match(text, /event=SUMMARY connections=2 gmailEligible=1 calendarEligible=2 OVERALL_RESULT=READ/);
});

// --- 2026-09-19: Matt's production facts ----------------------------------------------------------
//
// Production run 35449047490 (14:32 UTC) reported Matt as: all four capability scopes granted, plus
// the legacy gmail.metadata left over from before GM-1; Gmail eligible; no stored position; last
// completed read 01:50:55 UTC; three TRUNCATED runs of 250; 270 threads, 341 messages. His own
// Connections page, seen about twelve hours after that read, said "Gmail · Ready · Last read 12h
// ago". Those are the same facts read through the same derivation -- these tests pin that.

const MATT_ROW = (): GoogleConnectionInventoryRow => ({
  userId: 'user_matt',
  nameInitial: 'M',
  membershipStatus: 'ACTIVE',
  systemRole: 'OWNER',
  connection: connection('user_matt', {
    grantedScopes: [...ALL, `${G}gmail.metadata`],
    requestedScopes: [...ALL, `${G}gmail.metadata`],
    connectedAt: new Date('2026-09-18T17:32:32Z'),
  }),
  hasCredential: true,
});
const MATT_LAST_READ = new Date('2026-09-19T01:50:55Z');
const MATT_CURSOR: WorkCursorRecord = { source: 'GMAIL', cursor: null, cursorKind: null, lastSyncStartedAt: new Date('2026-09-19T01:50:27Z'), lastSyncCompletedAt: MATT_LAST_READ, lastFailureClass: null, backoffUntil: null };
const MATT_RUNS: WorkSyncRunRecord[] = [
  { id: 'r3', source: 'GMAIL', startedAt: new Date('2026-09-19T01:50:27Z'), finishedAt: MATT_LAST_READ, outcome: 'TRUNCATED', examined: 250, written: 250, failureClass: null },
];

test('1. Matt’s production facts read as Gmail READY and eligible -- the same answer his Connections page gave', async () => {
  const { deps, out } = world({ rows: [MATT_ROW()], cursors: { 'user_matt:GMAIL': MATT_CURSOR }, runs: { 'user_matt:GMAIL': MATT_RUNS } });
  await runEmployeeSources({ organizationSlug: ORG.slug }, deps);
  const text = out.join('\n');
  assert.match(text, /gmail\.readonly=true gmail\.send=true calendar\.events\.readonly=true drive\.metadata\.readonly=true legacy\.gmail\.metadata=true/);
  assert.match(text, /CAPABILITIES ref=\w+ gmail=CONNECTED/, 'a leftover legacy scope does not hide the current ones');
  assert.match(text, /source=GMAIL eligible=true readiness=READY freshness=STALE position=false cursor=- /);
  assert.match(text, /lastCompleted=2026-09-19T01:50:55\.000Z/);
  // The number his page showed is the age of that same read at the time he looked.
  const seen = new Date(MATT_LAST_READ.getTime() + 12 * 3_600_000);
  const onScreen = deriveSourceState('GMAIL', { configured: true, capability: 'CONNECTED', cursor: MATT_CURSOR, lastRun: MATT_RUNS[0]! }, seen);
  assert.equal(onScreen.readiness, 'READY');
  assert.equal(onScreen.lastReadAt?.toISOString(), '2026-09-19T01:50:55.000Z');
});

test('3. history never makes Gmail ready: with only the legacy scope, the same stored rows read PERMISSION_NEEDED and ineligible', async () => {
  const legacyOnly = MATT_ROW();
  const row = { ...legacyOnly, connection: { ...legacyOnly.connection, grantedScopes: [`${G}gmail.metadata`, `${G}calendar.events.readonly`] } };
  const { deps, out } = world({ rows: [row], cursors: { 'user_matt:GMAIL': MATT_CURSOR }, runs: { 'user_matt:GMAIL': MATT_RUNS } });
  await runEmployeeSources({ organizationSlug: ORG.slug }, deps);
  const text = out.join('\n');
  assert.match(text, /source=GMAIL eligible=false readiness=PERMISSION_NEEDED freshness=CAPABILITY_NOT_GRANTED/);
  assert.equal(/source=GMAIL[^\n]*readiness=READY/.test(text), false);
});

test('4. the runner reports state through the one shared derivation, never its own composition', () => {
  const code = readFileSync(join(__dirname, 'read-employee-sources.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.match(code, /deriveSourceState\(source, \{ configured: true, capability: states\[capability\], cursor, lastRun: runs\[0\] \?\? null \}, now\)/);
  for (const own of ['workSourceFreshness(', 'sourceReadiness(', 'syncRunInFlight(']) assert.equal(code.includes(own), false, `${own} is composed once, in @emgloop/shared`);
});

test('nothing identifying or private is printed: no id, email, Google account, domain or scope URL', async () => {
  const { deps, out } = world();
  await runEmployeeSources({ organizationSlug: ORG.slug }, deps);
  const text = out.join('\n');
  for (const secret of ['user_matt', 'user_charlie', ORG.id, 'sub-user', '@', 'elitemediagroup.example', 'googleapis.com', 'gc_user']) {
    assert.equal(text.includes(secret), false, `${secret} must not be printed`);
  }
});

test('the runner only reads: it names no write, sync or Google call', () => {
  const code = readFileSync(join(__dirname, 'read-employee-sources.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  for (const forbidden of ['startRun(', 'finishRun(', 'advanceCursor(', 'storeGrant(', 'revoke(', 'markExpired(', 'recordUse(', 'upsert', '.create(', '.update(', '.delete', 'syncGmail', 'syncCalendar', 'accessToken', 'fetch(', 'emailAtLink']) {
    assert.equal(code.includes(forbidden), false, `${forbidden} has no place in a read-only diagnosis`);
  }
  assert.ok(RECENT_RUNS <= 5, 'a handful of runs, not a history dump');
});

// --- The workflow's input step, executed ------------------------------------------------------
//
// Run 35447918049 was refused before reading anything: the organization slug arrived with four
// leading spaces, and the step validated the raw value. These tests run the workflow's OWN step
// (extracted from the YAML, not a copy of it) under bash, so the file and the test cannot drift.

const WORKFLOW = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'read-employee-sources.yml'), 'utf8');

/** The `run: |` body of the named step, dedented. */
function stepScript(name: string): string {
  const lines = WORKFLOW.split('\n');
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

function validate(value: string): { code: number; slug: string | null; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'res-input-'));
  const output = join(dir, 'output');
  writeFileSync(output, '');
  // The same shell GitHub uses for `shell: bash`.
  const run = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', stepScript('Validate the requested input')], {
    env: { PATH: process.env.PATH ?? '', ORG_SLUG: value, GITHUB_OUTPUT: output },
    encoding: 'utf8',
  });
  const written = readFileSync(output, 'utf8');
  rmSync(dir, { recursive: true, force: true });
  const slug = /^slug=(.*)$/m.exec(written)?.[1] ?? null;
  return { code: run.status ?? -1, slug, stdout: run.stdout };
}

test('a valid slug with whitespace around it is trimmed, validated and passed on -- the run 35447918049 input', () => {
  for (const input of ['servicesinmycity-demo', '    servicesinmycity-demo', 'servicesinmycity-demo   ', '\tservicesinmycity-demo\n', ' \t servicesinmycity-demo \r\n']) {
    const result = validate(input);
    assert.equal(result.code, 0, JSON.stringify(input));
    assert.equal(result.slug, 'servicesinmycity-demo', `${JSON.stringify(input)} passes on the trimmed slug`);
    assert.match(result.stdout, /Validated organization servicesinmycity-demo\./);
  }
});

test('whitespace is only trimmed, never repaired: anything that is not one valid slug is still refused', () => {
  for (const input of ['', '   ', 'services inmycity-demo', 'servicesinmycity-demo\nother-org', 'Servicesinmycity-Demo', '-leading-hyphen', 'org;rm', 'a'.repeat(64)]) {
    const result = validate(input);
    assert.notEqual(result.code, 0, `${JSON.stringify(input)} must be refused`);
    assert.equal(result.slug, null, 'nothing is passed on');
  }
});

test('the read step uses the validated slug, never the raw input', () => {
  const read = WORKFLOW.slice(WORKFLOW.indexOf('- name: Read\n'), WORKFLOW.indexOf('- name: How to read the output'));
  assert.match(read, /ORG_SLUG: \$\{\{ steps\.input\.outputs\.slug \}\}/);
  assert.equal(read.includes('inputs.organization_slug'), false);
  assert.deepEqual(parseArgs(['--organization', '  servicesinmycity-demo  ']), { organization: 'servicesinmycity-demo' }, 'the runner trims too');
});
