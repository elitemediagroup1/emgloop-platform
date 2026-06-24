// Voice provider interface.
//
// Abstracts text-to-speech / speech synthesis and voice cloning providers
// (ElevenLabs first, others later). Pairs with VoiceProfile in the schema.

import type { BaseProvider, ProviderContext } from '../types';

export interface VoiceOption {
  voiceId: string;
  name: string;
  language?: string;
  gender?: string;
}

export interface SynthesizeRequest {
  voiceId: string;
  text: string;
  /** Output container, e.g. "mp3", "wav", "pcm". */
  format?: string;
  /** Provider-tunable knobs (stability, similarity, speed, ...). */
  settings?: Record<string, number | string | boolean>;
}

export interface SynthesizeResult {
  /** Synthesized audio bytes. */
  audio: Uint8Array;
  contentType: string;
  durationMs?: number;
}

export interface TranscribeRequest {
  audio: Uint8Array;
  contentType: string;
  language?: string;
}

export interface TranscribeResult {
  text: string;
  language?: string;
  confidence?: number;
}

export interface VoiceProvider extends BaseProvider {
  listVoices(ctx: ProviderContext): Promise<VoiceOption[]>;
  synthesize(ctx: ProviderContext, req: SynthesizeRequest): Promise<SynthesizeResult>;
  /** Optional speech-to-text; omit if the provider does not support it. */
  transcribe?(ctx: ProviderContext, req: TranscribeRequest): Promise<TranscribeResult>;
}
