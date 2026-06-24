// Mock SMS provider.
//
// Sprint 3 — First Customer Loop.
// Implements the SmsProvider interface in memory. No Twilio/Telnyx. Outbound
// "sends" are recorded so the timeline and dashboard can display them; inbound
// messages are synthesized by the demo to simulate a customer reply.

import type { BaseProvider, ProviderContext, ProviderHealth } from '../types';
import type {
  SmsProvider,
  SendSmsRequest,
  SendSmsResult,
  InboundSms,
} from '../interfaces/sms.provider';

const ISO = () => new Date().toISOString();

export interface MockSmsRecord extends SendSmsRequest {
  externalId: string;
  sentAt: string;
}

export class MockSmsProvider implements SmsProvider {
  readonly info = {
    id: 'mock',
    category: 'sms' as const,
    displayName: 'Mock SMS (in-memory, no external calls)',
  };

  /** Captured outbound messages, exposed for the demo timeline. */
  readonly outbox: MockSmsRecord[] = [];
  private seq = 0;

  async healthCheck(_ctx: ProviderContext): Promise<ProviderHealth> {
    return { ok: true, message: 'mock sms online', checkedAt: ISO() };
  }

  async sendSms(
    _ctx: ProviderContext,
    req: SendSmsRequest,
  ): Promise<SendSmsResult> {
    const externalId = `mock-sms-${++this.seq}`;
    this.outbox.push({ ...req, externalId, sentAt: ISO() });
    return { externalId, status: 'delivered' };
  }

  /**
   * Parse a "raw" payload into a normalized inbound message. In the demo the
   * payload is already shaped like InboundSms; a real adapter would translate a
   * vendor webhook body here.
   */
  async parseInbound(
    _ctx: ProviderContext,
    payload: unknown,
  ): Promise<InboundSms> {
    const p = (payload ?? {}) as Partial<InboundSms>;
    return {
      externalId: p.externalId ?? `mock-inbound-${++this.seq}`,
      from: p.from ?? '+10000000000',
      to: p.to ?? '+10000000001',
      body: p.body ?? '',
      receivedAt: p.receivedAt ?? ISO(),
      raw: { mock: true },
    };
  }
}

export const mockSmsProvider: BaseProvider = new MockSmsProvider();
