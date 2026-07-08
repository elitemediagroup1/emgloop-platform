// EMG Loop — Loop Event Gateway
// POST /api/v1/events
//
// Foundational inbound event receiver for all InMyCity producer sites
// (ArtistsInMyCity, CarsInMyCity, FoodInMyCity, PetsInMyCity, CareInMyCity,
// ServicesInMyCity, and future EMG properties).
//
// Scope of this handler (PR #80): receive, authenticate, validate, deduplicate,
// and STORE raw events only.
//   - No Brain execution.
//   - No Work OS automation.
//   - No CRM mutation.
//   - No Marketplace mutation.
//   - No outbound webhooks / email / Slack.
//
// Auth: shared-secret header "x-emg-loop-secret" compared against the Loop
// environment variable LOOP_EVENT_SECRET. Producer sites send the same value as
// EMG_LOOP_WEBHOOK_SECRET to EMG_LOOP_WEBHOOK_URL.

import { NextResponse } from 'next/server';
import { repositories } from '@emgloop/database';

export const dynamic = 'force-dynamic';

// Maximum accepted size of the "payload" object once serialized (bytes).
const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KB

function bad(message: string) {
  return NextResponse.json(
    { ok: false, error: 'bad_request', message },
    { status: 400 },
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function POST(request: Request) {
  // --- Auth: shared secret --------------------------------------------------
  const expectedSecret = process.env.LOOP_EVENT_SECRET;
  if (!expectedSecret) {
    // Misconfiguration on the Loop side. Treat as unauthorized rather than
    // accepting unauthenticated events.
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const providedSecret = request.headers.get('x-emg-loop-secret');
  if (!providedSecret || providedSecret !== expectedSecret) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // --- Content type: JSON only ---------------------------------------------
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return bad('content-type must be application/json');
  }

  // --- Parse JSON body ------------------------------------------------------
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return bad('invalid JSON body');
  }

  if (!isPlainObject(body)) {
    return bad('request body must be a JSON object');
  }

  const {
    eventId,
    platform,
    site,
    eventType,
    occurredAt,
    anonymousId,
    userId,
    sessionId,
    pageUrl,
    referrer,
    payload,
    metadata,
  } = body as Record<string, unknown>;

  // --- Required fields ------------------------------------------------------
  if (!isNonEmptyString(eventId)) return bad('eventId is required and must be a non-empty string');
  if (!isNonEmptyString(platform)) return bad('platform is required and must be a non-empty string');
  if (!isNonEmptyString(eventType)) return bad('eventType is required and must be a non-empty string');
  if (typeof occurredAt !== 'string') return bad('occurredAt is required and must be an ISO date string');

  const occurredAtDate = new Date(occurredAt);
  if (Number.isNaN(occurredAtDate.getTime())) {
    return bad('occurredAt must be a valid date');
  }

  if (!isPlainObject(payload)) {
    return bad('payload is required and must be an object');
  }

  // payload size cap
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    return bad(`payload exceeds maximum size of ${MAX_PAYLOAD_BYTES} bytes`);
  }

  // --- Optional fields ------------------------------------------------------
  if (metadata !== undefined && metadata !== null && !isPlainObject(metadata)) {
    return bad('metadata must be an object if provided');
  }
  if (site !== undefined && site !== null && typeof site !== 'string') {
    return bad('site must be a string if provided');
  }
  if (anonymousId !== undefined && anonymousId !== null && typeof anonymousId !== 'string') {
    return bad('anonymousId must be a string if provided');
  }
  if (userId !== undefined && userId !== null && typeof userId !== 'string') {
    return bad('userId must be a string if provided');
  }
  if (sessionId !== undefined && sessionId !== null && typeof sessionId !== 'string') {
    return bad('sessionId must be a string if provided');
  }
  if (pageUrl !== undefined && pageUrl !== null && typeof pageUrl !== 'string') {
    return bad('pageUrl must be a string if provided');
  }
  if (referrer !== undefined && referrer !== null && typeof referrer !== 'string') {
    return bad('referrer must be a string if provided');
  }

  // --- Deduplicate on eventId ----------------------------------------------
  const existing = await repositories.loopEvents.findLoopEventByEventId(eventId);
  if (existing) {
    return NextResponse.json({ ok: true, eventId, duplicate: true });
  }

  // --- Store raw event (immutable) -----------------------------------------
  try {
    await repositories.loopEvents.createLoopEvent({
      eventId,
      platform,
      site: (site as string | null | undefined) ?? null,
      eventType,
      occurredAt: occurredAtDate,
      anonymousId: (anonymousId as string | null | undefined) ?? null,
      userId: (userId as string | null | undefined) ?? null,
      sessionId: (sessionId as string | null | undefined) ?? null,
      pageUrl: (pageUrl as string | null | undefined) ?? null,
      referrer: (referrer as string | null | undefined) ?? null,
      payload: payload as Record<string, unknown>,
      metadata: (metadata as Record<string, unknown> | null | undefined) ?? {},
    });
  } catch (err: unknown) {
    // Handle a race where two identical eventIds arrive concurrently: the
    // unique constraint on eventId makes the second insert fail. Treat as a
    // duplicate rather than an error.
    const code = (err as { code?: string })?.code;
    if (code === 'P2002') {
      return NextResponse.json({ ok: true, eventId, duplicate: true });
    }
    throw err;
  }

  return NextResponse.json({ ok: true, eventId, stored: true });
}

// Method guard: this endpoint is POST only.
export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'bad_request', message: 'method not allowed; use POST' },
    { status: 405 },
  );
}
