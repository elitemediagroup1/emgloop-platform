// The automated Calendar cycle -- one scheduled pass over the employees who connected Calendar.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §8.2 and §26 (DL-5).
//
// WHAT IT IS
//
// For each configured organization: ask which of its members hold a usable Calendar connection,
// and synchronize each of them, one at a time, under their own principal. That is the whole job.
// It is the thinnest possible front end over `CalendarSyncService.syncCalendar`, which DL-3
// already shipped and which the web server already calls for a person who is looking.
//
// WHY IT EXISTS: Your Day should be current for an employee who has not opened Loop, and for one
// who has not pressed anything. The manual control stays as a recovery path; normal use no longer
// depends on it.
//
// WHOSE CALENDAR -- AND WHY A SCHEDULED JOB CANNOT WIDEN THAT
//
// Every pass names one `{organizationId, userId}` principal, and that principal is the whole
// authorization: `GoogleWorkspaceService.accessToken` re-derives that employee's OWN membership
// and IAM decision before a token exists, and the DL-1 repositories require both ids to read or
// write a row. This runner therefore cannot read a calendar that its owner could not read, and
// there is no argument, flag or environment value that names a user. `--organizations` selects
// TENANTS, never people.
//
// AND IT IS NOT AN ADMIN PATH. Nothing here is reachable over HTTP, nothing returns calendar
// contents to a caller, and no output names an employee: a pass prints a digest, its outcome and
// its class. No title, no attendee, no address, no token -- not even a count of somebody's
// meetings, which is their business and is already recorded privately on their own sync run.
//
// TWO CADENCES, ONE PASS
//
//   INCREMENTAL  the normal pass. Each employee's stored sync token, so Google returns only what
//                changed. Cheap, and the usual case is an empty answer.
//   BASELINE     the periodic correction. A Google sync token inherits the window that minted it,
//                so a cursor kept alive for months keeps reporting against a horizon months in
//                the past and never learns about a meeting booked beyond it (§8.2; the follow-up
//                recorded in #292). A baseline pass re-reads the rolling window and replaces the
//                token with one whose horizon starts today.
//
// A FAILED BASELINE CHANGES NOTHING. The cursor is only ever replaced by a read that succeeded,
// so an employee whose baseline fails stays on the incremental path they were already on and the
// next baseline retries.
//
// USAGE
//
//   npm run cycle:calendars -- --organizations <slug>[,<slug>] [--baseline]
//
// Credentials come from the environment and are never printed:
//   DATABASE_URL                 the DIRECT (non-pooled) production endpoint
//   GOOGLE_OAUTH_CLIENT_ID       ) the same client and key the web application holds; a DIFFERENT
//   GOOGLE_OAUTH_CLIENT_SECRET   ) key cannot open a sealed refresh token, and the pass that
//   LOOP_GOOGLE_TOKEN_KEY        ) discovers that marks a connection expired -- see the breaker.
//   APP_URL                      the canonical origin, to validate the client's redirect URI

import { createHash } from 'node:crypto';

import { readGoogleEnvironment, appOrigin, type CalendarReadFailure } from '@emgloop/shared';
import type { CalendarSyncOutcome, WorkPrincipal } from '@emgloop/database';

// --- The seams this file is tested through -------------------------------------------------
//
// Four capabilities: look an organization up, list who is eligible inside it, see whether a pass
// is already running for someone, and synchronize one employee. It cannot reach a Prisma model,
// a Google client, a token or an event.

export interface OrganizationLookup {
  findBySlug(slug: string): Promise<{ id: string; slug: string; status: string } | null>;
}

export interface CalendarCycleDeps {
  organizations: OrganizationLookup;
  /** The members of ONE organization whose own Calendar connection is worth attempting. */
  eligible(organizationId: string): Promise<readonly { readonly userId: string }[]>;
  /** This employee's most recent pass, so a cycle does not pile onto one already running. */
  lastRun(principal: WorkPrincipal): Promise<{ readonly startedAt: Date; readonly finishedAt: Date | null } | null>;
  sync(principal: WorkPrincipal, options: { readonly baseline: boolean }): Promise<CalendarSyncOutcome>;
  /** Injected so tests read every line, and so nothing writes to stdout directly. */
  log: (line: string) => void;
  /** Injected so the caller owns the clock -- including the tests that move it. */
  now: () => Date;
}

export interface CalendarCycleRequest {
  readonly organizationSlugs: readonly string[];
  /** True on the periodic correction pass. The normal pass leaves it false. */
  readonly baseline: boolean;
}

/** What one employee's pass did. Four of these are not failures of this job. */
export const EMPLOYEE_RESULTS = ['SYNCED', 'TRUNCATED', 'SKIPPED_IN_FLIGHT', 'NOT_ATTEMPTED', 'FAILED'] as const;
export type EmployeeResult = (typeof EMPLOYEE_RESULTS)[number];

/**
 * Failures that mean "this deployment cannot open this credential", rather than "this employee
 * needs to reconnect". They look identical one at a time, which is the danger: a wrong
 * LOOP_GOOGLE_TOKEN_KEY produces one for EVERY employee, and each one marks a connection expired
 * on the way past. See `CYCLE_BREAKER_THRESHOLD`.
 */
export const CREDENTIAL_FAILURES: readonly CalendarReadFailure[] = ['AUTHORIZATION_EXPIRED', 'AUTH'];

/**
 * How many consecutive credential failures end the cycle.
 *
 * ONE IS A PERSON WHOSE GRANT LAPSED; THREE IN A ROW IS THIS JOB'S OWN CONFIGURATION. Marching
 * on would mark every remaining employee's connection expired and make the whole organization
 * reconnect, so the cycle stops and goes red instead. The cost of the rule is that three people
 * whose grants really did lapse together delay the rest of one pass.
 */
export const CYCLE_BREAKER_THRESHOLD = 3;

/** A pass started but unfinished within this long is still running: leave it alone. */
export const CYCLE_IN_FLIGHT_MS = 5 * 60_000;

/** A cycle stops attempting after this long, so it can never still be running when the next fires. */
export const CYCLE_DEADLINE_MS = 10 * 60_000;

/** Organization statuses this tool refuses to operate against. */
export const REFUSED_ORGANIZATION_STATUSES = ['SUSPENDED', 'CANCELED'] as const;

export interface EmployeePass {
  readonly organizationSlug: string;
  /** A stable digest, so one employee's passes can be followed without naming them. */
  readonly ref: string;
  readonly result: EmployeeResult;
  readonly mode: CalendarSyncOutcome['mode'] | null;
  readonly failure: CalendarReadFailure | null;
}

export type CycleOverall = 'COMPLETED' | 'COMPLETED_WITH_FAILURES' | 'ABORTED' | 'PRECONDITION_FAILED';

export interface CalendarCycleResult {
  readonly overall: CycleOverall;
  readonly eligible: number;
  readonly attempted: number;
  readonly synced: number;
  readonly truncated: number;
  readonly failed: number;
  readonly skipped: number;
  readonly notAttempted: number;
  readonly rebaselined: number;
  readonly passes: readonly EmployeePass[];
  readonly elapsedMs: number;
}

/** A cycle that could not run at all, or that stopped itself, is the only red run. */
export function cycleSucceeded(overall: CycleOverall): boolean {
  return overall === 'COMPLETED' || overall === 'COMPLETED_WITH_FAILURES';
}

// --- Input --------------------------------------------------------------------------------

export function parseOrganizations(raw: string): string[] {
  const seen = new Set<string>();
  for (const segment of raw.split(',')) {
    const slug = segment.trim();
    if (slug !== '') seen.add(slug);
  }
  return [...seen];
}

/** Minimal flag parsing. Deliberately not a CLI framework, and deliberately naming no person. */
export function parseArgs(argv: readonly string[]): { organizations: string; baseline: boolean } {
  let organizations = '';
  let baseline = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--organizations' || flag === '--organization' || flag === '--org') {
      organizations = (argv[i + 1] ?? '').trim();
      i += 1;
    } else if (flag === '--baseline') {
      baseline = true;
    }
  }
  return { organizations, baseline };
}

/** Names of the environment values this run needs. Values are never returned or printed. */
export function readEnvironment(env: NodeJS.ProcessEnv, origin: string): { ok: true } | { ok: false; reason: string; missing: string[] } {
  const databaseUrl = env.DATABASE_URL?.trim() || '';
  const google = readGoogleEnvironment(env, origin);
  if (!databaseUrl && google.state === 'NOT_CONFIGURED') return { ok: false, reason: 'missing environment', missing: ['DATABASE_URL', 'GOOGLE'] };
  if (!databaseUrl) return { ok: false, reason: 'missing environment', missing: ['DATABASE_URL'] };
  // NOT_CONFIGURED and INVALID are both refusals here. A cycle with no Google client would walk
  // every employee and record a NOT_CONFIGURED failure against each of them, which is noise
  // wearing the shape of a calendar problem.
  if (google.state !== 'CONFIGURED') return { ok: false, reason: `google configuration is ${google.state}`, missing: [] };
  return { ok: true };
}

// --- Reporting ----------------------------------------------------------------------------

function line(fields: Record<string, string | number | boolean | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '' : String(v)}`)
    .join(' ');
}

/**
 * A stable reference to one employee that is not their identity.
 *
 * An operator needs to tell two failing passes apart and follow one across runs. They do not need
 * a name, an address or a user id in a log that lives in a CI provider, so they get a digest --
 * derived from the organization as well, so the same person in two tenants is two references.
 */
export function employeeRef(principal: WorkPrincipal): string {
  return createHash('sha256').update(`${principal.organizationId}:${principal.userId}`).digest('hex').slice(0, 12);
}

// --- The cycle ----------------------------------------------------------------------------

/**
 * One pass over every configured organization, and every eligible employee inside it.
 *
 * SEQUENTIAL BY CONSTRUCTION. There is no `Promise.all` here and there must never be one: each
 * pass is a Google request followed by writes, and a burst of them across a tenant would raise
 * the rate-limit risk for the exact people this job exists to serve.
 *
 * FAILURE IS PER EMPLOYEE. An expired grant, a revoked connection, a rate limit or an exception
 * ends that employee's pass and nothing else -- the next employee is attempted immediately. The
 * ONE exception is the credential breaker above, which is not one employee's problem.
 */
export async function runCalendarCycle(request: CalendarCycleRequest, deps: CalendarCycleDeps): Promise<CalendarCycleResult> {
  const startedAt = deps.now().getTime();
  const passes: EmployeePass[] = [];
  let overall: CycleOverall = 'COMPLETED';
  let consecutiveCredentialFailures = 0;
  let aborted = false;
  let eligibleCount = 0;

  deps.log(
    line({
      event: 'CYCLE_START',
      mode: request.baseline ? 'BASELINE' : 'INCREMENTAL',
      organizations: request.organizationSlugs.join(','),
      count: request.organizationSlugs.length,
      deadlineMs: CYCLE_DEADLINE_MS,
      inFlightMs: CYCLE_IN_FLIGHT_MS,
      breakerThreshold: CYCLE_BREAKER_THRESHOLD,
    }),
  );

  if (request.organizationSlugs.length === 0) {
    deps.log(line({ event: 'PRECONDITION_FAILED', reason: 'no organizations are configured for the calendar cycle' }));
    return summarize('PRECONDITION_FAILED', passes, 0, startedAt, deps);
  }

  // One entry per principal, so the same employee named twice -- two slugs resolving to one
  // organization, a duplicated list -- is attempted once.
  const seen = new Set<string>();

  for (const slug of request.organizationSlugs) {
    if (aborted) break;
    const organization = await deps.organizations.findBySlug(slug);
    if (!organization) {
      deps.log(line({ event: 'ORGANIZATION_REFUSED', organization: slug, reason: 'no organization with that slug' }));
      overall = 'PRECONDITION_FAILED';
      continue;
    }
    if ((REFUSED_ORGANIZATION_STATUSES as readonly string[]).includes(organization.status)) {
      deps.log(line({ event: 'ORGANIZATION_REFUSED', organization: organization.slug, reason: `organization is ${organization.status}` }));
      overall = 'PRECONDITION_FAILED';
      continue;
    }

    const members = await deps.eligible(organization.id);
    deps.log(line({ event: 'ORGANIZATION', organization: organization.slug, eligible: members.length }));

    for (const member of members) {
      const principal: WorkPrincipal = { organizationId: organization.id, userId: member.userId };
      const key = `${principal.organizationId}:${principal.userId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      eligibleCount += 1;

      const ref = employeeRef(principal);
      if (aborted || deps.now().getTime() - startedAt >= CYCLE_DEADLINE_MS) {
        // Out of time. The stable order means the next cycle starts where this one did and gets
        // at least as far; nothing is lost by not attempting.
        passes.push({ organizationSlug: organization.slug, ref, result: 'NOT_ATTEMPTED', mode: null, failure: null });
        continue;
      }

      const pass = await onePass(organization.slug, principal, ref, request.baseline, deps);
      passes.push(pass);

      if (pass.result === 'FAILED' && pass.failure !== null && CREDENTIAL_FAILURES.includes(pass.failure)) {
        consecutiveCredentialFailures += 1;
        if (consecutiveCredentialFailures >= CYCLE_BREAKER_THRESHOLD) {
          deps.log(
            line({
              event: 'CYCLE_ABORTED',
              reason: 'consecutive credential failures -- suspecting this cycle\'s own configuration, not this many lapsed grants',
              consecutive: consecutiveCredentialFailures,
            }),
          );
          aborted = true;
        }
      } else if (pass.result !== 'SKIPPED_IN_FLIGHT' && pass.result !== 'NOT_ATTEMPTED') {
        consecutiveCredentialFailures = 0;
      }
    }
  }

  if (aborted) overall = 'ABORTED';
  else if (overall !== 'PRECONDITION_FAILED' && passes.some((p) => p.result === 'FAILED')) overall = 'COMPLETED_WITH_FAILURES';
  return summarize(overall, passes, eligibleCount, startedAt, deps);
}

async function onePass(
  organizationSlug: string,
  principal: WorkPrincipal,
  ref: string,
  baseline: boolean,
  deps: CalendarCycleDeps,
): Promise<EmployeePass> {
  const last = await deps.lastRun(principal);
  if (last && last.finishedAt === null && deps.now().getTime() - last.startedAt.getTime() < CYCLE_IN_FLIGHT_MS) {
    // Somebody's own refresh, or a previous cycle, is reading this calendar right now. Two passes
    // cannot corrupt a row -- every write is an upsert on the provider key -- but the later one
    // would store the older sync token, so the next pass would re-read what it already had.
    deps.log(line({ event: 'EMPLOYEE', organization: organizationSlug, ref, result: 'SKIPPED_IN_FLIGHT', mode: '', failure: '' }));
    return { organizationSlug, ref, result: 'SKIPPED_IN_FLIGHT', mode: null, failure: null };
  }

  const startedAt = deps.now().getTime();
  let outcome: CalendarSyncOutcome;
  try {
    outcome = await deps.sync(principal, { baseline });
  } catch {
    // One employee's pass threw. The class is deliberately absent rather than guessed, and the
    // message is deliberately dropped: it is the one place a provider's text could reach a log.
    deps.log(line({ event: 'EMPLOYEE', organization: organizationSlug, ref, result: 'FAILED', mode: '', failure: 'THREW' }));
    return { organizationSlug, ref, result: 'FAILED', mode: null, failure: null };
  }

  const result: EmployeeResult = outcome.outcome === 'SUCCEEDED' ? 'SYNCED' : outcome.outcome === 'TRUNCATED' ? 'TRUNCATED' : 'FAILED';
  deps.log(
    line({
      event: 'EMPLOYEE',
      organization: organizationSlug,
      ref,
      result,
      mode: outcome.mode,
      failure: outcome.failure ?? '',
      cursorAdvanced: outcome.cursorAdvanced,
      elapsedMs: deps.now().getTime() - startedAt,
    }),
  );
  return { organizationSlug, ref, result, mode: outcome.mode, failure: outcome.failure };
}

function summarize(
  overall: CycleOverall,
  passes: readonly EmployeePass[],
  eligible: number,
  startedAt: number,
  deps: CalendarCycleDeps,
): CalendarCycleResult {
  const count = (result: EmployeeResult) => passes.filter((p) => p.result === result).length;
  const result: CalendarCycleResult = {
    overall,
    eligible,
    attempted: passes.filter((p) => p.result !== 'SKIPPED_IN_FLIGHT' && p.result !== 'NOT_ATTEMPTED').length,
    synced: count('SYNCED'),
    truncated: count('TRUNCATED'),
    failed: count('FAILED'),
    skipped: count('SKIPPED_IN_FLIGHT'),
    notAttempted: count('NOT_ATTEMPTED'),
    rebaselined: passes.filter((p) => p.mode === 'REBASELINE').length,
    passes,
    elapsedMs: deps.now().getTime() - startedAt,
  };
  deps.log(
    line({
      event: 'CYCLE_SUMMARY',
      overall: result.overall,
      eligible: result.eligible,
      attempted: result.attempted,
      synced: result.synced,
      truncated: result.truncated,
      failed: result.failed,
      skipped: result.skipped,
      notAttempted: result.notAttempted,
      rebaselined: result.rebaselined,
      elapsedMs: result.elapsedMs,
    }),
  );
  return result;
}

// --- Entry point ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const log = (text: string) => process.stdout.write(text + '\n');
  const args = parseArgs(process.argv.slice(2));
  const organizationSlugs = parseOrganizations(args.organizations);
  if (organizationSlugs.length === 0) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--organizations <slug>[,<slug>] is required' }));
    return 2;
  }

  const origin = appOrigin();
  const env = readEnvironment(process.env, origin);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: env.reason, missing: env.missing.join(',') }));
    return 2;
  }

  // Imported here rather than at module scope so the orchestration above can be tested without a
  // database client being constructed as a side effect.
  const { prisma, repositories, createEmployeeCalendarSync, GoogleConnectionRepository, WorkSourceRepository } = await import('@emgloop/database');
  const google = readGoogleEnvironment(process.env, origin);
  if (google.state !== 'CONFIGURED') return 2;

  // The SAME assembly the web server uses (DL-3, DL-5): the same token path, the same sensor and
  // the same store. A second definition of "read my calendar" is exactly what this avoids.
  const calendars = createEmployeeCalendarSync({ prisma, google });
  const connections = new GoogleConnectionRepository(prisma);
  const sources = new WorkSourceRepository(prisma);

  try {
    const result = await runCalendarCycle(
      { organizationSlugs, baseline: args.baseline },
      {
        organizations: repositories.organizations,
        eligible: (organizationId) => connections.connectedMembers(organizationId, 'calendar'),
        lastRun: async (principal) => (await sources.recentRuns(principal, 1))[0] ?? null,
        sync: (principal, options) => calendars.syncCalendar(principal, options),
        log,
        now: () => new Date(),
      },
    );
    return cycleSucceeded(result.overall) ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Executed only when run directly, so importing this file does not start a cycle. The match is
// ANCHORED to the exact filename: a substring check would fire on the test file, whose own name
// contains this one.
const ENTRY_POINT = /[\\/]cycle-employee-calendars\.ts$/;
if (process.argv[1] && ENTRY_POINT.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stdout.write(line({ event: 'FATAL', detail: error instanceof Error ? error.message : 'unknown' }) + '\n');
      process.exitCode = 1;
    },
  );
}
