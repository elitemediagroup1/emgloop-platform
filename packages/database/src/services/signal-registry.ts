// SignalRegistry — Sprint 11 (First Live Integration, Phase 4).
//
// The Brain's enrichment catalog. Every normalized event is run through a set of
// deterministic, provider-agnostic rules that derive higher-order Signals about
// the customer: intent, preferences, journey stage, behaviour. This is the
// "Signal Registry" referenced across the platform — a single place that defines
// WHAT signals exist and HOW raw events map to them, so no provider-specific
// enrichment logic leaks into business code.
//
// NO AI is used here. Rules are explicit and auditable. Signals are append-only
// (the schema's Signal model) and additive — re-processing an event simply
// re-asserts the same signals. A later sprint can add model-derived signals
// behind this same registry without changing callers.

import type { NormalizedEvent } from '@emgloop/shared';
import type { SignalType } from '@prisma/client';

export interface SignalDefinition {
  key: string;
  type: SignalType;
  label: string;
  description: string;
}

/** Derived signal ready to be written to the Signal table. */
export interface DerivedSignal {
  key: string;
  type: SignalType;
  label: string;
  valueString?: string;
  valueNumber?: number;
  confidence?: number;
}

// The canonical signal catalog. Adding a signal type is a one-line change here.
export const SIGNAL_REGISTRY: Record<string, SignalDefinition> = {
  homeowner_candidate: {
    key: 'homeowner_candidate',
    type: 'CUSTOM',
    label: 'Homeowner Candidate',
    description: 'Inbound contact about a home service suggests a homeowner.',
  },
  emergency_intent: {
    key: 'emergency_intent',
    type: 'INTENT',
    label: 'Emergency Intent',
    description: 'Language or context implies an urgent / emergency need.',
  },
  phone_preference: {
    key: 'phone_preference',
    type: 'CUSTOM',
    label: 'Phone Preference',
    description: 'Customer engages via phone — prefer voice for outreach.',
  },
  service_interest: {
    key: 'service_interest',
    type: 'INTENT',
    label: 'Service Interest',
    description: 'Customer expressed interest in a specific service.',
  },
  location_known: {
    key: 'location_known',
    type: 'CUSTOM',
    label: 'Location',
    description: 'A service location / area was captured for the customer.',
  },
  time_of_day_behavior: {
    key: 'time_of_day_behavior',
    type: 'CUSTOM',
    label: 'Time-of-day Behavior',
    description: 'When during the day the customer tends to engage.',
  },
  journey_stage: {
    key: 'journey_stage',
    type: 'CUSTOM',
    label: 'Customer Journey Stage',
    description: 'Where the customer sits in the lifecycle (new, engaged, ...).',
  },
};

const EMERGENCY_WORDS = [
  'emergency', 'urgent', 'asap', 'right now', 'flood', 'leak', 'burst',
  'no heat', 'no power', 'no ac', 'no air', 'gas', 'sparking', 'smoke',
];

const SERVICE_WORDS = [
  'hvac', 'plumb', 'electric', 'roof', 'repair', 'install', 'furnace',
  'heater', 'cooling', 'ac', 'air conditioning', 'drain', 'water heater',
];

function timeOfDayBucket(d: Date): string {
  const h = d.getHours();
  if (h < 6) return 'overnight';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

function text(event: NormalizedEvent): string {
  const parts: string[] = [];
  if (event.summary) parts.push(event.summary);
  const meta = event.metadata ?? {};
  for (const k of ['campaign', 'source', 'transcript', 'keyword', 'service', 'note']) {
    const v = (meta as Record<string, unknown>)[k];
    if (typeof v === 'string') parts.push(v);
  }
  return parts.join(' ').toLowerCase();
}

/**
 * Derive the enrichment signals for a normalized event. Pure function — no DB
 * access — so it is trivially testable and deterministic. The ingestion service
 * persists the returned signals through the Signal table.
 */
export function deriveSignals(event: NormalizedEvent): DerivedSignal[] {
  const out: DerivedSignal[] = [];
  const blob = text(event);
  const isCall = event.eventType.startsWith('call.');
  const meta = (event.metadata ?? {}) as Record<string, unknown>;

  // Phone preference + homeowner candidate from any inbound call.
  if (isCall) {
    out.push(sig('phone_preference', { valueString: 'phone' }));
    if (event.eventType === 'call.inbound' || event.eventType === 'call.answered') {
      out.push(sig('homeowner_candidate', { confidence: 0.5 }));
    }
  }

  // Emergency intent.
  if (EMERGENCY_WORDS.some((w) => blob.includes(w))) {
    out.push(sig('emergency_intent', { confidence: 0.8 }));
  }

  // Service interest.
  if (SERVICE_WORDS.some((w) => blob.includes(w))) {
    out.push(sig('service_interest', { confidence: 0.6, valueString: matchedService(blob) }));
  }

  // Location.
  const location =
    asString(meta['city']) ?? asString(meta['region']) ?? asString(meta['location']) ?? asString(meta['area']);
  if (location) {
    out.push(sig('location_known', { valueString: location }));
  }

  // Time-of-day behaviour.
  out.push(sig('time_of_day_behavior', { valueString: timeOfDayBucket(event.occurredAt) }));

  // Journey stage — first touch unless a prior booking is flagged.
  const stage = meta['hasPriorBooking'] === true ? 'engaged' : 'new_lead';
  out.push(sig('journey_stage', { valueString: stage }));

  return out;
}

function matchedService(blob: string): string {
  const hit = SERVICE_WORDS.find((w) => blob.includes(w));
  return hit ?? 'general';
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function sig(
  key: keyof typeof SIGNAL_REGISTRY,
  extra: Partial<Omit<DerivedSignal, 'key' | 'type' | 'label'>> = {},
): DerivedSignal {
  const def = SIGNAL_REGISTRY[key] ?? { key: String(key), type: 'CUSTOM' as SignalType, label: String(key), description: '' };  return {
    key: def.key,
    type: def.type,
    label: def.label,
    ...extra,
  };
}
