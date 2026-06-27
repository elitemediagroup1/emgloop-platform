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
//
// Sprint 14 (Website Intelligence) extends the catalog + rules with website
// behaviour signals (research intent, comparison shopping, appointment intent,
// returning/engaged visitors, etc.). The Brain now reads two senses — phone and
// website — through this one registry.

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

  // --- Sprint 14: website behaviour signals ---
  web_preference: {
    key: 'web_preference',
    type: 'CUSTOM',
    label: 'Web Preference',
    description: 'Customer engages via website — a second sense for the Brain.',
  },
  research_intent: {
    key: 'research_intent',
    type: 'INTENT',
    label: 'Research Intent',
    description: 'Browsing guides / content without yet converting.',
  },
  comparison_shopper: {
    key: 'comparison_shopper',
    type: 'INTENT',
    label: 'Comparison Shopper',
    description: 'Repeated searches / multiple categories suggest comparison.',
  },
  buying_intent: {
    key: 'buying_intent',
    type: 'INTENT',
    label: 'Buying Intent',
    description: 'CTA / phone / appointment actions indicate purchase intent.',
  },
  appointment_intent: {
    key: 'appointment_intent',
    type: 'INTENT',
    label: 'Appointment Intent',
    description: 'Requested an appointment via a website surface.',
  },
  download_intent: {
    key: 'download_intent',
    type: 'INTENT',
    label: 'Download Intent',
    description: 'Downloaded a resource — active evaluation behaviour.',
  },
  returning_visitor: {
    key: 'returning_visitor',
    type: 'CUSTOM',
    label: 'Returning Visitor',
    description: 'Visitor has multiple website sessions over time.',
  },
  highly_engaged: {
    key: 'highly_engaged',
    type: 'CUSTOM',
    label: 'Highly Engaged',
    description: 'Deep / repeated interaction across website surfaces.',
  },
  high_value_prospect: {
    key: 'high_value_prospect',
    type: 'LIFETIME_VALUE',
    label: 'High Value Prospect',
    description: 'Strong buying + appointment signals from website behaviour.',
  },
  newsletter_subscriber: {
    key: 'newsletter_subscriber',
    type: 'UPSELL_OPPORTUNITY',
    label: 'Newsletter Subscriber',
    description: 'Opted into the newsletter — a nurturing channel is open.',
  },
  commercial_buyer: {
    key: 'commercial_buyer',
    type: 'INTENT',
    label: 'Commercial Buyer',
    description: 'Commercial / business context detected in website activity.',
  },
  pet_owner: {
    key: 'pet_owner',
    type: 'TOPIC',
    label: 'Pet Owner',
    description: 'Engagement with PetsInMyCity / pet topics.',
  },
  caregiver: {
    key: 'caregiver',
    type: 'TOPIC',
    label: 'Caregiver',
    description: 'Engagement with CareInMyCity / caregiving topics.',
  },
  wedding_planning: {
    key: 'wedding_planning',
    type: 'TOPIC',
    label: 'Wedding Planning',
    description: 'Engagement with wedding planning topics.',
  },
  moving_soon: {
    key: 'moving_soon',
    type: 'INTENT',
    label: 'Moving Soon',
    description: 'Relocation / moving context detected in website activity.',
  },
  website_source: {
    key: 'website_source',
    type: 'CUSTOM',
    label: 'Website Source',
    description: 'Which EMG property the customer engaged with.',
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

const COMMERCIAL_WORDS = ['commercial', 'business', 'office', 'enterprise', 'corporate'];
const MOVING_WORDS = ['moving', 'relocate', 'relocation', 'new home', 'move in'];
const WEDDING_WORDS = ['wedding', 'bride', 'groom', 'venue', 'reception'];

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
  for (const k of ['campaign', 'source', 'transcript', 'keyword', 'service', 'note',
                   'query', 'page', 'title', 'category', 'property', 'cta']) {
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
  const isWeb = event.eventType.startsWith('web.');
  const meta = (event.metadata ?? {}) as Record<string, unknown>;

  // Phone preference + homeowner candidate from any inbound call.
  if (isCall) {
    out.push(sig('phone_preference', { valueString: 'phone' }));
    if (event.eventType === 'call.inbound' || event.eventType === 'call.answered') {
      out.push(sig('homeowner_candidate', { confidence: 0.5 }));
    }
  }

  // --- Sprint 14: website-derived signals ---
  if (isWeb) {
    out.push(sig('web_preference', { valueString: 'website' }));

    const property = asString(meta['property']);
    if (property) out.push(sig('website_source', { valueString: property }));

    switch (event.eventType) {
      case 'web.guide_view':
      case 'web.page_view':
      case 'web.video_play':
        out.push(sig('research_intent', { confidence: 0.4 }));
        break;
      case 'web.search':
      case 'web.search_zip':
      case 'web.search_city':
      case 'web.search_category':
        out.push(sig('research_intent', { confidence: 0.5 }));
        out.push(sig('comparison_shopper', { confidence: 0.4 }));
        break;
      case 'web.cta_click':
      case 'web.phone_click':
        out.push(sig('buying_intent', { confidence: 0.7 }));
        break;
      case 'web.appointment_request':
        out.push(sig('appointment_intent', { confidence: 0.9 }));
        out.push(sig('buying_intent', { confidence: 0.85 }));
        out.push(sig('high_value_prospect', { confidence: 0.7 }));
        break;
      case 'web.form_submit':
        out.push(sig('buying_intent', { confidence: 0.75 }));
        break;
      case 'web.download':
        out.push(sig('download_intent', { confidence: 0.6 }));
        out.push(sig('research_intent', { confidence: 0.5 }));
        break;
      case 'web.newsletter_signup':
        out.push(sig('newsletter_subscriber', { confidence: 0.9 }));
        break;
      default:
        break;
    }

    // Property-derived topic signals (generic, property name drives the topic).
    if (property === 'petsinmycity') out.push(sig('pet_owner', { confidence: 0.7 }));
    if (property === 'careinmycity') out.push(sig('caregiver', { confidence: 0.7 }));

    // Context words (work across every property without per-site code).
    if (WEDDING_WORDS.some((w) => blob.includes(w))) out.push(sig('wedding_planning', { confidence: 0.6 }));
    if (MOVING_WORDS.some((w) => blob.includes(w))) out.push(sig('moving_soon', { confidence: 0.6 }));
  }

  // Emergency intent (works for both calls and website text).
  if (EMERGENCY_WORDS.some((w) => blob.includes(w))) {
    out.push(sig('emergency_intent', { confidence: 0.8 }));
  }

  // Service interest.
  if (SERVICE_WORDS.some((w) => blob.includes(w))) {
    out.push(sig('service_interest', { confidence: 0.6, valueString: matchedService(blob) }));
  }

  // Commercial buyer.
  if (COMMERCIAL_WORDS.some((w) => blob.includes(w))) {
    out.push(sig('commercial_buyer', { confidence: 0.55 }));
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
  const def = SIGNAL_REGISTRY[key] ?? { key: String(key), type: 'CUSTOM' as SignalType, label: String(key), description: '' };
  return {
    key: def.key,
    type: def.type,
    label: def.label,
    ...extra,
  };
}
