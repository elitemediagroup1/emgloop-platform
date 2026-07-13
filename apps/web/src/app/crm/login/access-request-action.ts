'use server';

/**
 * Public "Request Access" intake action.
 *
 * This is an UNAUTHENTICATED access-request intake form. It only validates the
 * submission and emails it to the EMG operations inbox so a human can review it.
 *
 * It intentionally does NOT: create a user, create a session, create an
 * invitation, assign a role, grant access, reveal whether an email already
 * exists, or redirect to /crm/accept-invite. None of that happens here.
 *
 * Email is sent server-side only, through the existing transactional email
 * service (which wraps the Resend provider). Resend never runs in the browser.
 */

import { headers } from 'next/headers';
import { sendAccessRequestEmail } from '../../../lib/email/email-service';

/** Allow-list of access types. The browser value is never trusted. */
const ACCESS_TYPES = [
  'Employee workspace',
  'Creator workspace',
  'Business workspace',
  'Partner or vendor access',
  'Other',
] as const;

type AccessType = (typeof ACCESS_TYPES)[number];

export interface AccessRequestInput {
  fullName: string;
  email: string;
  company: string;
  accessType: string;
  roleTitle: string;
  reason: string;
  /** Honeypot: must be empty for a real human. */
  website: string;
  /** Client render timestamp (ms since epoch) used for a timing check. */
  renderedAt: number;
}

export interface AccessRequestResult {
  ok: boolean;
  /** Field-level messages for a safe validation error (form data is preserved client-side). */
  errors?: Record<string, string>;
  /** Generic top-level message. Never reveals provider/database internals. */
  message?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Strip control characters (incl. CR/LF) to prevent header injection. */
function stripControl(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, '');
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// --- Best-effort in-memory IP throttle -------------------------------------
// The repository has no shared rate-limit utility. On serverless this map is
// per-instance and not durable, so it is a smallest-safe deterrent only (it is
// documented as such). It never stores request contents.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 3;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  // Opportunistic cleanup to bound memory.
  if (hits.size > 5000) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= WINDOW_MS)) hits.delete(key);
    }
  }
  return recent.length > MAX_PER_WINDOW;
}

function clientIp(): string {
  const h = headers();
  const fwd = h.get('x-nf-client-connection-ip') || h.get('x-forwarded-for') || '';
  return fwd.split(',')[0]?.trim() || 'unknown';
}

const GENERIC_SUCCESS: AccessRequestResult = {
  ok: true,
  message:
    'Thanks — your request has been received. An EMG administrator will review it.',
};

const GENERIC_FAILURE: AccessRequestResult = {
  ok: false,
  message: "We couldn't submit your request right now. Please try again.",
};

export async function submitAccessRequest(
  input: AccessRequestInput,
): Promise<AccessRequestResult> {
  // 1) Honeypot — if populated, silently succeed without sending.
  if (clean(input.website) !== '') {
    return GENERIC_SUCCESS;
  }

  // 2) Timing check — reject/no-op submissions completed unrealistically fast.
  const elapsed = Date.now() - Number(input.renderedAt || 0);
  if (!Number.isFinite(elapsed) || elapsed < 1500) {
    return GENERIC_SUCCESS;
  }

  // 3) Rate limit per source IP (best-effort).
  if (rateLimited(clientIp())) {
    return GENERIC_SUCCESS;
  }

  // 4) Server-side validation (repeated, never trusting the client).
  const fullName = stripControl(clean(input.fullName));
  const email = stripControl(clean(input.email)).toLowerCase();
  const company = stripControl(clean(input.company));
  const accessTypeRaw = stripControl(clean(input.accessType));
  const roleTitle = stripControl(clean(input.roleTitle));
  const reason = clean(input.reason);

  const errors: Record<string, string> = {};
  if (!fullName || fullName.length > 100) errors.fullName = 'Enter your full name (max 100 characters).';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) errors.email = 'Enter a valid work email.';
  if (!company || company.length > 150) errors.company = 'Enter your company or organization (max 150 characters).';
  if (!ACCESS_TYPES.includes(accessTypeRaw as AccessType)) errors.accessType = 'Select an access type.';
  if (roleTitle.length > 100) errors.roleTitle = 'Role or title is too long (max 100 characters).';
  if (reason.length < 10 || reason.length > 1000) errors.reason = 'Tell us why you need access (10–1000 characters).';

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, message: 'Please correct the highlighted fields.' };
  }

  const accessType = accessTypeRaw as AccessType;
  const submittedAt = new Date();

  try {
    await sendAccessRequestEmail({
      fullName,
      email,
      company,
      accessType,
      roleTitle,
      reason,
      submittedAt,
    });
  } catch (err) {
    console.error('[access-request] delivery failed', {
      accessType,
      category: 'email_delivery_error',
    });
    return GENERIC_FAILURE;
  }

  console.info('[access-request] received', { accessType, result: 'sent' });
  return { ok: true };
}
