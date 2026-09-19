// Read employee sources: a read-only diagnosis that prints states and counts, never content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GoogleConnectionInventoryRow, WorkCursorRecord, WorkSyncRunRecord } from '@emgloop/database';
import { runEmployeeSources, parseArgs, readEnvironment, RECENT_RUNS } from './read-employee-sources';
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
  assert.match(text, /source=GMAIL eligible=false freshness=CAPABILITY_NOT_GRANTED/);
  assert.match(text, /source=GMAIL eligible=true freshness=CURRENT cursor=GMAIL_HISTORY_ID/);
  assert.match(text, /source=CALENDAR eligible=true freshness=NEVER_SYNCED cursor=-/);
  assert.match(text, /event=RUN ref=\w+ source=GMAIL startedAt=2026-09-19T12:50:00.000Z finishedAt=2026-09-19T12:51:00.000Z outcome=SUCCEEDED examined=4 written=4 failure=-/);
  assert.match(text, /event=ROWS ref=\w+ threads=120 messages=250 correspondents=80 items=9 events=14 documents=0/);
  assert.match(text, /event=SUMMARY connections=2 gmailEligible=1 calendarEligible=2 OVERALL_RESULT=READ/);
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
