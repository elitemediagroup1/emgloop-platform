// Read employee sources -- one organization's Google connections, and what Loop has read from them.
//
// READ-ONLY. For every Google connection in one organization it prints the connection's lifecycle,
// which capability scopes were granted, whether the scheduled cycle would pick that person up (the
// cycle's own eligibility query), each source's cursor and most recent sync runs, the freshness
// Loop would report, and ROW COUNTS of what is stored. It writes nothing, syncs nothing and calls
// no Google API.
//
// WHAT IT NEVER PRINTS: an id, an email or Google account, a subject, a title, a body, an address,
// an attendee, a file name or a token. Each person is the same digest the cycle logs (`ref`), so a
// line here can be followed into a cycle run, plus the first letter of their display name -- the
// least an operator needs to tell two test users apart.
//
// WHY IT EXISTS. "I connected Google and nothing appeared" has five possible answers -- no grant,
// a partial grant, never read, read and failed, read and nothing to show -- and only production
// rows can say which. This is how a human asks, without anyone opening a mailbox.
//
// NO SCHEDULE, NO PUSH, NO PULL_REQUEST, NO WORKFLOW_CALL. Reading production is still touching
// production, and a human should be the one asking.

import {
  CALENDAR_FRESHNESS_POLICY,
  GMAIL_FRESHNESS_POLICY,
  GOOGLE_WORKSPACE_CAPABILITIES,
  GOOGLE_WORKSPACE_CAPABILITY_SCOPES,
  GOOGLE_WORKSPACE_LEGACY_SCOPES,
  googleCapabilityStates,
  workSourceFreshness,
  type GoogleCapabilityState,
  type GoogleWorkspaceCapability,
  type WorkFreshnessPolicy,
  type WorkSource,
} from '@emgloop/shared';
import type {
  GoogleConnectionInventoryRow,
  WorkCursorRecord,
  WorkFootprint,
  WorkPrincipal,
  WorkSyncRunRecord,
} from '@emgloop/database';
import { employeeRef } from './cycle-employee-sources';

export interface EmployeeSourcesDeps {
  organizations: { findBySlug(slug: string): Promise<{ id: string; slug: string } | null> };
  connections: {
    inventory(organizationId: string): Promise<readonly GoogleConnectionInventoryRow[]>;
    connectedMembers(organizationId: string, capability: GoogleWorkspaceCapability): Promise<readonly { readonly userId: string }[]>;
  };
  sources: {
    cursor(principal: WorkPrincipal, source: WorkSource): Promise<WorkCursorRecord | null>;
    recentRuns(principal: WorkPrincipal, limit?: number, source?: WorkSource): Promise<readonly WorkSyncRunRecord[]>;
  };
  footprint: { counts(principal: WorkPrincipal): Promise<WorkFootprint> };
  now: () => Date;
  log: (line: string) => void;
}

export interface EmployeeSourcesResult {
  readonly overall: 'READ' | 'FAILED_PRECONDITION';
  readonly connections: number;
}

/** The sources the scheduled cycle reads, the capability each needs, and how fresh "fresh" is. */
const READ_SOURCES: readonly { source: WorkSource; capability: GoogleWorkspaceCapability; policy: WorkFreshnessPolicy }[] = [
  { source: 'GMAIL', capability: 'gmail', policy: GMAIL_FRESHNESS_POLICY },
  { source: 'CALENDAR', capability: 'calendar', policy: CALENDAR_FRESHNESS_POLICY },
];

/** How many recent runs per source are printed. Enough to see a first read and what followed. */
export const RECENT_RUNS = 3;

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

type Field = string | number | boolean | null;

function line(fields: Record<string, Field>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${v === null ? '-' : String(v)}`)
    .join(' ');
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** A scope's last path segment: `gmail.readonly`, never a URL in the log. */
const short = (scope: string): string => scope.slice(scope.lastIndexOf('/') + 1);

export function parseArgs(argv: readonly string[]): { organization: string } {
  let organization = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--organization' || argv[i] === '--org') {
      organization = (argv[i + 1] ?? '').trim();
      i += 1;
    }
  }
  return { organization };
}

export function readEnvironment(env: NodeJS.ProcessEnv): { ok: true } | { ok: false; missing: string[] } {
  return env.DATABASE_URL?.trim() ? { ok: true } : { ok: false, missing: ['DATABASE_URL'] };
}

export async function runEmployeeSources(request: { organizationSlug: string }, deps: EmployeeSourcesDeps): Promise<EmployeeSourcesResult> {
  const refuse = (reason: string): EmployeeSourcesResult => {
    deps.log(line({ event: 'PRECONDITION_FAILED', reason }));
    return { overall: 'FAILED_PRECONDITION', connections: 0 };
  };
  if (!SLUG.test(request.organizationSlug)) return refuse('--organization must be lowercase letters, digits and hyphens');
  const org = await deps.organizations.findBySlug(request.organizationSlug);
  if (!org) return refuse('unknown organization');

  const now = deps.now();
  const rows = await deps.connections.inventory(org.id);
  const eligible = new Map<GoogleWorkspaceCapability, Set<string>>();
  for (const { capability } of READ_SOURCES) {
    eligible.set(capability, new Set((await deps.connections.connectedMembers(org.id, capability)).map((m) => m.userId)));
  }
  deps.log(line({ event: 'ORGANIZATION', organization: org.slug, connections: rows.length, at: now.toISOString() }));

  for (const row of rows) {
    const principal: WorkPrincipal = { organizationId: org.id, userId: row.userId };
    const ref = employeeRef(principal);
    const c = row.connection;
    const states = googleCapabilityStates({ status: c.status, grantedScopes: c.grantedScopes, requestedScopes: c.requestedScopes });

    deps.log(line({
      event: 'EMPLOYEE',
      ref,
      initial: row.nameInitial,
      role: row.systemRole,
      membership: row.membershipStatus,
      connection: c.status,
      connectedAt: iso(c.connectedAt),
      lastUsedAt: iso(c.lastUsedAt),
      expiredAt: iso(c.expiredAt),
      revokedAt: iso(c.revokedAt),
      lastFailure: c.lastFailureClass,
      credential: row.hasCredential,
    }));

    const scopes: Record<string, Field> = { event: 'SCOPES', ref };
    for (const capability of GOOGLE_WORKSPACE_CAPABILITIES) {
      for (const scope of GOOGLE_WORKSPACE_CAPABILITY_SCOPES[capability]) scopes[short(scope)] = c.grantedScopes.includes(scope);
    }
    for (const scope of GOOGLE_WORKSPACE_LEGACY_SCOPES) scopes[`legacy.${short(scope)}`] = c.grantedScopes.includes(scope);
    deps.log(line(scopes));

    deps.log(line({ event: 'CAPABILITIES', ref, ...Object.fromEntries(GOOGLE_WORKSPACE_CAPABILITIES.map((cap) => [cap, states[cap]])) }));

    for (const { source, capability, policy } of READ_SOURCES) {
      const cursor = await deps.sources.cursor(principal, source);
      const runs = await deps.sources.recentRuns(principal, RECENT_RUNS, source);
      const freshness = workSourceFreshness(
        {
          // The web tier's Google client is configured in production; this runner cannot see its
          // environment, and "not configured" is a deployment fact, not this person's state.
          configured: true,
          capability: states[capability] as GoogleCapabilityState,
          lastSyncCompletedAt: cursor?.lastSyncCompletedAt ?? null,
          lastRunOutcome: runs[0]?.outcome ?? null,
        },
        now,
        policy,
      );
      deps.log(line({
        event: 'SOURCE',
        ref,
        source,
        eligible: eligible.get(capability)?.has(row.userId) ?? false,
        freshness,
        cursor: cursor?.cursorKind ?? null,
        lastStarted: iso(cursor?.lastSyncStartedAt ?? null),
        lastCompleted: iso(cursor?.lastSyncCompletedAt ?? null),
        lastFailure: cursor?.lastFailureClass ?? null,
        backoffUntil: iso(cursor?.backoffUntil ?? null),
        runs: runs.length,
      }));
      for (const run of runs) {
        deps.log(line({
          event: 'RUN',
          ref,
          source,
          startedAt: iso(run.startedAt),
          finishedAt: iso(run.finishedAt),
          outcome: run.outcome,
          examined: run.examined,
          written: run.written,
          failure: run.failureClass,
        }));
      }
    }

    const counts = await deps.footprint.counts(principal);
    deps.log(line({ event: 'ROWS', ref, ...counts }));
  }

  deps.log(line({ event: 'SUMMARY', connections: rows.length, gmailEligible: eligible.get('gmail')?.size ?? 0, calendarEligible: eligible.get('calendar')?.size ?? 0, OVERALL_RESULT: 'READ' }));
  return { overall: 'READ', connections: rows.length };
}

// --- Wiring -------------------------------------------------------------------

async function main(): Promise<number> {
  const log = (l: string) => process.stdout.write(l + '\n');
  const args = parseArgs(process.argv.slice(2));
  if (!args.organization) {
    log(line({ event: 'PRECONDITION_FAILED', reason: '--organization <slug> is required' }));
    return 2;
  }
  const env = readEnvironment(process.env);
  if (!env.ok) {
    log(line({ event: 'PRECONDITION_FAILED', reason: 'missing environment', missing: env.missing.join(',') }));
    return 2;
  }

  const { prisma, repositories, GoogleConnectionRepository, WorkSourceRepository, WorkFootprintRepository } = await import('@emgloop/database');
  try {
    const result = await runEmployeeSources(
      { organizationSlug: args.organization },
      {
        organizations: repositories.organizations,
        connections: new GoogleConnectionRepository(prisma),
        sources: new WorkSourceRepository(prisma),
        footprint: new WorkFootprintRepository(prisma),
        now: () => new Date(),
        log,
      },
    );
    return result.overall === 'READ' ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

const ENTRY_POINT = /[\\/]read-employee-sources\.ts$/;
if (process.argv[1] && ENTRY_POINT.test(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      // A class, never a cause: a database error message can carry a connection string.
      process.stdout.write(line({ event: 'RUN_FAILED', reason: 'UNEXPECTED' }) + '\n');
      process.exitCode = 1;
    },
  );
}
