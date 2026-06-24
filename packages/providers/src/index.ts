// @emgloop/providers — public surface.
//
// Provider-agnostic interfaces + registry. No concrete vendor adapters in
// Sprint 1: Claude, ElevenLabs, Twilio, Telnyx, Stripe, Google Calendar,
// SendGrid/Mailgun are intentionally NOT integrated yet.

export * from './types';
export * from './registry';

export * from './interfaces/ai.provider';
export * from './interfaces/voice.provider';
export * from './interfaces/sms.provider';
export * from './interfaces/email.provider';
export * from './interfaces/payment.provider';
export * from './interfaces/calendar.provider';
