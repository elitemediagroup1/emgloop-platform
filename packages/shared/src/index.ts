// @emgloop/shared
//
// Cross-cutting types, constants, and helpers shared by web, api, and providers.
// Industry-agnostic by design — verticals extend via metadata, not new enums here.

// --- Provider categories (mirrors the provider abstraction package) ---
export const PROVIDER_CATEGORIES = [
  'ai',
  'voice',
  'sms',
  'email',
  'payment',
  'calendar',
] as const;
export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number];

// --- Supported (future) providers. None integrated in Sprint 1. ---
export const KNOWN_PROVIDERS: Record<ProviderCategory, readonly string[]> = {
  ai: ['anthropic'],
  voice: ['elevenlabs'],
  sms: ['twilio', 'telnyx'],
  email: ['sendgrid', 'mailgun'],
  payment: ['stripe'],
  calendar: ['google'],
} as const;

// --- Industry verticals the platform targets ---
export const INDUSTRIES = [
  'home_services',
  'nail_salon',
  'barbershop',
  'medical',
  'dental',
  'restaurant',
  'pizzeria',
  'law_firm',
  'automotive',
  'beauty_spa',
  'fitness',
  'generic',
] as const;
export type Industry = (typeof INDUSTRIES)[number];

// --- Channels ---
export const CHANNELS = [
  'phone',
  'sms',
  'email',
  'web_chat',
  'whatsapp',
  'in_person',
  'social',
  'other',
] as const;
export type Channel = (typeof CHANNELS)[number];

// --- Multi-tenant scoping helper ---
export interface TenantScope {
  organizationId: string;
  locationId?: string;
}

// --- Generic metadata bag used across the platform ---
export type Metadata = Record<string, unknown>;

// --- Result helper ---
export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

// --- Platform-wide constants ---
export const PLATFORM = {
  name: 'EMG Loop',
  appUrl: 'https://app.emgloop.com',
  firstDataSource: 'servicesinmycity',
} as const;
