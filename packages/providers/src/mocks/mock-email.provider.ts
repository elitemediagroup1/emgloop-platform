// Mock email provider (placeholder).
//
// Sprint 3 — First Customer Loop.
// Implements the EmailProvider interface in memory. No SendGrid/Mailgun.
// Captured messages are exposed so the demo can show what would have been sent.

import type { BaseProvider, ProviderContext, ProviderHealth } from '../types';
import type {
  EmailProvider,
  SendEmailRequest,
  SendEmailResult,
} from '../interfaces/email.provider';

const ISO = () => new Date().toISOString();

export interface MockEmailRecord extends SendEmailRequest {
  externalId: string;
  sentAt: string;
}

export class MockEmailProvider implements EmailProvider {
  readonly info = {
    id: 'mock',
    category: 'email' as const,
    displayName: 'Mock Email (placeholder, no external calls)',
  };

  readonly outbox: MockEmailRecord[] = [];
  private seq = 0;

  async healthCheck(_ctx: ProviderContext): Promise<ProviderHealth> {
    return { ok: true, message: 'mock email online', checkedAt: ISO() };
  }

  async sendEmail(
    _ctx: ProviderContext,
    req: SendEmailRequest,
  ): Promise<SendEmailResult> {
    const externalId = `mock-email-${++this.seq}`;
    this.outbox.push({ ...req, externalId, sentAt: ISO() });
    return { externalId, status: 'queued' };
  }
}

export const mockEmailProvider: BaseProvider = new MockEmailProvider();
