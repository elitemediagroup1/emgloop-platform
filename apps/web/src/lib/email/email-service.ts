// Server-only transactional email service for EMG Loop.
//
// This is the ONLY module auth/CRM flows import to send email. It hides the
// provider behind the shared @emgloop/providers abstraction: it constructs a
// ResendEmailProvider and passes configuration through ProviderContext.
// Auth actions must never import 'resend' or ResendEmailProvider directly.
//
// Environment variables (never hardcode, never log values):
//   RESEND_API_KEY      - Resend API key (secret; server-only)
//   LOOP_EMAIL_FROM     - From address, e.g. "Loop <loop@emgloop.com>"
//   LOOP_EMAIL_REPLY_TO - Optional Reply-To, e.g. "matt@elitemediagroup.io"
//
// Missing configuration:
//   production      -> throw a clear error (never pretend delivery succeeded)
//   non-production  -> log a safe warning and skip sending

import 'server-only';

import { ResendEmailProvider } from '@emgloop/providers';
import type {
  EmailAddress,
  SendEmailRequest,
} from '@emgloop/providers';

import {
  accessRequestTemplate,
  inviteTemplate,
  passwordResetTemplate,
} from './templates';

interface EmailConfig {
  apiKey: string;
  from: EmailAddress;
  replyTo?: EmailAddress;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Parses a "Name <email@host>" or bare "email@host" string into EmailAddress. */
function parseAddress(raw: string): EmailAddress {
  const m = raw.match(/^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/);
  if (m) return { name: m[1] || undefined, email: m[2]! };
  return { email: raw.trim() };
}

/**
 * Reads and validates email configuration from the environment.
 * Returns null when configuration is incomplete (caller decides how to react).
 */
function readConfig(): EmailConfig | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.LOOP_EMAIL_FROM;
  const replyToRaw = process.env.LOOP_EMAIL_REPLY_TO;

  if (!apiKey || !from) return null;

  return {
    apiKey,
    from: parseAddress(from),
    // Reply-To is optional; omit when missing rather than crashing.
    replyTo: replyToRaw ? parseAddress(replyToRaw) : undefined,
  };
}

const provider = new ResendEmailProvider();

/**
 * Core send. Resolves config, applies the production/development policy for
 * missing configuration, and delegates to the provider. Never logs tokens,
 * secrets, or complete token-bearing URLs.
 */
async function send(
  to: EmailAddress,
  rendered: { subject: string; html: string; text: string },
  purpose: string,
  replyToOverride?: EmailAddress,
): Promise<void> {
  const config = readConfig();

  if (!config) {
    if (isProduction()) {
      throw new Error(
        `Email not sent (${purpose}): transactional email is not configured. ` +
          'Set RESEND_API_KEY and LOOP_EMAIL_FROM.',
      );
    }
    // Non-production: warn (no secrets, no URLs) and skip so unrelated pages work.
    console.warn(
      `[email] Skipping ${purpose} email: RESEND_API_KEY / LOOP_EMAIL_FROM not set (non-production).`,
    );
    return;
  }

  const req: SendEmailRequest = {
    from: config.from,
    to: [to],
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    ...((replyToOverride ?? config.replyTo)
      ? { replyTo: (replyToOverride ?? config.replyTo) as EmailAddress }
      : {}),
  };

  const result = await provider.sendEmail(
    {
      organizationId: 'system',
      credentials: { RESEND_API_KEY: config.apiKey },
    },
    req,
  );

  if (result.status === 'failed') {
    throw new Error(`Email not sent (${purpose}): provider reported failure.`);
  }
  // Operational log only: no recipient tokens, no URLs, no secrets.
  console.info(`[email] ${purpose} email dispatched (status=${result.status}).`);
}

export async function sendInviteEmail(params: {
  to: string;
  name?: string;
  inviteUrl: string;
}): Promise<void> {
  const rendered = inviteTemplate({ name: params.name, inviteUrl: params.inviteUrl });
  await send({ email: params.to, name: params.name }, rendered, 'invite');
}

export async function sendPasswordResetEmail(params: {
  to: string;
  name?: string;
  resetUrl: string;
}): Promise<void> {
  const rendered = passwordResetTemplate({ name: params.name, resetUrl: params.resetUrl });
  await send({ email: params.to, name: params.name }, rendered, 'password-reset');
}

/**
 * Send the internal "Request Access" notification to the EMG operations inbox.
 *
 * Recipient is `LOOP_ACCESS_REQUEST_TO` (never hardcoded in the provider).
 * Reply-To is set to the requester's email so the team can reply directly.
 * This creates no user, session, or invitation — it is a notification only.
 */
export async function sendAccessRequestEmail(params: {
  fullName: string;
  email: string;
  company: string;
  accessType: string;
  submittedAt: Date;
}): Promise<void> {
  const to = process.env.LOOP_ACCESS_REQUEST_TO?.trim();
  if (!to) {
    if (isProduction()) {
      throw new Error(
        'Email configuration error: LOOP_ACCESS_REQUEST_TO is not set.',
      );
    }
    console.warn(
      '[email-service] LOOP_ACCESS_REQUEST_TO not set; skipping access-request notification (non-production).',
    );
    return;
  }

  const rendered = accessRequestTemplate(params);
  await send(
    { email: to },
    rendered,
    'access-request',
    { email: params.email, name: params.fullName },
  );
}
