// Mock AI provider.
//
// Sprint 3 — First Customer Loop.
// A deterministic, rule-based implementation of the AIProvider interface.
// It calls NO external API. It exists to prove that the platform can drive a
// full customer journey through the provider abstraction. Swapping in the real
// Anthropic adapter later requires zero changes to any consumer code.

import type { BaseProvider, ProviderContext, ProviderHealth } from '../types';
import type {
  AIProvider,
  AICompletionRequest,
  AICompletionResult,
} from '../interfaces/ai.provider';

const ISO = () => new Date().toISOString();

/**
 * Extremely small "intent" heuristic so the demo can branch without an LLM.
 * Real model reasoning replaces this entirely behind the same interface.
 */
function decideNextAction(text: string): {
  action: 'send_followup_sms' | 'book_appointment' | 'noop';
  reason: string;
} {
  const t = text.toLowerCase();
  if (t.includes('quote') || t.includes('hvac') || t.includes('estimate')) {
    return {
      action: 'send_followup_sms',
      reason: 'New service request detected; reach out to qualify and schedule.',
    };
  }
  if (
    t.includes('yes') ||
    t.includes('sounds good') ||
    t.includes('book') ||
    t.includes('tomorrow') ||
    t.includes('works')
  ) {
    return {
      action: 'book_appointment',
      reason: 'Customer confirmed interest; proceed to booking.',
    };
  }
  return { action: 'noop', reason: 'No actionable intent detected.' };
}

export class MockAIProvider implements AIProvider {
  readonly info = {
    id: 'mock',
    category: 'ai' as const,
    displayName: 'Mock AI (deterministic, no external calls)',
  };

  async healthCheck(_ctx: ProviderContext): Promise<ProviderHealth> {
    return { ok: true, message: 'mock ai online', checkedAt: ISO() };
  }

  async complete(
    _ctx: ProviderContext,
    req: AICompletionRequest,
  ): Promise<AICompletionResult> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const decision = decideNextAction(lastUser?.content ?? '');

    let text: string;
    switch (decision.action) {
      case 'send_followup_sms':
        text =
          'Hi! Thanks for requesting an HVAC quote with us. ' +
          'I can get a technician out to you — what day works best this week?';
        break;
      case 'book_appointment':
        text =
          'Great — I have you booked. You will receive a confirmation shortly.';
        break;
      default:
        text = 'Acknowledged.';
    }

    return {
      text,
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
      raw: { mock: true, decision },
    };
  }
}

export const mockAIProvider: BaseProvider = new MockAIProvider();
