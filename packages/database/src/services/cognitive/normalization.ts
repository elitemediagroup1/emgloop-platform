// Stage 2 — Normalization (PURE).
//
// Turns a processor input into a canonical NormalizedEvent: coerced timestamp,
// lower-cased channel, defaulted sensitivity/consent/purposes. Provider-specific
// field parsing does NOT live here — that belongs in provider adapters upstream
// (see loop-event-consumer.ts). This stage only canonicalizes an already-shaped
// event; it performs no I/O.

import type { ProcessEventInput, NormalizedEvent } from './types';

export function normalizeEvent(input: ProcessEventInput): NormalizedEvent {
  const occurredAt =
    input.occurredAt instanceof Date ? input.occurredAt : new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new Error('normalizeEvent: occurredAt is not a valid date');
  }
  const channel = input.channel ? String(input.channel).trim().toLowerCase() : null;
  return {
    organizationId: input.organizationId,
    sourceSystem: input.sourceSystem,
    sourceEventId: input.sourceEventId,
    eventType: input.eventType,
    occurredAt,
    channel,
    payload: input.payload ?? {},
    context: input.context ?? {},
    sensitivity: input.sensitivity ?? 'INTERNAL',
    consentBasis: input.consentContext?.consentBasis ?? 'NONE',
    requestedPurposes: input.requestedPurposes ?? [],
    aggregationEligibility: input.aggregationEligibility ?? false,
  };
}
