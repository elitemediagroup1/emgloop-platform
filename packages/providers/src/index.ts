// @emgloop/providers
//
// Provider-agnostic interfaces + registry. No concrete vendor adapters in the
// core; Sprint 3 adds in-memory MOCK adapters under ./mocks to demo the loop.

export * from './types';
export * from './registry';
export * from './interfaces/ai.provider';
export * from './interfaces/voice.provider';
export * from './interfaces/sms.provider';
export * from './interfaces/email.provider';
export * from './interfaces/payment.provider';
export * from './interfaces/calendar.provider';

// Sprint 3 — First Customer Loop: in-memory mock adapters (no external calls).
export * from './mocks';
