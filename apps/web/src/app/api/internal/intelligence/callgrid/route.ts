// The scheduled CallGrid detection trigger: situations are recorded because calls arrived, not
// because somebody opened a page.
//
// WHAT THIS CLOSES. The CallGrid pipeline -- report, history, bid report, the situation engine and
// the Decision Engine write -- ran only inside a page render (`loadExecutiveAnalysis`). A business
// change nobody looked at was never recorded, so nothing downstream (the outbox, the Case log, the
// memory of what happened last time) could react to it. This route runs that SAME pipeline for
// each organization that received calls, with no viewer.
//
// THIS FILE IS THE TRIGGER, NOT THE WORK. Like the outbox drain, it authenticates a caller and
// reports counts. Everything a pass IS -- which window, which situations, how they are recorded --
// is the page's own code (`loadCommandContextFor`, `loadExecutiveAnalysis`), so a scheduled pass
// records exactly what a person opening Today's Overview would have recorded, and the two can
// never disagree.
//
// NO VIEWER, NO AUTHORITY TO ACT. The context is built with no session and `canAct` false. The
// pass records situations through the Decision Engine as the SYSTEM producer it already is; it
// assigns nobody, resolves nothing, changes no bid or campaign and sends nothing.
//
// TENANCY. There is NO organization in the request, and there must never be one. The database says
// which organizations received calls recently (ids only), and each is processed in its own scope.
// A shared secret authenticates a CLASS of caller -- the platform scheduler -- never a tenant.
//
// BOUNDED. One daily window per organization, at most MAX_ORGANIZATIONS per pass, and a time
// budget under the platform's request limit. What does not fit waits for the next pass; every
// write is keyed (recurrence and detection key), so a repeated pass records nothing twice.
//
// FAILS CLOSED. A missing secret is unauthorized, not open.
import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { repositories } from '@emgloop/database';
import { loadCommandContextFor } from '../../../../app/admin/marketplace/command-data';
import { loadExecutiveAnalysis } from '../../../../app/admin/marketplace/executive-data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** How far back an organization's calls make it worth a pass. */
const RECENT_MS = 36 * 3_600_000;
const MAX_ORGANIZATIONS = 25;
/** Stop starting new organizations after this long; Netlify ends a request at 60 s. */
const BUDGET_MS = 40_000;

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.INTELLIGENCE_DETECT_SECRET;
  const provided =
    request.headers.get('x-emg-detect-secret') ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  // Deliberately one response for "no secret configured" and "wrong secret".
  if (!expected || !provided || !secretMatches(provided, expected)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const started = Date.now();
  const organizationIds = await repositories.marketplaceCalls.organizationIdsWithCallsSince(new Date(started - RECENT_MS), MAX_ORGANIZATIONS);
  const passes: { organizationId: string; result: 'RECORDED' | 'NOT_RECORDED' | 'FAILED'; situations: number }[] = [];
  let deferred = 0;
  for (const organizationId of organizationIds) {
    if (Date.now() - started > BUDGET_MS) {
      deferred += 1;
      continue;
    }
    try {
      const ctx = await loadCommandContextFor(organizationId, { period: 'daily' }, { session: null, canAct: async () => false });
      const analysis = await loadExecutiveAnalysis(ctx);
      passes.push({
        organizationId,
        // A persistence failure is reported, never hidden: the situations were computed but not kept.
        result: analysis.ops.persistenceError ? 'NOT_RECORDED' : 'RECORDED',
        situations: analysis.ops.items.length,
      });
    } catch {
      // One organization failing never stops the next. No message: it could carry tenant data.
      passes.push({ organizationId, result: 'FAILED', situations: 0 });
    }
  }
  // Organization ids and counts only: no titles, no buyers, no figures.
  return NextResponse.json({ ok: true, organizations: organizationIds.length, deferred, elapsedMs: Date.now() - started, passes });
}
