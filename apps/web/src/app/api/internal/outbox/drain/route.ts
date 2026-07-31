// The outbox drain trigger.
//
// WHAT THIS CLOSES. The Decision Engine has published domain events into the
// transactional outbox since #154, and `StateChangePublisher` has known how to
// deliver them since #148 — but nothing ever called it. Events were written and
// accumulated unread, so "publish, don't couple" held on paper while no consumer
// could have received anything. This is the missing half.
//
// THIS FILE IS THE TRIGGER, NOT THE WORK. Everything about what a drain pass IS
// lives in `OutboxDrainRunner`; this handler only authenticates a caller and
// reports the result. That separation is the point: swapping the schedule for a
// queue worker, a Lambda, an ECS task or an admin button replaces this file and
// nothing else. Nothing downstream — not the runner, not the publisher, not the
// engine — learns how it was woken up.
//
// TENANCY. There is NO organization anywhere in the request, and there must never
// be one. The runner asks the database which organizations have work; a body or
// query parameter naming a tenant is precisely the vulnerability CLAUDE.md's
// multi-tenant rules exist to prevent, and a shared secret authenticates a CLASS
// of caller, never a tenant. This endpoint is a platform operation on every
// tenant's queue, which is exactly why it may not accept a tenant.
//
// FAILS CLOSED. A missing secret is unauthorized, not open. Production never runs
// this unauthenticated.

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';

import { prisma, OutboxDrainRunner } from '@emgloop/database';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Constant-time secret comparison.
 *
 * A plain `!==` leaks the shared secret one byte at a time to anyone who can
 * measure response latency. Length is compared first because `timingSafeEqual`
 * throws on a length mismatch — and the length of a secret is not the part worth
 * protecting.
 */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.OUTBOX_DRAIN_SECRET;
  if (!expected) {
    // Misconfiguration on our side. Refusing is the only safe reading: an
    // unauthenticated drain endpoint is a denial-of-service lever on every
    // tenant's queue at once.
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const provided =
    request.headers.get('x-emg-drain-secret')
    ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? '';

  if (!provided || !secretMatches(provided, expected)) {
    // Deliberately identical to the missing-secret response. A caller must not be
    // able to tell "the server has no secret" from "your secret is wrong".
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const runner = new OutboxDrainRunner(prisma);
    const result = await runner.run();

    // The full result is returned because this IS the observability surface until
    // an admin page exists: which organizations were drained, what moved, what
    // was reclaimed, what dead-lettered, and whether the pass ran out of time.
    // No payloads, no tenant rows, no business content — counters and ids only.
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // A drain failure must be loud in the caller's logs rather than a silent 200.
    // The scheduled workflow checks this status, so a broken drain surfaces as a
    // failed run instead of a queue quietly filling up.
    const message = e instanceof Error ? e.message : 'unknown error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

/**
 * Explicitly not readable without the secret.
 *
 * A GET that reported queue depth would be an unauthenticated window into how
 * much work every tenant has pending. If a health view is wanted later it belongs
 * behind `requirePermission`, on an admin page, not here.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json({ ok: false, error: 'method not allowed' }, { status: 405 });
}
