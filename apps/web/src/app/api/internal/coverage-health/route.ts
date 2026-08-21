// Is provider coverage keeping up? — the endpoint an external watcher polls.
//
// WHAT THIS CLOSES. Routine polling emits a coverage lag on every pass, and that
// number only exists WHILE the poller is running. A scheduled job that fails is
// visible; one that stops running is silent, and silence reads as health. This
// repository has already proved a red scheduled run is not an alert:
// `drain-outbox.yml` failed on a hundred consecutive runs, for months, because two
// secrets were never set, and nobody noticed.
//
// So this inverts the direction. Loop does not push an alert; something outside
// Loop pulls this endpoint and decides. It reads a DURABLE ROW — the poll
// checkpoint — so it stays true when the poller has failed, was switched off, was
// never enabled, or the deployment that runs it is down.
//
// NON-2xx IS THE ALERT, DELIBERATELY. Any status other than HEALTHY returns 503,
// so the dumbest possible monitor — an uptime checker that only knows about
// status codes — is sufficient. Given what happened to the outbox drain, needing
// a monitor smart enough to parse JSON would be a prerequisite nobody meets.
//
// TENANCY. There is NO organization anywhere in the request and there must never
// be one. This reports OPERATIONAL METADATA for every stream on the platform — a
// slug, a provider, a stream, two instants — and no call, customer, money,
// payload or identity. A shared secret authenticates a CLASS of caller, never a
// tenant, so this may never grow a parameter that names one.
//
// FAILS CLOSED. A missing secret is unauthorized, not open.
//
// THE PATH IS `coverage-health`, NOT `coverage/health`, AND THAT IS NOT COSMETIC.
// `.gitignore` carries an unanchored `coverage/` rule for test-coverage output,
// which matches a directory of that name ANYWHERE -- so a route at
// `api/internal/coverage/health/route.ts` is silently untracked. Every local test
// still passes, because they read the filesystem, and the endpoint 404s in
// production because the file was never committed. Renaming the segment sidesteps
// it; anchoring the ignore rule is a separate change with its own blast radius.

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';

import { prisma, repositories } from '@emgloop/database';
import {
  DEFAULT_COVERAGE_HEALTH_POLICY,
  assessCoverageHealth,
  worstCoverageStatus,
  type CoverageHealthStatus,
} from '@emgloop/shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Constant-time secret comparison.
 *
 * A plain `!==` leaks the shared secret one byte at a time to anyone who can
 * measure response latency. Length is compared first because `timingSafeEqual`
 * throws on a length mismatch — and the length of a secret is not the part worth
 * protecting. Same shape as the outbox drain trigger, deliberately.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: Request): Promise<Response> {
  const expected = process.env.COVERAGE_HEALTH_SECRET;
  if (!expected) {
    // Misconfiguration on our side. Refusing is the only safe reading: an
    // unauthenticated endpoint listing every tenant's polling state is an
    // information leak, however operational the fields are.
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  const provided =
    request.headers.get('x-emg-coverage-secret')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? '';
  if (!provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const policy = DEFAULT_COVERAGE_HEALTH_POLICY;

  let rows: Awaited<ReturnType<typeof repositories.pollCheckpoints.listForPlatformHealth>>;
  try {
    rows = await repositories.pollCheckpoints.listForPlatformHealth();
  } catch (error) {
    // A health endpoint that cannot read the database is not healthy, and must not
    // answer 200 while saying so in a field nobody parses.
    return NextResponse.json(
      {
        ok: false,
        status: 'UNKNOWN',
        error: 'coverage-read-failed',
        detail: error instanceof Error ? error.message : 'unknown',
      },
      { status: 503 },
    );
  }

  const streams = rows.map((row) => {
    const health = assessCoverageHealth({ completedThrough: row.completedThrough, now, policy });
    return {
      organization: row.organizationSlug,
      provider: row.provider,
      stream: row.stream,
      completedThrough: row.completedThrough.toISOString(),
      lastAdvancedAt: row.updatedAt.toISOString(),
      lagMs: health.lagMs,
      status: health.status,
    };
  });

  // NO ROWS MEANS NOTHING HAS EVER CLAIMED TO POLL, which is the correct state
  // before routine polling is switched on and is not an incident. The moment one
  // checkpoint exists the clock is running, and it is judged from then on. This is
  // the one case that answers 200 without being HEALTHY, and it says which it is.
  if (streams.length === 0) {
    return NextResponse.json({
      ok: true,
      status: 'NOT_ENABLED',
      checkedAt: now.toISOString(),
      policy: { laggingAfterMs: policy.laggingAfterMs, staleAfterMs: policy.staleAfterMs },
      streams,
      note:
        'No provider coverage checkpoint exists yet, so no coverage has ever been claimed. ' +
        'This is expected until routine polling is enabled.',
    });
  }

  const status: CoverageHealthStatus = worstCoverageStatus(streams.map((s) => s.status));
  const healthy = status === 'HEALTHY';
  return NextResponse.json(
    {
      ok: healthy,
      status,
      checkedAt: now.toISOString(),
      policy: { laggingAfterMs: policy.laggingAfterMs, staleAfterMs: policy.staleAfterMs },
      // Every stream, so a watcher that DOES parse the body can name the one that
      // is behind instead of paging somebody to go and look.
      streams,
    },
    // Any status other than HEALTHY is a non-2xx, so an uptime checker that knows
    // nothing but status codes is a sufficient monitor.
    { status: healthy ? 200 : 503 },
  );
}

// Deliberately GET-only and side-effect free. There is no POST, no PATCH and
// nothing here that advances, resets or repairs a checkpoint: a health check that
// can change the thing it measures is not a health check. `prisma` is imported
// only to keep the module graph identical to the other internal routes.
void prisma;
