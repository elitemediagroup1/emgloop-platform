// Mock voice provider (placeholder).
//
// Sprint 3 — First Customer Loop.
// Implements the VoiceProvider interface but performs NO synthesis. It returns
// an empty audio buffer so the provider slot is filled and the abstraction is
// exercised. The real ElevenLabs adapter drops in behind this same interface.

import type { BaseProvider, ProviderContext, ProviderHealth } from '../types';
import type {
  VoiceProvider,
  VoiceOption,
  SynthesizeRequest,
  SynthesizeResult,
} from '../interfaces/voice.provider';

const ISO = () => new Date().toISOString();

export class MockVoiceProvider implements VoiceProvider {
  readonly info = {
    id: 'mock',
    category: 'voice' as const,
    displayName: 'Mock Voice (placeholder, no synthesis)',
  };

  async healthCheck(_ctx: ProviderContext): Promise<ProviderHealth> {
    return { ok: true, message: 'mock voice online', checkedAt: ISO() };
  }

  async listVoices(_ctx: ProviderContext): Promise<VoiceOption[]> {
    return [
      { voiceId: 'mock-voice-1', name: 'Demo Voice', language: 'en', gender: 'neutral' },
    ];
  }

  async synthesize(
    _ctx: ProviderContext,
    _req: SynthesizeRequest,
  ): Promise<SynthesizeResult> {
    // No audio is produced in the demo.
    return {
      audio: new Uint8Array(0),
      contentType: 'audio/mpeg',
      durationMs: 0,
    };
  }
}

export const mockVoiceProvider: BaseProvider = new MockVoiceProvider();
