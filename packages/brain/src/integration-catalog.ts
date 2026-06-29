// @emgloop/brain — Integration Catalog (Sprint 16, Integration OS).
//
// The SINGLE declarative source of truth for every integration the
// Integration OS knows how to connect, monitor, diagnose and explain. The
// Integration Center UI is generated entirely from these specs: cards,
// wizards, setup steps, health rows, required-configuration checklists and
// diagnostics all read from here. Adding a future provider (Sprint 17+) is a
// matter of appending ONE spec object plus its adapter + config — the OS then
// renders its UI, setup instructions, monitoring and diagnostics automatically.
//
// This file contains NO secrets and makes NO network calls. Env var NAMES are
// referenced so the OS can report whether a secret is configured (boolean
// only) without ever reading or displaying a value.

import type { ProviderCategory } from '@emgloop/shared';

/** How a provider authenticates. Drives the wizard + secret checklist. */
export type AuthMethod = 'hmac_signature' | 'api_key' | 'oauth2' | 'account_token' | 'none';

/** Which way data flows relative to EMG Loop. */
export type IntegrationDirection = 'inbound' | 'outbound' | 'bidirectional';

/** How EMG Loop receives data from the provider. */
export type DeliveryMode = 'webhook' | 'sdk' | 'polling' | 'oauth_pull' | 'streaming';

/** Build/readiness status of the RECEIVING side inside EMG Loop. */
export type ProviderReadiness = 'production_ready' | 'partial' | 'scaffold' | 'planned';

/** A single guided setup step shown in the Connection Wizard. */
export interface SetupStep {
  title: string;
  detail: string;
  /** Optional value the OS should generate/echo for this step (e.g. webhook URL). */
  generates?: 'webhook_url' | 'required_events' | 'signing_secret_ref' | 'install_script' | 'api_key' | 'property_id' | 'verification';
}

/** A reference to a server environment variable. Names only — never values. */
export interface SecretRef {
  /** The environment variable name, e.g. 'CALLGRID_WEBHOOK_SECRET'. */
  envVar: string;
  label: string;
  /** Whether the integration cannot function until this is set. */
  required: boolean;
}

/** The full declarative spec for one provider. */
export interface ProviderSpec {
  /** Stable provider id — matches ProviderConnection.provider + KNOWN_PROVIDERS. */
  id: string;
  displayName: string;
  category: ProviderCategory;
  /** One-line description shown on the connection card. */
  blurb: string;
  readiness: ProviderReadiness;
  direction: IntegrationDirection;
  delivery: DeliveryMode[];
  authentication: AuthMethod;
  /** Webhook path on app.emgloop.com, if this provider delivers via webhook. */
  webhookPath?: string;
  /** Canonical event types the OS recommends enabling at the provider. */
  recommendedEvents?: string[];
  /** HTTP headers the provider sends that the receiver looks for. */
  signatureHeaders?: string[];
  /** Env vars this provider needs (status-only checklist). */
  secrets: SecretRef[];
  /** Whether the receiver supports backfill/polling today. */
  pollingSupported: boolean;
  /** Whether idempotency is enforced (provider + externalId). */
  idempotency: boolean;
  /** Whether failed deliveries are retryable from the IntegrationEvent queue. */
  retrySupported: boolean;
  /** Guided setup steps for the Connection Wizard. */
  setupSteps: SetupStep[];
  /** For website-style providers: the EMG properties an SDK installs onto. */
  manages?: 'website_properties';
  /** Docs anchor / human note surfaced in the OS (no external links required). */
  notes?: string;
}

const APP_URL = 'https://app.emgloop.com';

export const INTEGRATION_CATALOG: ProviderSpec[] = [
  // ---- CallGrid — first live ingestion adapter (Sprint 11) ----------------
  {
    id: 'callgrid',
    displayName: 'CallGrid',
    category: 'ingestion',
    blurb: 'Call-tracking webhooks — inbound, answered, missed and completed calls.',
    readiness: 'production_ready',
    direction: 'inbound',
    delivery: ['webhook'],
    authentication: 'hmac_signature',
    webhookPath: '/api/webhooks/callgrid',
    recommendedEvents: ['call.inbound', 'call.answered', 'call.missed', 'call.completed', 'call.voicemail', 'call.transferred'],
    signatureHeaders: ['x-callgrid-signature'],
    secrets: [{ envVar: 'CALLGRID_WEBHOOK_SECRET', label: 'Webhook signing secret', required: true }],
    pollingSupported: false,
    idempotency: true,
    retrySupported: true,
    setupSteps: [
      { title: 'Log in to CallGrid', detail: 'Open your CallGrid account and go to the Webhooks settings.' },
      { title: 'Add the EMG Loop webhook URL', detail: 'Paste the generated production webhook URL.', generates: 'webhook_url' },
      { title: 'Enable the required events', detail: 'Turn on each recommended call event.', generates: 'required_events' },
      { title: 'Set the signing secret', detail: 'Configure CALLGRID_WEBHOOK_SECRET in the server environment so signatures verify.', generates: 'signing_secret_ref' },
      { title: 'Save and verify', detail: 'Save in CallGrid, then run a test — the OS detects the first live event.', generates: 'verification' },
    ],
    notes: 'Receiver is complete. Until CALLGRID_WEBHOOK_SECRET is set the route runs in allow-unsigned mode; configure it before going live.',
  },
  // ---- EMG Websites — second live ingestion adapter (Sprint 14) -----------
  {
    id: 'website',
    displayName: 'EMG Websites',
    category: 'ingestion',
    blurb: 'First-party website intelligence from every EMG property via the Loop SDK.',
    readiness: 'partial',
    direction: 'inbound',
    delivery: ['webhook', 'sdk'],
    authentication: 'hmac_signature',
    webhookPath: '/api/webhooks/website',
    recommendedEvents: ['web.session_start', 'web.page_view', 'web.search', 'web.cta_click', 'web.phone_click', 'web.form_submit'],
    signatureHeaders: ['x-emg-signature'],
    secrets: [{ envVar: 'WEBSITE_WEBHOOK_SECRET', label: 'Website signing secret', required: true }],
    pollingSupported: false,
    idempotency: true,
    retrySupported: true,
    manages: 'website_properties',
    setupSteps: [
      { title: 'Choose the property', detail: 'Select the EMG property to instrument.', generates: 'property_id' },
      { title: 'Generate the install script', detail: 'Copy the generated <script> tag into the site head.', generates: 'install_script' },
      { title: 'Generate an ingest key', detail: 'Create a per-property key (status tracked, value never shown).', generates: 'api_key' },
      { title: 'Deploy and verify', detail: 'Publish the site, then verify the OS receives the first event.', generates: 'verification' },
    ],
    notes: 'Receiver and SDK management layer exist. The browser JavaScript SDK itself is not built yet — sites cannot emit events until it ships.',
  },
  // ---- Google Analytics 4 — planned (oauth pull) -------------------------
  {
    id: 'ga4',
    displayName: 'Google Analytics 4',
    category: 'analytics',
    blurb: 'Site analytics — sessions, conversions and acquisition channels.',
    readiness: 'planned',
    direction: 'inbound',
    delivery: ['oauth_pull', 'polling'],
    authentication: 'oauth2',
    recommendedEvents: ['web.session_start', 'web.goal_conversion'],
    secrets: [
      { envVar: 'GOOGLE_CLIENT_ID', label: 'Google OAuth client id', required: true },
      { envVar: 'GOOGLE_CLIENT_SECRET', label: 'Google OAuth client secret', required: true },
    ],
    pollingSupported: false,
    idempotency: true,
    retrySupported: true,
    setupSteps: [
      { title: 'Connect Google', detail: 'Authorize EMG Loop with read-only Analytics scope (OAuth — Sprint 17+).' },
      { title: 'Select the GA4 property', detail: 'Choose which Analytics property to sync.', generates: 'property_id' },
      { title: 'Schedule sync', detail: 'Enable scheduled pulls of sessions and conversions.' },
    ],
    notes: 'Pull-based. Requires an analytics adapter, OAuth manager and a scheduler — none built yet.',
  },
  // ---- Google Ads — planned ----------------------------------------------
  {
    id: 'google_ads',
    displayName: 'Google Ads',
    category: 'analytics',
    blurb: 'Ad spend, clicks and conversions for paid-search attribution.',
    readiness: 'planned',
    direction: 'inbound',
    delivery: ['oauth_pull', 'polling'],
    authentication: 'oauth2',
    recommendedEvents: ['ads.click', 'ads.conversion', 'ads.lead_form_submit'],
    secrets: [
      { envVar: 'GOOGLE_CLIENT_ID', label: 'Google OAuth client id', required: true },
      { envVar: 'GOOGLE_CLIENT_SECRET', label: 'Google OAuth client secret', required: true },
      { envVar: 'GOOGLE_ADS_DEVELOPER_TOKEN', label: 'Google Ads developer token', required: true },
    ],
    pollingSupported: false,
    idempotency: true,
    retrySupported: true,
    setupSteps: [
      { title: 'Connect Google Ads', detail: 'Authorize EMG Loop with read-only Ads scope (OAuth — Sprint 17+).' },
      { title: 'Select the account', detail: 'Choose the Ads account/customer id to sync.', generates: 'property_id' },
    ],
    notes: 'Pull-based. Adapter + OAuth + scheduler required.',
  },
  // ---- Google Search Console — planned -----------------------------------
  {
    id: 'google_search_console',
    displayName: 'Google Search Console',
    category: 'analytics',
    blurb: 'Organic search impressions, clicks and position data.',
    readiness: 'planned',
    direction: 'inbound',
    delivery: ['oauth_pull', 'polling'],
    authentication: 'oauth2',
    recommendedEvents: ['search.impression', 'search.click', 'search.position_change'],
    secrets: [
      { envVar: 'GOOGLE_CLIENT_ID', label: 'Google OAuth client id', required: true },
      { envVar: 'GOOGLE_CLIENT_SECRET', label: 'Google OAuth client secret', required: true },
    ],
    pollingSupported: false,
    idempotency: true,
    retrySupported: true,
    setupSteps: [
      { title: 'Connect Search Console', detail: 'Authorize EMG Loop with read-only Search Console scope (OAuth — Sprint 17+).' },
      { title: 'Select the property', detail: 'Choose the verified site property to sync.', generates: 'property_id' },
    ],
    notes: 'Pull-based. Adapter + OAuth + scheduler required.',
  },
  // ---- Microsoft Ads — planned -------------------------------------------
  {
    id: 'microsoft_clarity',
    displayName: 'Microsoft Ads',
    category: 'analytics',
    blurb: 'Microsoft advertising clicks and conversions.',
    readiness: 'planned',
    direction: 'inbound',
    delivery: ['oauth_pull', 'polling'],
    authentication: 'oauth2',
    recommendedEvents: ['ads.click', 'ads.conversion'],
    secrets: [
      { envVar: 'MICROSOFT_ADS_CLIENT_ID', label: 'Microsoft Ads client id', required: true },
      { envVar: 'MICROSOFT_ADS_CLIENT_SECRET', label: 'Microsoft Ads client secret', required: true },
      { envVar: 'MICROSOFT_ADS_DEVELOPER_TOKEN', label: 'Microsoft Ads developer token', required: true },
    ],
    pollingSupported: false,
    idempotency: true,
    retrySupported: true,
    setupSteps: [
      { title: 'Connect Microsoft Ads', detail: 'Authorize EMG Loop (OAuth — Sprint 17+).' },
      { title: 'Select the account', detail: 'Choose the Ads account to sync.', generates: 'property_id' },
    ],
    notes: 'Pull-based. Adapter + OAuth + scheduler required.',
  },
  // ---- Meta — planned ----------------------------------------------------
  {
    id: 'meta',
    displayName: 'Meta',
    category: 'analytics',
    blurb: 'Facebook & Instagram ad performance and lead forms.',
    readiness: 'planned',
    direction: 'inbound',
    delivery: ['oauth_pull', 'webhook'],
    authentication: 'oauth2',
    recommendedEvents: ['ads.click', 'ads.conversion', 'ads.lead_form_submit'],
    secrets: [
      { envVar: 'META_APP_ID', label: 'Meta app id', required: true },
      { envVar: 'META_APP_SECRET', label: 'Meta app secret', required: true },
    ],
    pollingSupported: false,
    idempotency: true,
    retrySupported: true,
    setupSteps: [
      { title: 'Connect Meta', detail: 'Authorize the EMG Loop Meta app (OAuth — Sprint 17+).' },
      { title: 'Select ad accounts & pages', detail: 'Choose which assets to sync.', generates: 'property_id' },
    ],
    notes: 'Pull + webhook hybrid. Adapter + OAuth required.',
  },
  // ---- Twilio — planned (messaging/voice) --------------------------------
  {
    id: 'twilio',
    displayName: 'Twilio',
    category: 'sms',
    blurb: 'SMS and voice — inbound/outbound messaging webhooks.',
    readiness: 'planned',
    direction: 'bidirectional',
    delivery: ['webhook'],
    authentication: 'account_token',
    recommendedEvents: ['sms.inbound', 'sms.outbound'],
    signatureHeaders: ['x-twilio-signature'],
    secrets: [
      { envVar: 'TWILIO_ACCOUNT_SID', label: 'Twilio account SID', required: true },
      { envVar: 'TWILIO_AUTH_TOKEN', label: 'Twilio auth token', required: true },
    ],
    pollingSupported: false,
    idempotency: true,
    retrySupported: true,
    setupSteps: [
      { title: 'Add the messaging webhook', detail: 'Point your Twilio number at the EMG Loop messaging webhook (built Sprint 17+).', generates: 'webhook_url' },
      { title: 'Set credentials', detail: 'Configure TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in the server environment.', generates: 'signing_secret_ref' },
    ],
    notes: 'Mirrors the CallGrid webhook shape; adapter not built yet.',
  },
  // ---- OpenAI — planned (outbound AI) ------------------------------------
  {
    id: 'openai',
    displayName: 'OpenAI',
    category: 'ai',
    blurb: 'Outbound AI for generation and enrichment (optional, off by default).',
    readiness: 'planned',
    direction: 'outbound',
    delivery: ['oauth_pull'],
    authentication: 'api_key',
    secrets: [{ envVar: 'OPENAI_API_KEY', label: 'OpenAI API key', required: true }],
    pollingSupported: false,
    idempotency: false,
    retrySupported: false,
    setupSteps: [
      { title: 'Add API key', detail: 'Set OPENAI_API_KEY in the server environment (value never displayed).', generates: 'signing_secret_ref' },
      { title: 'Enable features', detail: 'Turn on the AI features that should use OpenAI.' },
    ],
    notes: 'Outbound provider. EMG Loop attribution stays deterministic; AI is assistive only.',
  },
  // ---- Anthropic — planned (outbound AI) ---------------------------------
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    category: 'ai',
    blurb: 'Outbound AI for generation and enrichment (optional, off by default).',
    readiness: 'planned',
    direction: 'outbound',
    delivery: ['oauth_pull'],
    authentication: 'api_key',
    secrets: [{ envVar: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', required: true }],
    pollingSupported: false,
    idempotency: false,
    retrySupported: false,
    setupSteps: [
      { title: 'Add API key', detail: 'Set ANTHROPIC_API_KEY in the server environment (value never displayed).', generates: 'signing_secret_ref' },
      { title: 'Enable features', detail: 'Turn on the AI features that should use Anthropic.' },
    ],
    notes: 'Outbound provider. EMG Loop attribution stays deterministic; AI is assistive only.',
  },
  // ---- ElevenLabs — planned (outbound voice) -----------------------------
  {
    id: 'elevenlabs',
    displayName: 'ElevenLabs',
    category: 'voice',
    blurb: 'Outbound voice synthesis for AI employees (optional).',
    readiness: 'planned',
    direction: 'outbound',
    delivery: ['oauth_pull'],
    authentication: 'api_key',
    secrets: [{ envVar: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API key', required: true }],
    pollingSupported: false,
    idempotency: false,
    retrySupported: false,
    setupSteps: [
      { title: 'Add API key', detail: 'Set ELEVENLABS_API_KEY in the server environment (value never displayed).', generates: 'signing_secret_ref' },
      { title: 'Pick a voice', detail: 'Choose the default voice for AI employees.' },
    ],
    notes: 'Outbound provider. Adapter not built yet.',
  },
];

// ---- EMG website properties (managed by the Website SDK manager) ---------
// The OS lists these first-class properties; the SDK manager generates an
// install script + per-property ingest key for each. Adding a property here
// makes it appear in the Website Manager automatically.
export interface EmgProperty {
  key: string;
  name: string;
  domain: string;
}

export const EMG_WEBSITE_PROPERTIES: EmgProperty[] = [
  { key: 'servicesinmycity', name: 'ServicesInMyCity', domain: 'servicesinmycity.com' },
  { key: 'consumersupporthelp', name: 'ConsumerSupportHelp', domain: 'consumersupporthelp.com' },
  { key: 'marriageinmycity', name: 'MarriageInMyCity', domain: 'marriageinmycity.com' },
  { key: 'careinmycity', name: 'CareInMyCity', domain: 'careinmycity.com' },
  { key: 'petsinmycity', name: 'PetsInMyCity', domain: 'petsinmycity.com' },
  { key: 'gamedayinmycity', name: 'GameDayInMyCity', domain: 'gamedayinmycity.com' },
  { key: 'homesinmycity', name: 'HomesInMyCity', domain: 'homesinmycity.com' },
];

// ---- Catalog accessors --------------------------------------------------

/** All provider specs. */
export function listProviders(): ProviderSpec[] {
  return INTEGRATION_CATALOG;
}

/** Look up a single provider spec by id. */
export function getProviderSpec(id: string): ProviderSpec | undefined {
  return INTEGRATION_CATALOG.find((p) => p.id === id);
}

/** Distinct env var names referenced across all providers (for Secret Status). */
export function allSecretRefs(): SecretRef[] {
  const seen = new Map<string, SecretRef>();
  for (const provider of INTEGRATION_CATALOG) {
    for (const s of provider.secrets) {
      if (!seen.has(s.envVar)) seen.set(s.envVar, s);
    }
  }
  return [...seen.values()];
}

/** Build the absolute production webhook URL for a provider, if it has one. */
export function webhookUrlFor(spec: ProviderSpec): string | null {
  return spec.webhookPath ? APP_URL + spec.webhookPath : null;
}

/** Generate the EMG Loop SDK install snippet for a property (management layer
    only — the referenced emg-loop.js is not built yet). */
export function sdkInstallScript(property: EmgProperty, organizationSlug: string): string {
  return [
    '<script',
    '  src="' + APP_URL + '/sdk/emg-loop.js"',
    '  data-property="' + property.key + '"',
    '  data-organization="' + organizationSlug + '"',
    '  async>',
    '</script>',
  ].join('\n');
}

/** A stable, non-secret public property identifier for the SDK data attribute. */
export function propertyIdentifier(property: EmgProperty): string {
  return 'emg_' + property.key;
}
