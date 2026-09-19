// Tests for the scheduled Calendar cycle.
//
// WHAT THESE PROVE
//
// One sentence carries most of the weight: ONE EMPLOYEE'S BAD DAY IS NEVER EVERYBODY'S. An
// expired grant, a revoked connection, a rate limit or an exception ends that employee's pass
// and nothing else -- with one deliberate exception, the credential breaker, which exists
// because a wrong deployment key looks exactly like an expired grant repeated N times and would
// otherwise march through a whole organization marking connections expired.
//
// The second is that this runner names TENANTS and never people: no argument, flag or
// environment value selects a user, every pass goes through `{organizationId, userId}`, and no
// line it prints carries an identity or anything off a calendar.
//
// The third is the re-baseline the schedule owes #292: a sync token inherits the window that
// minted it, so a periodic pass must ask for a fresh window, and a failed one must leave the
// employee exactly where they were.
//
// WHAT THESE DELIBERATELY DO NOT PROVE
//
// What a sync does with a window or a token is proved against the real service in
// packages/database/test/calendar-sync.test.ts, including that a requested baseline ignores a
// live cursor and that a failure never replaces one. Who is eligible is proved against the real
// database in packages/database/test/work-state-postgres.test.ts. Restating either here against
// a stand-in would prove the stand-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkPrincipal } from '@emgloop/database';

import {
  CYCLE_BREAKER_THRESHOLD,
  CYCLE_SOURCES,
  CYCLE_SOURCE_CAPABILITY,
  CYCLE_SOURCE_WORK_SOURCE,
  parseSource,
  type CycleSyncOutcome,
  CYCLE_DEADLINE_MS,
  CYCLE_IN_FLIGHT_MS,
  REFUSED_ORGANIZATION_STATUSES,
  cycleSucceeded,
  employeeRef,
  parseArgs,
  parseOrganizations,
  readEnvironment,
  runCalendarCycle,
  type CalendarCycleDeps,
} from './cycle-employee-sources';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The workflow with its comment lines removed: a comment saying "do NOT add push:" is not a trigger. */
const workflow = (name: string) =>
  readFileSync(join(HERE, '..', '..', '.github', 'workflows', `${name}.yml`), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
const WORKFLOW = workflow('cycle-employee-calendars');
const GMAIL_WORKFLOW = workflow('cycle-employee-gmail');
/** The runner's code with its comments removed: a prose mention is not a capability. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SOURCE = code(readFileSync(join(HERE, 'cycle-employee-sources.ts'), 'utf8'));

const ORG = { id: 'org_1', slug: 'emg', status: 'ACTIVE' };

function outcome(over: Partial<CycleSyncOutcome> = {}): CycleSyncOutcome {
  return { outcome: 'SUCCEEDED', mode: 'INCREMENTAL', failure: null, cursorAdvanced: true, ...over };
}

/** A world with a movable clock, so a deadline and an in-flight lease are testable facts. */
function world(options: {
  members?: string[];
  sync?: (principal: WorkPrincipal, options: { baseline: boolean }) => Promise<CycleSyncOutcome>;
  lastRun?: (principal: WorkPrincipal) => Promise<{ startedAt: Date; finishedAt: Date | null } | null>;
  organization?: { id: string; slug: string; status: string } | null;
} = {}) {
  const lines: string[] = [];
  let clock = new Date('2026-09-18T12:00:00Z');
  const calls: { principal: WorkPrincipal; baseline: boolean }[] = [];
  const deps: CalendarCycleDeps = {
    organizations: { findBySlug: async () => (options.organization === undefined ? ORG : options.organization) },
    eligible: async () => (options.members ?? ['u1', 'u2', 'u3']).map((userId) => ({ userId })),
    lastRun: options.lastRun ?? (async () => null),
    sync: async (principal, o) => {
      calls.push({ principal, baseline: o.baseline });
      return options.sync ? options.sync(principal, o) : outcome();
    },
    log: (l) => lines.push(l),
    now: () => clock,
  };
  return {
    deps,
    lines,
    calls,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    field: (event: string, key: string) => {
      const found = lines.find((l) => l.startsWith(`event=${event} `) || l === `event=${event}`);
      return found ? (found.split(' ').find((p) => p.startsWith(`${key}=`)) ?? '').slice(key.length + 1) : null;
    },
  };
}

test('every employee is synchronized under their own principal, one at a time', async () => {
  const w = world();
  const result = await runCalendarCycle({ source: 'calendar', organizationSlugs: ['emg'], baseline: false }, w.deps);

  assert.equal(result.overall, 'COMPLETED');
  assert.equal(result.eligible, 3);
  assert.equal(result.attempted, 3);
  assert.equal(result.synced, 3);
  assert.deepEqual(
    w.calls.map((c) => c.principal),
    [
      { organizationId: 'org_1', userId: 'u1' },
      { organizationId: 'org_1', userId: 'u2' },
      { organizationId: 'org_1', userId: 'u3' },
    ],
    'the organization and the user always travel together',
  );
  assert.ok(cycleSucceeded(result.overall));
});

test('5. an employee who connects between two passes is attempted on the next pass -- the configuration names organizations, never people', async () => {
  const members = ['matt', 'charlie'];
  const w = world({ members });
  const request = { source: 'gmail' as const, organizationSlugs: ['emg'], baseline: false };
  await runCalendarCycle(request, w.deps);
  assert.deepEqual(w.calls.map((c) => c.principal.userId), ['matt', 'charlie']);

  // Employee #3 grants Gmail. Nothing else changes: not the request, not the configuration.
  members.push('employee3');
  w.calls.length = 0;
  const next = await runCalendarCycle(request, w.deps);
  assert.deepEqual(w.calls.map((c) => c.principal.userId), ['matt', 'charlie', 'employee3']);
  assert.equal(next.eligible, 3);
  assert.deepEqual(Object.keys(request).sort(), ['baseline', 'organizationSlugs', 'source'], 'no argument can name a person');
});

test('the same employee reached twice is attempted once', async () => {
  const w = world();
  const result = await runCalendarCycle({ source: 'calendar', organizationSlugs: ['emg', 'emg-again'], baseline: false }, w.deps);
  assert.equal(result.attempted, 3, 'two slugs resolving to one organization is still three people');
  assert.equal(w.calls.length, 3);
});

test('one employee failing does not end the cycle for anybody else', async () => {
  const w = world({
    sync: async (principal) =>
      principal.userId === 'u2'
        ? outcome({ outcome: 'FAILED', failure: 'RATE_LIMITED', cursorAdvanced: false })
        : outcome(),
  });
  const result = await runCalendarCycle({ source: 'calendar', organizationSlugs: ['emg'], baseline: false }, w.deps);

  assert.equal(result.attempted, 3);
  assert.equal(result.synced, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.overall, 'COMPLETED_WITH_FAILURES');
  assert.ok(cycleSucceeded(result.overall), 'somebody being rate-limited is not a broken cycle');
});

test('14. Gmail: the first person’s failed read does not stop the next person’s -- Matt failing never blocks Charlie', async () => {
  const w = world({
    sync: async (principal) =>
      principal.userId === 'u1' ? outcome({ outcome: 'FAILED', mode: 'WINDOW', failure: 'UNAVAILABLE', cursorAdvanced: false }) : outcome({ mode: 'WINDOW' }),
  });
  const result = await runCalendarCycle({ source: 'gmail', organizationSlugs: ['emg'], baseline: false }, w.deps);
  assert.deepEqual(w.calls.map((c) => c.principal.userId), ['u1', 'u2', 'u3'], 'everybody after the failure is still attempted');
  assert.equal(result.failed, 1);
  assert.equal(result.synced, 2);
  assert.equal(result.overall, 'COMPLETED_WITH_FAILURES');
});

test('the Gmail cycle is the one caller with FULL reach: it performs the first read that a page never does', () => {
  const runner = readFileSync(join(__dirname, 'cycle-employee-sources.ts'), 'utf8');
  assert.match(runner, /mailboxes\.syncGmail\(principal, \{ \.\.\.options, reach: 'FULL' \}\)/);
});

test('an employee whose pass throws is a failure of that pass only, and its message is dropped', async () => {
  const w = world({
    sync: async (principal) => {
      if (principal.userId === 'u1') throw new Error('Google said: "Weekly 1:1 with Charlie" could not be read');
      return outcome();
    },
  });
  const result = await runCalendarCycle({ source: 'calendar', organizationSlugs: ['emg'], baseline: false }, w.deps);

  assert.equal(result.failed, 1);
  assert.equal(result.synced, 2);
  for (const line of w.lines) assert.equal(line.includes('Charlie'), false, 'no provider text reaches a log');
});

test('three consecutive credential failures stop the cycle instead of expiring everybody', async () => {
  const w = world({
    members: ['u1', 'u2', 'u3', 'u4', 'u5'],
    sync: async () => outcome({ outcome: 'FAILED', failure: 'AUTHORIZATION_EXPIRED', cursorAdvanced: false }),
  });
  const result = await runCalendarCycle({ source: 'calendar', organizationSlugs: ['emg'], baseline: false }, w.deps);

  assert.equal(result.overall, 'ABORTED');
  assert.equal(w.calls.length, CYCLE_BREAKER_THRESHOLD, 'it stops attempting, it does not just report');
  assert.equal(result.notAttempted, 2);
  assert.equal(cycleSucceeded(result.overall), false, 'this one is red: it is this job\'s configuration, not their grants');
});

test('a lapsed grant among healthy ones does not trip the breaker', async () => {
  const w = world({
    members: ['u1', 'u2', 'u3', 'u4'],
    sync: async (principal) =>
      principal.userId === 'u1' || principal.userId === 'u3'
        ? outcome({ outcome: 'FAILED', failure: 'AUTHORIZATION_EXPIRED', cursorAdvanced: false })
        : outcome(),
  });
  const result = await runCalendarCycle({ source: 'calendar', organizationSlugs: ['emg'], baseline: false }, w.deps);
  assert.equal(result.overall, 'COMPLETED_WITH_FAILURES');
  assert.equal(w.calls.length, 4, 'every employee was still attempted');
});

test('an employee whose pass is already running is left alone, and one that finished is not', async () => {
  const startedAt = new Date('2026-09-18T11:58:00Z'); // two minutes before the cycle's clock
  const w = world({
    members: ['busy', 'free'],
    lastRun: async (principal) =>
      principal.userId === 'busy' ? { startedAt, finishedAt: null } : { startedAt, finishedAt: new Date('2026-09-18T11:58:30Z') },
  });
  const result = await runCalendarCycle({ source: 'calendar', organizationSlugs: ['emg'], baseline: false }, w.deps);

  assert.equal(result.skipped, 1);
  assert.equal(result.attempted, 1);
  assert.deepEqual(w.calls.map((c) => c.principal.userId), ['free']);
});

test('a run that never finished stops being a reason to skip, so a crash cannot freeze a calendar', async () => {
  const stale = new Date('2026-09-18T12:00:00Z').getTime() - CYCLE_IN_FLIGHT_MS - 1;
  const w = world({ members: ['stuck'], lastRun: async () => ({ startedAt: new Date(stale), finishedAt: null }) });
  const result = await runCalendarCycle({ source: 'calendar', organizationSlugs: ['emg'], baseline: false }, w.deps);
  assert.equal(result.attempted, 1);
  assert.equal(result.skipped, 0);
});

test('the cycle stops attempting at its deadline, in a stable order, so the next one gets further', async () => {
  const w = world({ members: ['a', 'b', 'c', 'd'] });
  const slow = { ...w.deps, sync: async (principal: WorkPrincipal, o: { baseline: boolean }) => {
    w.advance(CYCLE_DEADLINE_MS / 2);
    return w.deps.sync(principal, o);
  } };
  const result = await runCalendarCycle({ source: 'calendar', organizationSlugs: ['emg'], baseline: false }, slow);

  assert.equal(result.attempted, 2);
  assert.equal(result.notAttempted, 2);
  assert.ok(cycleSucceeded(result.overall), 'running out of time is not a failure to report red');
});

test('a baseline pass asks for a fresh window for everybody; the normal pass never does', async () => {
  const normal = world();
  await runCalendarCycle({ source: 'calendar', organizationSlugs: ['emg'], baseline: false }, normal.deps);
  assert.deepEqual(normal.calls.map((c) => c.baseline), [false, false, false]);

  const rebaseline = world({ sync: async () => outcome({ mode: 'REBASELINE' }) });
  const result = await runCalendarCycle({ source: 'calendar', organizationSlugs: ['emg'], baseline: true }, rebaseline.deps);
  assert.deepEqual(rebaseline.calls.map((c) => c.baseline), [true, true, true]);
  assert.equal(result.rebaselined, 3);
  assert.equal(rebaseline.field('CYCLE_START', 'mode'), 'BASELINE');
});

test('a failed baseline is reported and changes nothing else about the cycle', async () => {
  const w = world({
    members: ['u1', 'u2'],
    sync: async (principal) =>
      principal.userId === 'u1'
        ? outcome({ outcome: 'FAILED', mode: 'REBASELINE', failure: 'UNAVAILABLE', cursorAdvanced: false })
        : outcome({ mode: 'REBASELINE' }),
  });
  const result = await runCalendarCycle({ source: 'calendar', organizationSlugs: ['emg'], baseline: true }, w.deps);
  assert.equal(result.failed, 1);
  assert.equal(result.synced, 1);
  assert.ok(cycleSucceeded(result.overall));
});

test('an organization that cannot be operated against is refused, and its people are never read', async () => {
  for (const status of REFUSED_ORGANIZATION_STATUSES) {
    const w = world({ organization: { ...ORG, status } });
    const result = await runCalendarCycle({ source: 'calendar', organizationSlugs: ['emg'], baseline: false }, w.deps);
    assert.equal(result.overall, 'PRECONDITION_FAILED', status);
    assert.equal(w.calls.length, 0, status);
    assert.equal(cycleSucceeded(result.overall), false, status);
  }

  const missing = world({ organization: null });
  const result = await runCalendarCycle({ source: 'calendar', organizationSlugs: ['nope'], baseline: false }, missing.deps);
  assert.equal(result.overall, 'PRECONDITION_FAILED');
  assert.equal(missing.calls.length, 0);
});

test('with nothing configured it reads nothing at all', async () => {
  const w = world();
  const result = await runCalendarCycle({ source: 'calendar', organizationSlugs: [], baseline: false }, w.deps);
  assert.equal(result.overall, 'PRECONDITION_FAILED');
  assert.equal(w.calls.length, 0);
});

test('the summary counts what an operator needs, and names nobody', async () => {
  const w = world({
    members: ['u1', 'u2', 'u3'],
    sync: async (principal) => (principal.userId === 'u3' ? outcome({ outcome: 'TRUNCATED' }) : outcome()),
  });
  await runCalendarCycle({ source: 'calendar', organizationSlugs: ['emg'], baseline: false }, w.deps);

  const summary = w.lines.find((l) => l.startsWith('event=CYCLE_SUMMARY'));
  assert.ok(summary);
  for (const field of ['eligible=3', 'attempted=3', 'synced=2', 'truncated=1', 'failed=0', 'skipped=0', 'notAttempted=0']) {
    assert.ok(summary.includes(field), `${field} in ${summary}`);
  }
  // Every employee line carries a digest and never an id, and no line carries a count of
  // somebody's meetings: that is their business, and it is already on their own sync run.
  const employees = w.lines.filter((l) => l.startsWith('event=EMPLOYEE'));
  assert.equal(employees.length, 3);
  for (const l of employees) {
    assert.match(l, /ref=[0-9a-f]{12}\b/);
    for (const forbidden of ['u1', 'u2', 'u3', 'examined', 'written', 'summary', '@']) {
      assert.equal(l.includes(forbidden), false, `${forbidden} in ${l}`);
    }
  }
});

test('an employee reference is stable, and is not the identity it refers to', () => {
  const principal = { organizationId: 'org_1', userId: 'user_9' };
  const ref = employeeRef(principal);
  assert.equal(ref, employeeRef(principal));
  assert.match(ref, /^[0-9a-f]{12}$/);
  assert.equal(ref.includes('user_9'), false);
  // The same person in another tenant is a different reference.
  assert.notEqual(ref, employeeRef({ organizationId: 'org_2', userId: 'user_9' }));
});

test('it refuses to start without a database and a Google client, naming what is missing', () => {
  const ORIGIN = 'https://app.emgloop.com';
  const configured = {
    DATABASE_URL: 'postgres://direct/db',
    GOOGLE_OAUTH_CLIENT_ID: '1234567890-abcdefghijklmnop.apps.googleusercontent.com',
    GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-not-a-real-secret',
    LOOP_GOOGLE_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
  } as NodeJS.ProcessEnv;

  assert.deepEqual(readEnvironment(configured, ORIGIN), { ok: true });
  const noDb = readEnvironment({ ...configured, DATABASE_URL: undefined }, ORIGIN);
  assert.equal(noDb.ok, false);
  assert.deepEqual(noDb.ok === false ? noDb.missing : [], ['DATABASE_URL']);
  // A half-configured or wrong Google client is refused before a single employee is touched --
  // the same validation the web server applies, because a second, laxer one is how a wrong key
  // reaches the sealer.
  for (const broken of [
    { ...configured, LOOP_GOOGLE_TOKEN_KEY: Buffer.alloc(31, 7).toString('base64') },
    { ...configured, GOOGLE_OAUTH_CLIENT_ID: 'not-a-google-client' },
    { ...configured, GOOGLE_OAUTH_CLIENT_SECRET: undefined },
  ]) {
    assert.equal(readEnvironment(broken as NodeJS.ProcessEnv, ORIGIN).ok, false);
  }
  assert.equal(readEnvironment({ DATABASE_URL: 'postgres://direct/db' } as NodeJS.ProcessEnv, ORIGIN).ok, false);
});

test('nothing in this runner can name a person, a window or a date', () => {
  const { organizations, baseline, source } = parseArgs(['--organizations', ' emg , emg ', '--baseline', '--source', 'GMAIL']);
  assert.deepEqual(parseOrganizations(organizations), ['emg']);
  assert.equal(baseline, true);
  assert.equal(parseSource(source), 'gmail', 'the source is named, and is case-insensitive');
  assert.equal(parseArgs(['--organizations', 'emg']).baseline, false);
  // A pass with no source, or an unknown one, is refused rather than defaulted to a mailbox.
  for (const bad of ['', 'mail', 'drive', 'CALENDAR '])  assert.equal(parseSource(bad), null, bad);

  // Source-level, because "nobody would point the scheduler at one person" is a memory rather
  // than a property.
  for (const forbidden of ['--user', '--userId', '--email', '--since', '--until', '--date', '--timeMin', '--timeMax']) {
    assert.equal(SOURCE.includes(forbidden), false, forbidden);
  }
  // It reaches no Prisma model, builds no Google request and holds no token. It may hold the
  // client's lifecycle (`$disconnect`) and nothing else.
  assert.equal(/prisma\.[a-z]/.test(SOURCE), false, 'no Prisma model');
  // It names a SOURCE (`gmail`, `calendar`) and never reaches one: no request, no token, and
  // nothing off anybody's mailbox can pass through it.
  for (const forbidden of [
    '$queryRaw',
    '$executeRaw',
    'googleapis.com',
    'accessToken',
    'refreshToken',
    'Authorization',
    'subject',
    'snippet',
    'rawMessage',
    'messages.get',
  ]) {
    assert.equal(SOURCE.includes(forbidden), false, forbidden);
  }
  // And it is not reachable over HTTP: there is no route, no handler and no server here.
  for (const forbidden of ['NextRequest', 'export async function GET', 'export async function POST']) {
    assert.equal(SOURCE.includes(forbidden), false, forbidden);
  }
});

// --- The schedule ----------------------------------------------------------------------------
//
// The cadence is a product decision, so it is a checked fact rather than a line somebody can move
// while reviewing something else. Three parts, and only one of them is this workflow's:
//
//   an employee using Loop   DL-4's visit refresh -- not here, and not changed by this job
//   the background cycle     hourly
//   the rolling re-baseline  weekly, Sunday

test('the workflow runs hourly, re-baselines weekly, and serialises against itself', () => {
  const crons = [...WORKFLOW.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(crons, ['0 * * * *', '25 4 * * 0'], 'hourly on the hour, and a weekly Sunday baseline');

  // The weekly cron is what selects a baseline pass, so the two cannot drift apart.
  assert.ok(WORKFLOW.includes('[ "${SCHEDULE:-}" = "25 4 * * 0" ]'), 'the weekly cron chooses --baseline');
  assert.ok(WORKFLOW.includes('--baseline'));

  assert.ok(/concurrency:\s*\n\s*group: cycle-employee-calendars/.test(WORKFLOW));
  assert.ok(WORKFLOW.includes('cancel-in-progress: false'), 'a late run waits, it does not kill');

  // Under the cadence, so a hung pass can never still be running when the next one fires -- and
  // above the runner's own deadline, which is what actually stops it.
  const timeout = Number(WORKFLOW.match(/timeout-minutes:\s*(\d+)/)![1]);
  assert.ok(timeout < 60, `timeout ${timeout} must be under the hourly cadence`);
  assert.ok(timeout * 60_000 > CYCLE_DEADLINE_MS, 'the runner stops attempting before the job is killed');
});

test('the workflow is off until somebody switches it on, and nothing else can start it', () => {
  assert.ok(WORKFLOW.includes('vars.DAILY_LOOP_CALENDAR_ORGANIZATIONS'), 'a repository variable is the gate');
  for (const trigger of ['push:', 'pull_request:', 'repository_dispatch:']) {
    assert.equal(WORKFLOW.includes(trigger), false, trigger);
  }
  // It names tenants on the command line, and never a person.
  assert.ok(WORKFLOW.includes('--organizations "${ORGANIZATIONS}"'));
  for (const forbidden of ['--user', '--email', 'userId']) {
    assert.equal(WORKFLOW.includes(forbidden), false, forbidden);
  }
});

// --- One runner, one source per pass (GM-1) --------------------------------------------------

test('a source names its own capability and its own work source, and nothing defaults', () => {
  assert.deepEqual([...CYCLE_SOURCES], ['calendar', 'gmail']);
  assert.deepEqual({ ...CYCLE_SOURCE_CAPABILITY }, { calendar: 'calendar', gmail: 'gmail' });
  assert.deepEqual({ ...CYCLE_SOURCE_WORK_SOURCE }, { calendar: 'CALENDAR', gmail: 'GMAIL' });
});

test('a Gmail cycle is the same cycle: same isolation, same breaker, same summary', async () => {
  const w = world({ members: ['u1', 'u2'] });
  const result = await runCalendarCycle({ source: 'gmail', organizationSlugs: ['emg'], baseline: false }, w.deps);
  assert.equal(result.source, 'gmail');
  assert.equal(result.synced, 2);
  assert.deepEqual(w.calls.map((c) => c.principal.userId), ['u1', 'u2']);
  assert.equal(w.field('CYCLE_START', 'source'), 'gmail');
  assert.equal(w.field('CYCLE_SUMMARY', 'source'), 'gmail');

  // The per-employee lines still carry a digest and nothing off anybody's mailbox.
  for (const l of w.lines.filter((x) => x.startsWith('event=EMPLOYEE'))) {
    assert.match(l, /ref=[0-9a-f]{12}\b/);
    for (const forbidden of ['subject', 'snippet', '@', 'body', 'u1', 'u2']) {
      assert.equal(l.includes(forbidden), false, `${forbidden} in ${l}`);
    }
  }
});

test('a Gmail baseline asks for a fresh window for everybody, exactly as Calendar does', async () => {
  const w = world({ members: ['u1'], sync: async () => outcome({ mode: 'REBASELINE' }) });
  const result = await runCalendarCycle({ source: 'gmail', organizationSlugs: ['emg'], baseline: true }, w.deps);
  assert.deepEqual(w.calls.map((c) => c.baseline), [true]);
  assert.equal(result.rebaselined, 1);
});

test('the Gmail workflow runs hourly, baselines weekly, and is off until somebody switches it on', () => {
  const crons = [...GMAIL_WORKFLOW.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]);
  // Off the hour (:17): GitHub delays scheduled runs most at the start of each hour, and this pass
  // is what turns a newly connected mailbox from "setting up" into mail.
  assert.deepEqual(crons, ['17 * * * *', '55 4 * * 0'], 'hourly off the hour, and a weekly baseline');
  // Not the same minute as the Calendar baseline: two long passes should not queue behind each
  // other for no reason.
  const calendarCrons = [...WORKFLOW.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]);
  assert.notEqual(crons[1], calendarCrons[1]);
  assert.ok(GMAIL_WORKFLOW.includes('[ "${SCHEDULE:-}" = "55 4 * * 0" ]'), 'the weekly cron chooses --baseline');

  assert.ok(GMAIL_WORKFLOW.includes('vars.DAILY_LOOP_GMAIL_ORGANIZATIONS'), 'its own gate, separate from Calendar');
  assert.equal(GMAIL_WORKFLOW.includes('DAILY_LOOP_CALENDAR_ORGANIZATIONS'), false, 'enabling one does not enable the other');
  assert.ok(/concurrency:\s*\n\s*group: cycle-employee-gmail/.test(GMAIL_WORKFLOW), 'its own concurrency group');
  assert.ok(GMAIL_WORKFLOW.includes('npm run cycle:gmail'));
  for (const trigger of ['push:', 'pull_request:', 'repository_dispatch:']) {
    assert.equal(GMAIL_WORKFLOW.includes(trigger), false, trigger);
  }
  // The same four secrets as Calendar, and no mailbox-specific credential of its own.
  for (const secret of ['DIRECT_DATABASE_URL', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'LOOP_GOOGLE_TOKEN_KEY']) {
    assert.ok(GMAIL_WORKFLOW.includes(secret), secret);
  }
  const timeout = Number(GMAIL_WORKFLOW.match(/timeout-minutes:\s*(\d+)/)![1]);
  assert.ok(timeout < 60 && timeout * 60_000 > CYCLE_DEADLINE_MS);
});
