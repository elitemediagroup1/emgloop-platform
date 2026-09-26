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
  // No person. Normalization records what happened; who it was is decided only
  // by governed identity resolution, never here. What the source reported about
  // the caller or submitter stays in `metadata`.
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

// --- The Loop Time Authority ---
// UTC instants, shown in each reader's own timezone. The one place a timezone is
// validated and an instant is formatted. See docs/architecture/loop-time-authority.md.
export * from './loop-time';
// --- The Eastern reporting calendar (America/New_York) ---
// The calendar CallGrid reporting, CI measurement windows and Work OS targets are
// defined on. Not a presentation timezone; see business-time.ts.
export * from './business-time';
export * from './observation-source';
export * from './provider-fact-convergence';
// Which interval the next routine poll should read. Pure; the checkpoint it
// reasons from is persisted in @emgloop/database, and nothing here advances it.
export * from './poll-interval-planning';
// Splitting an explicit recovery interval into deterministic Eastern-day chunks.
// Pure; the operation that runs them lives in scripts/operations.
export * from './recovery-chunking';
// Whether proven coverage is keeping up. Pure; read by an operational health
// endpoint so an external watcher can see a poller that STOPPED, not only one
// that failed.
export * from './coverage-health';
// Loop Intelligence (PR A, 2026-09-24): the coverage contract every piece of domain intelligence
// carries, and the contract of `intelligence_digests` (principal-private, minimized, bounded).
export * from './intelligence-coverage';
export * from './intelligence-digest';
// Loop Intelligence PR 2 (the fabric): canonical entity references, the participation contract every
// domain reading follows, and the domain + source registries.
export * from './entity-ref';
export * from './intelligence-contract';
export * from './intelligence-registry';
export * from './intelligence-projection';
// Loop Intelligence Phase C: Promote to Work, the one bridge from intelligence to Work OS.
export * from './promote-to-work';
// Loop Intelligence Phase F: situations are Cases; private ones are one person's alone.
export * from './situation';
// Whether a stored digest may feed synthesis (situations, the Briefing): the shared freshness contract.
export * from './intelligence-eligibility';
// Loop Intelligence Phase D: the Mail content governance gate (counterparty consent: UNRESOLVED).
export * from './mail-content-governance';
// Representative product states for building and reviewing surfaces. Typed as the
// real contracts, so a contract change breaks the fixtures rather than the design.
export * from './product-states.fixture';
// Turning a Headline into an authorized investigation. Pure: identity, severity
// mapping and the outcome vocabulary. The write lives in @emgloop/database.
export * from './headline-investigation';
// The investigation, assembled for a product surface. A derived read model over
// the Decision Center, its evidence and the Headline that opened it. Nothing here
// is persisted.
export * from './case-brief';

// HOW a piece of evidence entered Loop: measured, or reported by a person. Says
// nothing about whether to believe it -- trust, authority and diagnostic power
// are properties of a claim plus its evidence, decided by standards that do not
// exist yet.
export * from './evidence-class';

// What LATER evidence says about earlier evidence. Immutable rows, additive
// context: five governed relations recorded as facts on the Case's own log,
// which never edit, replace or reclassify the evidence they are about.
export * from './evidence-context';

// What Loop CONCLUDES on an investigation, and what it may call established.
// The authority boundary: a claim reaches ESTABLISHED only through the
// deterministic Stage 3 gate proving the measurement under it eligible. A
// person's acceptance is a judgement on its own axis and does not establish
// anything. Establishment is derived on read, never stored, so a claim whose
// evidence degrades stops being established without anything having to run.
export * from './work-execution';
export * from './case-work-coordination';
export * from './case-monitoring';
export * from './case-learning';
export * from './stage4-ui.fixture';
export * from './attention-state';
export * from './product-language';
export * from './case-observation';
export * from './case-finding';

// What could be DONE about a finding, and the ceiling on how firmly Loop may say
// it. Reuses the shipped decision-support vocabularies (evidence strength,
// approved verbs) rather than forking them: an option's posture may never exceed
// what its finding's evidence supports, and ranking is explained from inspectable
// factors instead of collapsed into a score.
export * from './case-recommendation';

// Who is involved in an investigation and what each of them is being asked for --
// and the line between that and the work itself. Participation carries no due
// date, dependency, SLA, blocked state or completion: those are execution
// obligations and Work OS owns them, so a Case REFERENCES work rather than
// copying its mutable state.
export * from './case-participation';

// How much this matters to the BUSINESS and how much it matters to YOU, kept
// permanently apart. Two fields, never combined, and no function that reduces
// them to one: personal relevance is a tier derived from rows somebody can point
// at, business significance stays the shipped severity vocabulary, and ordering
// is a declared lexicographic walk that can always explain itself.
export * from './personal-priority';
export * from './callgrid-window';
export * from './callgrid-period';
export * from './callgrid-command';

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
export * from './callgrid-metric-presentation';
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

// Intake Record provenance: how a legacy Customer row was created, classified at
// read time only; never identity, never written back. See ./intake-provenance.ts.
export * from './intake-provenance';

// --- Party: the canonical identity contract over CognitiveIdentity (CRM P0.2a) ---
// PERSON and COMPANY only; commercial capacities are roles, never Party types. A
// party-typed row is a cognitive subject until a governed basis -- provenance, not
// a method name and never a confidence number -- establishes it. See ./party.ts.
export * from './party';
// Party Reference (Identity 2.0b): every other domain refers to a Party by
// (organizationId, partyId) only. ESTABLISHED, NOT_ESTABLISHED, SUPERSEDED (resolved
// forward) or NOT_FOUND; writes reference ESTABLISHED Parties only. See ./party-reference.ts.
export * from './party-reference';
// Party read models (identity slice P1): People and Companies are established,
// non-superseded, non-archived Parties; a record's identity posture is stated,
// never a number; no contact values. See ./party-read-model.ts.
export * from './party-read-model';

// --- Universal Activity: the activity.v1 item contract (slice A1) ---
// A reference to a record a source domain owns, with an explanation. Identity is
// derived at read time and never invented; no raw values; no confidence. See
// ./activity.ts and docs/architecture/universal-activity.md.
export * from './activity';

// Reading Universal Activity (slice A2): page limits, the cursor in the one order,
// and the k-way merge each composed read uses. Adapters live in @emgloop/database,
// because every source is read under its own authority. See ./activity-read.ts.
export * from './activity-read';

// --- Loop AI runtime contracts (slice AI S0) ---
// Provider-neutral by construction: routing is policy, never a branch on a vendor
// name. No SDK, no credential and no model call lives here or can be reached from
// here -- provider adapters are the only code allowed to import one. Every claim an
// answer makes cites evidence Loop supplied, or the answer is rejected whole. See
// ./ai/ and docs/architecture/loop-ai-runtime.md.
export * from './ai';

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

// --- The Decision Event contract (what leaves the engine) ---
// The canonical observation -> event map, the payload every subscriber receives,
// and — read these FIRST — the delivery guarantees, including the ones marked
// NOT_BUILT. The contract is code rather than prose precisely so it cannot
// describe a stream the system does not publish. See ./decision-events.ts.
export * from './decision-events';

// --- CRM Relationship and Participant: pure contracts (slice R1) ---
// A Relationship is a human-asserted commercial connection (OWN: the tenant and a
// counterparty; THIRD_PARTY: two Parties); a Participant is the contextual role an
// established Party holds in a CRM subject. Roles never become Party types. See
// ./crm-relationship.ts, ./crm-participant.ts and docs/architecture/relationship-participant.md.
export * from './crm-relationship';
export * from './crm-participant';

// Relationship read models (slice R3-A3). A read resolves a superseded Party forward
// and SAYS SO; a write refuses it. Neither ever rewrites a stored id. Duplicates that
// resolve alike are reported for a person, never merged. See ./crm-relationship-read-model.ts.
export * from './crm-relationship-read-model';

// --- Decision card composition (presentation only) ---
// Confidence, the operational consequence, the ways a decision can end, and the
// visual tiering that shows EVERYTHING while giving the few the most room.
// Pure re-arrangement of measured fields — nothing here concludes anything.
export * from './decision-card';

// --- Commercial Intelligence: Performance Objectives (Stage 1) ---
// Human-authored intent — what an organization or a person is trying to
// accomplish. The referent a future CI Signal is defined *relative to*, and the
// only Commercial Intelligence concept that exists today. Carries no metric,
// target or attainment: Loop cannot measure those, and a field claiming
// otherwise would be a number tracing to nothing. See ./performance-objective.ts.
export * from './performance-objective';

// --- Commercial Intelligence: Commercial Signals (Stage 2) ---
// An observed fact evaluated RELATIVE TO a Performance Objective, plus the
// reason it may be relevant. Distinct in every respect from the incumbent
// behavioural `Signal` model, which this contract does not read, wrap or touch.
// Carries no score and no confidence: Loop has no approved relevance model, and
// `TERM_MATCH` is a deterministic Stage 2 mechanism, not that model.
// See ./commercial-signal.ts.
export * from './commercial-signal';

// --- Commercial Intelligence: Headlines (Stage 3 v1) ---
// How an objective becomes measurable, what a measured development is, and what
// makes one worth a person's time.
//
//   objective-measure-binding  what to measure and which rows count. Human-
//                              confirmed, immutable, versioned. No target, no
//                              baseline, no formula builder — those are a KPI
//                              product and a separate approval.
//   provider-observation       whether a business date was actually looked at.
//                              The gate that runs BEFORE the arithmetic, so an
//                              ingestion gap can never present as a decline.
//   commercial-measurement     the pure arithmetic and the ONE materiality rule.
//                              Every threshold is inherited from
//                              CALLGRID_SIGNIFICANCE_RULES, not invented here.
//   headline                   the development record. A PERSISTED OBJECT WITH NO
//                              WORK LIFECYCLE — no owner, no assignee, no lane, no
//                              outcome. A Decision is a different thing and
//                              `OperationalPriority` already is it.
//
// Commercial Signals sit BESIDE this flow. They may be cited as supporting
// detail; they never define a population, a denominator or an importance.
export * from './objective-measure-binding';
export * from './provider-observation';
export * from './commercial-measurement';
export * from './headline';
// Where a Headline stands: a PURE PROJECTION over the Headline record and its
// Case. Derived on every read, stored nowhere -- see the file header for why a
// Headline never gains a lifecycle of its own.
export * from './headline-situation';

// --- Commercial Intelligence: completeness and source authority (contracts) ---
// The three questions provider observation does NOT answer, established as pure
// contracts before anything persists them. Nothing in the production Stage 3 path
// imports these yet -- see `measurement-readiness.ts`.
//
//   member-expectation      whether records from a campaign were EXPECTED to reach
//                           Loop on a date. Declared by a person, effective-dated,
//                           never inferred from traffic. Undeclared fails closed.
//   provider-reconciliation whether the identities the provider held actually
//                           arrived. The fact `ProviderObservationDay` cannot
//                           carry, because it persists a count and not a set.
//   measurement-source      which source is authoritative for THIS measure over
//                           THIS member on THIS date. A source holding a field is
//                           not a source that may be believed about it.
//   measurement-readiness   the three assembled into one verdict, in the shape
//                           `assessWindowObservation` already proved: resolved by
//                           an impure caller, judged by a pure function.
export * from './member-expectation';
export * from './provider-reconciliation';
export * from './measurement-source';
export * from './measurement-readiness';

// --- Identity evidence and resolution: Slice 2.0 pure contracts ---
// docs/architecture/identity-evidence-resolution.md. What identity evidence is and
// how strong (ordered tiers, never a confidence number; frequency never raises a
// tier; conflict overrides a match), which identity act needs which
// identityResolution action (update never establishes; AI never acts), and the
// per-class use policy that must be ACTIVE, human-activated and fully set before
// any evidence is produced. Nothing produces, stores or reads evidence yet.
export * from './identity-evidence';
export * from './identity-authority';
export * from './evidence-use-policy';

// --- Google Workspace connection (Private V1 OAuth contract) ---
// docs/architecture/google-workspace-connection.md §11. One connection per Loop user per
// organization; Gmail metadata, Calendar events read-only and Drive metadata, granted one
// capability at a time. Pure: the exact scopes, the granted-scope allowlist and the
// per-capability states.
export * from './google-workspace';
// Daily Loop work state (DL-1): the closed vocabularies, the retention policy and the
// sensitivity map for one employee's own work state. The rules that read them arrive in DL-8.
export * from './work-state';
// The calendar sensor contract (DL-2): Loop-owned event facts, provider-neutral by design, so
// a second calendar provider implements the same shape and Daily Loop does not change.
export * from './calendar-sensor';
// Your Day (DL-4): the pure projection of stored calendar facts into the day an employee is
// actually having, and how current that picture is. No formatting, no zone arithmetic, no model.
export * from './your-day';
// The Google connection's deployment configuration (names, validation, redirect URI). Pure, and
// shared because the Next.js server and the scheduled Calendar cycle must agree exactly on what
// "configured" means -- a laxer second reader is how a wrong token key reaches the sealer.
export * from './google-environment';
// The two rules every provider connection's configuration shares: a 32-byte sealing key read
// from text, and the redirect URI as canonical origin plus one static callback path.
export * from './sealing-key';
export * from './oauth-redirect';
// TikTok Login Kit connection (Creator Hub): the four scopes, the granted-scope allowlist, the
// connection states and outcomes, and the merge of the creator profile's TikTok entry. Pure.
export * from './tiktok';
// The Gmail sensor contract (GM-1): Loop-owned mailbox facts, provider-neutral by design. The
// sync read is metadata only and is the only Gmail read that is persisted; a thread read
// carries bodies, happens when an employee opens a conversation, and is never stored.
export * from './gmail-sensor';
// Composing a reply Gmail will thread correctly (GM-2): the three-part threading contract from
// Google's own Message reference, and header-injection refusals. Pure, so what gets sent is
// testable without sending mail.
export * from './gmail-compose';
// Deciding whether an unconfirmed send actually left (GM-2). Positive proof for SENT, proof of
// absence for NOT_SENT, and UNKNOWN for everything else -- never a guess, never a resend.
export * from './gmail-send-reconcile';
// How current a work source is, and whether a visit should spend a provider call (DL-4, GM-1).
// One policy shape; Calendar and Gmail differ only in their numbers.
export * from './work-freshness';
export * from './intelligence-item';
// Creator Hub (2026-09-22): the vocabulary both seats share and the pure state derivations.
export * from './creator-hub';
// Reading an email as text (GM-2). Loop renders mail as text and only as text: a body is
// attacker-controlled markup, and the words are what an employee needs.
export * from './mail-text';
// What a mailbox is waiting on (GM-3): deterministic states over stored headers. No body is read,
// no importance is scored, and significance never collapses into relevance.
export * from './mail-attention';
export * from './executive-review';
export * from './mail-intelligence';
export * from './source-connection';
export * from './conversation-event';
export * from './connection-worker-auth';
