// TEMPORARY — REMOVE IMMEDIATELY AFTER USE.
//
// POST /api/admin/setup-database
//
// One-time, token-protected bootstrap endpoint that applies the Prisma schema
// (migrate deploy) and runs the demo seed, from the DEPLOYED environment.
//
// SECURITY:
//   - Disabled unless the SETUP_SECRET env var is set (returns 404).
//   - Rejects every request whose x-setup-token header (or JSON body "token")
//     does not match SETUP_SECRET, using a constant-time comparison.
//   - Never returns or logs database credentials / connection strings.
//
// The migrate + seed logic lives in ../../lib/setup-database (shared with the
// internal /admin/setup-database page). See docs/HOTFIX-NEON-DB-SETUP.md for
// the REQUIRED cleanup. This is bootstrap plumbing, not a feature.

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { runDatabaseSetup } from '@/lib/setup-database';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.SETUP_SECRET;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: 'Setup endpoint is disabled (SETUP_SECRET is not set).' },
      { status: 404 },
      );
  }

let provided = request.headers.get('x-setup-token') ?? '';
  if (!provided) {
    try {
      const body = (await request.json()) as { token?: unknown };
      if (typeof body?.token === 'string') provided = body.token;
    } catch {
      // no/invalid body — fall through to rejection
    }
  }

if (!provided || !tokensMatch(provided, expected)) {
  return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
}

const result = await runDatabaseSetup();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

// Reject all non-POST methods explicitly.
export function GET(): Response {
  return NextResponse.json({ ok: false, error: 'Method not allowed. Use POST.' }, { status: 405 });
}
