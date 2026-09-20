// Signing for the web <-> connections-worker control channel. PURE (Node crypto only).
//
// WHY THIS EXISTS. The interactive Telegram login (phone -> code -> 2FA) needs a live MTProto
// client held between steps, which a serverless web request cannot keep -- so the web tier calls the
// durable worker over HTTPS. This signs those calls with a deployment shared secret, so the worker
// honours ONLY requests from the Loop web tier and no one who merely reaches its address.
//
// WHAT THE SIGNATURE PROVES, AND WHAT IT DOES NOT. It authenticates a CLASS ("this is the Loop web
// tier"), not a tenant -- exactly the distinction the security rules draw. The organization and user
// are resolved by the web tier from the signed session and travel in the signed body; the worker
// still re-checks the membership before it writes (storeCredential), so a wrong pair cannot mint a
// credential. The shared secret is server-only on both sides and never logged.
//
// The signature covers a timestamp and the exact body, is timing-safe compared, and is rejected
// outside a tolerance window, so a captured call cannot be replayed indefinitely.

import { createHmac, timingSafeEqual } from 'crypto';

export const WORKER_SIGNATURE_HEADER = 'x-loop-worker-signature';
export const WORKER_TIMESTAMP_HEADER = 'x-loop-worker-timestamp';
/** A signed control call is honoured for five minutes either side of its timestamp. */
export const WORKER_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

function signature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** Produce the signature + timestamp headers for a control request body. */
export function signWorkerRequest(secret: string, body: string, now: Date = new Date()): { signature: string; timestamp: string } {
  const timestamp = String(now.getTime());
  return { signature: signature(secret, timestamp, body), timestamp };
}

/** Verify a control request: fresh timestamp, and a timing-safe signature match. Fail closed. */
export function verifyWorkerRequest(
  secret: string,
  input: { body: string; signature: unknown; timestamp: unknown; now?: Date; toleranceMs?: number },
): boolean {
  if (typeof secret !== 'string' || secret === '') return false;
  if (typeof input.signature !== 'string' || typeof input.timestamp !== 'string') return false;
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = (input.now ?? new Date()).getTime();
  const tolerance = input.toleranceMs ?? WORKER_SIGNATURE_TOLERANCE_MS;
  if (Math.abs(now - ts) > tolerance) return false;
  const expected = signature(secret, input.timestamp, input.body);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(input.signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
