// Mock provider adapters — Sprint 3 (First Customer Loop).
//
// These are in-memory, no-network implementations of every provider interface.
// They exist solely to prove the platform can orchestrate a full customer
// journey through the provider abstraction. Real adapters (Anthropic, Twilio,
// ElevenLabs, SendGrid, Google) drop in later behind the SAME interfaces, with
// zero changes to consumers.
//
// NOTE: The canonical mocks live here in @emgloop/providers. The Sprint 3 web
// demo ships its own self-contained copies under apps/web/src/demo to keep the
// Next.js production build free of cross-package transpilation requirements.

import { registerProvider } from '../registry';
import { mockAIProvider, MockAIProvider } from './mock-ai.provider';
import { mockSmsProvider, MockSmsProvider } from './mock-sms.provider';
import { mockVoiceProvider, MockVoiceProvider } from './mock-voice.provider';
import { mockEmailProvider, MockEmailProvider } from './mock-email.provider';
import {
  mockCalendarProvider,
  MockCalendarProvider,
} from './mock-calendar.provider';

export * from './mock-ai.provider';
export * from './mock-sms.provider';
export * from './mock-voice.provider';
export * from './mock-email.provider';
export * from './mock-calendar.provider';

export {
  MockAIProvider,
  MockSmsProvider,
  MockVoiceProvider,
  MockEmailProvider,
  MockCalendarProvider,
};

/**
 * Register every mock adapter into the shared provider registry under the
 * stable id "mock". Call once during demo/bootstrap. Idempotent in practice
 * because the registry keys on (category, id).
 */
export function registerMockProviders(): void {
  registerProvider(mockAIProvider);
  registerProvider(mockSmsProvider);
  registerProvider(mockVoiceProvider);
  registerProvider(mockEmailProvider);
  registerProvider(mockCalendarProvider);
}
