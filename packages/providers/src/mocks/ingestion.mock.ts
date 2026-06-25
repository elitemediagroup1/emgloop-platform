// MockIngestionProvider — Sprint 10 (Loop Intelligence Foundation).
//
// No-op mock adapter. Used in tests and the configuration UI before a real
// provider adapter is wired in. Never makes real network calls.


import type { ProviderContext } from '../types';
import type {
  IngestionProvider,
  IngestionCapabilities,
  InboundEvent,
  PollOptions,
  PollResult,
  WebhookVerificationResult,
} from '../interfaces/ingestion.provider';


export class MockIngestionProvider implements IngestionProvider {
  readonly info = {
    id: 'mock-ingestion',
    category: 'ingestion' as const,
    displayName: 'Mock Ingestion Provider',
  };

  async healthCheck(_ctx: ProviderContext) {
    return { ok: true, checkedAt: new Date().toISOString() };
  }

  capabilities(): IngestionCapabilities {
    return {
      webhooks: true,
      polling: true,
      streaming: false,
      eventTypes: [
        'call.inbound', 'call.completed', 'sms.inbound',
        'web.session_start', 'web.goal_conversion',
      ],
    };
  }

  async verifyWebhook(
    _ctx: ProviderContext,
    _headers: Record<string, string>,
    _rawBody: string,
  ): Promise<WebhookVerificationResult> {
    return { valid: true };
  }

  async parseWebhook(
    _ctx: ProviderContext,
    payload: Record<string, unknown>,
  ): Promise<InboundEvent[]> {
    return [
      {
        externalId: String(payload['id'] ?? ('mock-' + Date.now())),
        rawEventType: String(payload['type'] ?? 'mock.event'),
        occurredAt: new Date(),
        payload,
      },
    ];
  }

  async poll(
    _ctx: ProviderContext,
    _options: PollOptions,
  ): Promise<PollResult> {
    return { events: [], hasMore: false };
  }
}
