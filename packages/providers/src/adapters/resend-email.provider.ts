// Resend transactional email provider.
//
// Implements the shared EmailProvider interface using the official Resend
// Node.js SDK (https://resend.com/docs/send-with-nodejs). Provider-specific
// code stays inside @emgloop/providers; hosts resolve it through the registry
// or construct it directly and pass credentials via ProviderContext.
//
// This adapter performs a single outbound send per call. It does not read
// process.env directly: credentials arrive through ProviderContext.credentials
// so the package stays host-agnostic and testable.

import { Resend } from 'resend';

import type { ProviderContext, ProviderHealth } from '../types';
import type {
  EmailProvider,
  SendEmailRequest,
  SendEmailResult,
} from '../interfaces/email.provider';

const ISO = () => new Date().toISOString();

/** Reads the Resend API key from the opaque credentials bag. */
function apiKeyOf(ctx: ProviderContext): string {
  const key = ctx.credentials?.RESEND_API_KEY;
  if (!key) {
    throw new Error('ResendEmailProvider: missing RESEND_API_KEY credential');
  }
  return key;
}

/** Formats an EmailAddress[] / EmailAddress into what the Resend SDK expects. */
function fmt(
  addr: { email: string; name?: string } | { email: string; name?: string }[],
): string | string[] {
  const one = (a: { email: string; name?: string }) =>
    a.name ? `${a.name} <${a.email}>` : a.email;
  return Array.isArray(addr) ? addr.map(one) : one(addr);
}

export class ResendEmailProvider implements EmailProvider {
  readonly info = {
    id: 'resend',
    category: 'email' as const,
    displayName: 'Resend (transactional email)',
  };

  async healthCheck(ctx: ProviderContext): Promise<ProviderHealth> {
    try {
      apiKeyOf(ctx);
      return { ok: true, message: 'resend configured', checkedAt: ISO() };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'resend misconfigured',
        checkedAt: ISO(),
      };
    }
  }

  async sendEmail(
    ctx: ProviderContext,
    req: SendEmailRequest,
  ): Promise<SendEmailResult> {
    const resend = new Resend(apiKeyOf(ctx));

    const payload: Record<string, unknown> = {
      from: fmt(req.from) as string,
      to: fmt(req.to),
      subject: req.subject,
    };
    if (req.html) payload.html = req.html;
    if (req.text) payload.text = req.text;
    if (req.cc) payload.cc = fmt(req.cc);
    if (req.bcc) payload.bcc = fmt(req.bcc);
    // Reply-To is optional: only set when provided by the caller.
    if (req.replyTo) payload.replyTo = fmt(req.replyTo) as string;

    const { data, error } = await resend.emails.send(payload as never);

    if (error) {
      // Surface a useful server error without leaking provider internals or
      // any token-bearing content from the request.
      throw new Error(
        `ResendEmailProvider: send failed (${error.name ?? 'error'}): ${error.message ?? 'unknown'}`,
      );
    }

    return { externalId: data?.id ?? '', status: 'sent' };
  }
}
