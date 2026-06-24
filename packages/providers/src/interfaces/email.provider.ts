// Email provider interface.
//
// Abstracts transactional email providers (SendGrid, Mailgun, ...).

import type { BaseProvider, ProviderContext } from '../types';

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailAttachment {
  filename: string;
  content: Uint8Array | string;
  contentType: string;
}

export interface SendEmailRequest {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress;
  subject: string;
  html?: string;
  text?: string;
  /** Provider template id + variables (when using hosted templates). */
  templateId?: string;
  templateData?: Record<string, unknown>;
  attachments?: EmailAttachment[];
  idempotencyKey?: string;
}

export interface SendEmailResult {
  externalId: string;
  status: 'queued' | 'sent' | 'failed' | 'unknown';
}

export interface EmailProvider extends BaseProvider {
  sendEmail(ctx: ProviderContext, req: SendEmailRequest): Promise<SendEmailResult>;
  verifyWebhook?(
    ctx: ProviderContext,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<boolean>;
}
