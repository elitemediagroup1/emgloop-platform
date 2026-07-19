// Manual auction-report sync — admin-gated, one explicit UTC day.
//
// POST because it writes. It is deliberately manual: recurring ingestion is not
// scheduled until a manual run has been reconciled against the provider, because
// a scheduler that quietly stores the wrong money unit every hour is worse than
// no scheduler at all.
//
// Bounded by construction: one day, one organization, a page cap, and a row
// limit. It cannot be pointed at a range.
//
// The credential is a process-level env var, which means this route is
// single-tenant in practice even though it is org-scoped in form. That is the
// same LIVE_ORG_SLUG-class ceiling documented in CLAUDE.md; this route does not
// widen it (it never reads a slug, and the organization always comes from the
// signed session), but it does not fix it either. Customer #2 needs per-org
// credentials before this can run for anyone else.

import { NextResponse } from 'next/server';
import { requireCrmContext } from '../../../../../crm/crm-data';
import { can } from '../../../../../auth/auth';
import { prisma, AuctionReportIngestionService } from '@emgloop/database';
import { resolveCallGridBaseUrl } from '@emgloop/providers';

export const dynamic = 'force-dynamic';

const PROVIDER = 'callgrid';

export async function POST(req: Request) {
  if (!(await can('integrations', 'manage'))) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }
  // The organization ALWAYS comes from the signed session. Never from the body,
  // never from a query parameter.
  const { organizationId } = await requireCrmContext();
  if (!organizationId) {
    return NextResponse.json({ ok: false, error: 'no-organization' }, { status: 400 });
  }

  const apiKey = process.env.CALLGRID_API_KEY || '';
  if (!apiKey) {
    return NextResponse.json(
      {
        ok: false,
        error: 'api-key-not-configured',
        detail:
          'CALLGRID_API_KEY is not set in this environment. No sync ran and nothing was stored. This is NOT an empty report.',
      },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const date = url.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'date-required',
        detail:
          'Pass ?date=YYYY-MM-DD. Exactly one UTC day. pingStats buckets rows per day, so a wider window collides on the snapshot identity and the sync refuses it.',
      },
      { status: 400 },
    );
  }

  const service = new AuctionReportIngestionService(prisma);
  try {
    const result = await service.ingestDay({
      organizationId,
      provider: PROVIDER,
      date,
      apiKey,
      baseUrl: resolveCallGridBaseUrl(),
      now: new Date(),
    });
    // 200 even for `partial` / `failed`: the run records were written and the
    // caller needs to read them. The `overall` field carries the verdict.
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    // Only a programming error reaches here — provider failures are outcomes,
    // not exceptions. The message is never echoed, in case it carries the URL.
    const detail = error instanceof Error ? error.message : 'unknown';
    return NextResponse.json(
      { ok: false, error: 'sync-failed', detail: detail.includes('date') ? detail : 'ingestion failed' },
      { status: 500 },
    );
  }
}
