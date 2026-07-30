// @emgloop/shared
//
// Cross-cutting types, constants, and helpers shared by web, api, and providers.
// Industry-agnostic by design — verticals extend via metadata, not new enums here.

// --- Verified Knowledge domain (kg.v1) ---
// The verified fact graph (entities / claims / relationships / sources /
// provenance / lifecycle) produced and consumed by PetsInMyCity. Distinct from any
// embedding / RAG document store. See ./knowledge.ts.
export * from './knowledge';
// Contract fixture (illustrative Austin-shaped batch) for the kg.v1 contract test.
export * from './knowledge-contract.fixture';

// --- Provider categories (mirrors the provider abstraction package) ---
// Sprint 10 adds 'ingestion' and 'analytics' for the integration/intelligence layer.
export const PROVIDER_CATEGORIES = [
  'ai',
  'voice',
  'sms',
  'email',
  'payment',
  'calendar',
  'ingestion',
  'analytics',
] as const;
export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number];

// --- Supported (future) providers. None integrated in Sprint 1. ---
// Sprint 10 adds ingestion/analytics provider slots. Sprint 11 wires CallGrid.
// Sprint 14 wires 'website' (EMG-owned properties) as the second live ingestion
// source — first-party, so it is not gated like the third-party analytics SDKs.
export const KNOWN_PROVIDERS: Record<ProviderCategory, readonly string[]> = {
  ai: ['anthropic', 'openai'],
  voice: ['elevenlabs', 'twilio', 'telnyx'],
  sms: ['twilio', 'telnyx'],
  email: ['sendgrid', 'mailgun', 'postmark'],
  payment: ['stripe'],
  calendar: ['google'],
  ingestion: ['callgrid', 'website', 'ga4', 'google_ads', 'google_search_console', 'microsoft_clarity', 'stripe', 'twilio', 'telnyx', 'postmark'],
  analytics: ['ga4', 'google_ads', 'google_search_console', 'microsoft_clarity'],
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

// --- Sprint 2: identity vocabulary shared across packages ---
// (SystemRole and related types are defined in @prisma/client; re-exported via
// @emgloop/database so packages that don't need the full DB package can import
// just the shared vocab here.)
export const SYSTEM_ROLE_LABELS: Record<string, string> = {
  OWNER: 'Super Admin',
  ADMIN: 'Organization Admin',
  MANAGER: 'Manager',
  EMPLOYEE: 'Agent',
  AI_EMPLOYEE: 'AI Employee',
  READ_ONLY: 'Read Only',
} as const;

// --- Sprint 10: normalized event type taxonomy ---
// Every external event normalizes into one of these event types before
// entering the Interaction / Signal / DomainEvent pipeline.
//
// Sprint 14 (Website Intelligence) extends the web.* family so EMG-owned
// websites become a first-class sense for the Brain. These are taxonomy
// additions only — additive and backward compatible; no existing type changes.
export const LOOP_EVENT_TYPES = [
  // Call / Voice
  'call.inbound', 'call.outbound', 'call.answered', 'call.missed',
  'call.completed', 'call.voicemail', 'call.transferred',
  // Web / Analytics (Sprint 10 baseline + Sprint 14 website intelligence)
  'web.session_start', 'web.session_end',
  'web.page_view', 'web.guide_view',
  'web.search', 'web.search_zip', 'web.search_city', 'web.search_category',
  'web.cta_click', 'web.phone_click', 'web.email_click',
  'web.external_link', 'web.affiliate_click',
  'web.form_start', 'web.form_submit', 'web.appointment_request', 'web.newsletter_signup',
  'web.chat_start', 'web.chat_complete',
  'web.download', 'web.quiz_start', 'web.quiz_complete',
  'web.planner_start', 'web.planner_save', 'web.planner_print',
  'web.video_play', 'web.error',
  'web.goal_conversion',
  // Advertising
  'ads.impression', 'ads.click', 'ads.conversion', 'ads.lead_form_submit',
  // Search
  'search.impression', 'search.click', 'search.position_change',
  // Payments
  'payment.initiated', 'payment.succeeded', 'payment.failed',
  'payment.refunded', 'subscription.created', 'subscription.canceled',
  // Messaging
  'sms.inbound', 'sms.outbound',
  'email.sent', 'email.delivered', 'email.opened', 'email.clicked',
  'email.bounced', 'email.unsubscribed',
  // AI Activity
  'ai.conversation_start', 'ai.conversation_end', 'ai.escalation',
  'ai.booking_created', 'ai.intent_detected',
  // Internal / Platform
  'crm.customer_created', 'crm.booking_created', 'crm.booking_completed',
  'crm.pipeline_moved', 'workflow.triggered', 'workflow.completed',
] as const;
export type LoopEventType = (typeof LOOP_EVENT_TYPES)[number];

// --- Sprint 10: normalized event payload shape ---
// The canonical form after normalization. Source-specific payloads are mapped
// into this shape by the NormalizationEngine before hitting the repository layer.
export interface NormalizedEvent {
  organizationId: string;
  source: string; // provider name: callgrid, website, ga4, gads, gsc, etc.
  externalId: string; // stable id in source system (idempotency key)
  eventType: LoopEventType;
  occurredAt: Date;
  customerId?: string; // resolved from email/phone if available
  customerEmail?: string;
  customerPhone?: string;
  durationSeconds?: number;
  summary?: string;
  metadata: Metadata; // full source payload context
}

// --- Truth States (mandatory platform architecture) ---
// The canonical semantic model for what the platform actually knows: SUCCESS,
// EMPTY, PARTIAL, UNKNOWN, UNAVAILABLE, ERROR. Every repository, service,
// intelligence module and UI surface uses this one model — there are no special
// cases. Only SUCCESS and EMPTY may render a numeric zero, and the type system
// enforces it rather than asking engineers to remember. See docs/TRUTH_STATES.md.
export * from './truth';

// --- The authoritative business timezone (America/New_York) ---
// The single source of truth for every business-reporting day boundary. No page,
// service, provider, or query may choose its own timezone for reporting.
export * from './business-time';
export * from './callgrid-window';

// --- The canonical CallGrid metric contract ---
// Every CallGrid business metric: its provenance, grain, versioned formula, and
// what zero / unknown / unavailable each mean for it — plus the one
// implementation of each formula. No surface may define a metric independently.
export * from './callgrid-metric-contract';

// --- CallGrid Intelligence: findings, evidence, significance, and the engine ---
// The deterministic explanation layer over the canonical reports. Every finding
// carries its evidence, its limitations and the versioned rule that produced it.
export * from './callgrid-intelligence';
// The ONE finding constructor. Three modules emit findings (engine, anomaly,
// bid); three private constructors would be three chances to drop the evidence,
// the rule version or the limitations that make a finding checkable.
export * from './callgrid-finding-builder';
// Historical series: the capability that makes "is this normal?" answerable at
// all. Consistency, volatility, trend, oscillation, new highs and dormancy are
// statements about a DISTRIBUTION — two points cannot support any of them, so
// every statistic here refuses to compute below a stated minimum.
export * from './callgrid-history';
// Anomaly detection over that series. Distribution rules stay silent without a
// series rather than degrading into a two-point comparison wearing the label.
export * from './callgrid-anomaly';
// Per-entity findings that only a distribution can support: record periods,
// sustained fades, rising dominance, emergence and consistency.
export * from './callgrid-entity-intelligence';
// Business Health: the second section of every page. A dimension whose signals
// cannot be measured is UNKNOWN, never HEALTHY.
export * from './callgrid-health';
// Opportunities, sized by MEASURED exposure or an arithmetic gap — never a
// forecast of upside, which would require caps, capacity and demand Loop cannot see.
export * from './callgrid-opportunity';
// Decision Support: the projection that separates measured fact from Loop's
// reading of it, makes missing information first-class, and names the review a
// person should make. Loop owns the facts; operators own the decisions.
export * from './callgrid-decision-support';
// Operational reasoning: findings as a connected system. It may claim arithmetic
// attribution and metric-formula lineage; it may never claim mechanism.
export * from './callgrid-reasoning';
// The Situation — the atom of the operational review system. Findings are MERGED
// into one business event BEFORE anything is ranked, so an operator receives one
// row per thing that is happening rather than one row per symptom. Every merge
// discloses its observation count and stays reversible by the reader.
export * from './callgrid-situation';
// The Intelligence Score — the one attention ordering. A component whose input
// is missing is WITHHELD from both numerator and denominator, never scored zero.
export * from './callgrid-scoring';
// Marketplace Risk: structural fragility, not a prediction. Same withholding
// rule, so a "LOW" band built from three of nine factors reports its determinacy.
export * from './callgrid-risk';
export * from './callgrid-intelligence-engine';
// Bid/ping snapshot intelligence: what each rejection MEANS operationally, which
// are expected configuration vs possibly preventable, and a deterministic review
// ORDER (never a revenue estimate — the bid reports carry no revenue).
export * from './callgrid-bid-intelligence';
// Reconciliation: proves Overview ↔ subpage internally, and makes the provider
// leg (which CallGrid exposes no endpoint for) a recorded manual check rather
// than an assumption.
export * from './callgrid-reconciliation';


// --- Period-over-period trend (today vs yesterday), honesty-first ---
export * from './metric-trend';

// --- The one canonical server-side application origin (absolute email links) ---
export * from './app-origin';

// --- Route → active nav (longest-prefix), for sidebar + breadcrumb ---
export * from './nav-match';

// --- The one gate for demo/fixture seeding (fail-closed; never in production) ---
export * from './demo-seed';

// --- Loop Cognitive Architecture: governed context response contract (Inc 3) ---
// The DTO shapes CognitiveContextService returns. Prisma-free by design so both
// the database layer (which maps rows into them) and web consumers depend on one
// contract, not on persistence. See ./cognitive-context.ts.
export * from './cognitive-context';

// --- Operational decision lifecycle (platform primitives) ---
// The pure projection from an append-only observation log to the current state
// of a priority, plus the operational history and decision-activity statistics
// derived from that log. Event-sourced by construction: the log is the truth and
// the stored state columns are a rebuildable cache. Generic — CallGrid
// Intelligence is the first producer, not the owner. See ./operational-lifecycle.ts.
export * from './operational-lifecycle';

// --- The canonical Decision contract (the Decision Center's platform model) ---
// One model for every producer, with each field marked PERSISTED or RESERVED and
// a test in @emgloop/database walking that list against the real columns — so
// this contract cannot describe a system that does not exist. See
// ./decision-contract.ts.
export * from './decision-contract';

// --- Decision card composition (presentation only) ---
// Confidence, the operational consequence, the ways a decision can end, and the
// visual tiering that shows EVERYTHING while giving the few the most room.
// Pure re-arrangement of measured fields — nothing here concludes anything.
export * from './decision-card';
