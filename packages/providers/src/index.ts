
// @emgloop/providers — Sprint 1 + Sprint 3 + Sprint 10 + Sprint 11 + Sprint 14.
//
// Provider abstraction package barrel. Sprint 11 added the first real ingestion
// adapter (CallGrid). Sprint 14 adds the second (WebsiteProvider). Concrete
// adapters do not auto-register at import time; the host wires them into the
// registry on first use via the helpers below, so consumers resolve providers
// through the registry rather than constructing adapters directly.

export * from './types';
export * from './registry';
export {
  verifySignedWebhook,
  computeSignature,
  parseTimestamp,
  verifyCallGridAuth,
  timingSafeTokenEqual,
} from './webhook-security';
export type {
  WebhookSecurityResult,
  WebhookSecurityOptions,
  CallGridAuthOptions,
  AuthMethod,
} from './webhook-security';
export {
  verifyPropertyIngest,
  normalizeHost,
  hostMatchesDomains,
} from './property-ingest';
export type {
  PropertyIngestIdentity,
  PropertyIngestInput,
  PropertyIngestResult,
} from './property-ingest';
export type {
  IngestionProvider,
  IngestionCapabilities,
  InboundEvent,
  PollOptions,
  PollResult,
  WebhookVerificationResult,
} from './interfaces/ingestion.provider';
export type {
  AnalyticsProvider,
  AnalyticsCapabilities,
  AnalyticsQuery,
  AnalyticsResult,
  AnalyticsRow,
  AnalyticsMetric,
  AnalyticsDimension,
} from './interfaces/analytics.provider';
export { MockIngestionProvider } from './mocks/ingestion.mock';
export { MockAnalyticsProvider } from './mocks/analytics.mock';

// Sprint 11 — First Live Integration (CallGrid).
import { CallGridProvider } from './adapters/callgrid.provider';
// Sprint 14 — Website Intelligence (WebsiteProvider).
import { WebsiteProvider } from './adapters/website.provider';
import { registerProvider, getProvider, hasProvider } from './registry';
import type { IngestionProvider } from './interfaces/ingestion.provider';

export { CallGridProvider, mapCallgridEventType, CALLGRID_EVENT_MAP } from './adapters/callgrid.provider';
// Sprint 17 - CallGrid REST API reconciliation/backfill client.
export {
  fetchCallGridCallsPage,
  extractRecordsOrNull,
  describeShape,
  mapCallGridApiRecord,
  resolveCallGridBaseUrl,
  parseDurationSeconds,
  pickField,
  toNumber,
  toBool,
  CallGridApiError,
  CALLGRID_API_DEFAULT_BASE_URL,
  CALLGRID_CALLS_PATH,
} from './adapters/callgrid-api';
export type { CallGridApiFetchOptions, CallGridApiPage } from './adapters/callgrid-api';
export {
  INTERVAL_DEFAULT_MAX_PAGES,
  INTERVAL_MAX_SPAN_DAYS,
  INTERVAL_PAGE_SIZE,
  INTERVAL_READ_OUTCOMES,
  RATE_LIMIT_BASE_DELAY_MS,
  RATE_LIMIT_MAX_RETRIES,
  intervalWasComplete,
  readCallGridInterval,
  retryAfterMs,
  validateInterval,
} from './adapters/callgrid-interval';
export type {
  IntervalReadOutcome,
  IntervalReadRequest,
  IntervalReadResult,
  RefusedRecord,
} from './adapters/callgrid-interval';
export {
  WebsiteProvider,
  mapWebsiteEventType,
  WEBSITE_EVENT_MAP,
  WEBSITE_PROPERTIES,
} from './adapters/website.provider';
export type { WebsiteProperty } from './adapters/website.provider';

/**
 * Register the CallGrid adapter into the provider registry (idempotent). Call
 * this during host bootstrap so the adapter is resolvable via getProvider().
 */
export function registerCallGrid(): void {
  if (!hasProvider('ingestion', 'callgrid')) {
    registerProvider(new CallGridProvider());
  }
}

/**
 * Resolve the CallGrid adapter through the provider registry, registering it on
 * first use. Consumers (e.g. the webhook route) should use this instead of
 * constructing CallGridProvider directly, so all provider resolution flows
 * through the registry / Provider Layer.
 */
export function getCallGridProvider(): IngestionProvider {
  registerCallGrid();
  return getProvider<IngestionProvider>('ingestion', 'callgrid');
}

/**
 * Register the Website adapter into the provider registry (idempotent). Sprint
 * 14 — gives the Brain its second sense (websites) through the same registry.
 */
export function registerWebsite(): void {
  if (!hasProvider('ingestion', 'website')) {
    registerProvider(new WebsiteProvider());
  }
}

/**
 * Resolve the Website adapter through the provider registry, registering it on
 * first use. The website webhook route uses this instead of constructing
 * WebsiteProvider directly, so all resolution flows through the Provider Layer.
 */
export function getWebsiteProvider(): IngestionProvider {
  registerWebsite();
  return getProvider<IngestionProvider>('ingestion', 'website');
}

export type {
  Sensor,
  ObserveWindow,
  ObserveResult,
} from './interfaces/sensor.provider';

export type { Fact, FactBatch, SensorId } from './facts';


// PR #41 - CallGrid webhook parser verification harness (pure, framework-free).
export {
    runCallGridWebhookVerification,
    CANONICAL_WEBHOOK_BODY,
    MINIMAL_UNKNOWN_BODY,
    LEGACY_TEST_BODY,
} from './callgrid-webhook-verification';
export type {
    CheckResult as CallGridWebhookCheckResult,
    ScenarioResult as CallGridWebhookScenarioResult,
    VerificationReport as CallGridWebhookVerificationReport,
} from './callgrid-webhook-verification';

// Sprint (PR-1) — Transactional email (Resend).
// Expose the shared EmailProvider interface types, the Resend adapter, and the
// existing mock so hosts can send transactional email through the abstraction.
export type {
  EmailProvider,
  EmailAddress,
  EmailAttachment,
  SendEmailRequest,
  SendEmailResult,
} from './interfaces/email.provider';
export { ResendEmailProvider } from './adapters/resend-email.provider';
export { MockEmailProvider } from './mocks/mock-email.provider';

// CallGrid canonical occurrence-timestamp resolver.
export { resolveCallOccurrence, NON_OCCURRENCE_TIMESTAMP_FIELDS } from './adapters/callgrid-occurrence';
export {
  CALLGRID_IDENTITY_FIELDS,
  NO_IDENTITY_MESSAGE,
  resolveCallGridIdentity,
} from './adapters/callgrid-identity';
export type { ResolvedOccurrence } from './adapters/callgrid-occurrence';

// CallGrid aggregate report contract + Phase 1 live verification probe.
export {
  CALLGRID_REPORT_CONTRACTS,
  FIELDS_ABSENT_FROM_CONTRACT,
  EXCLUDED_FIELDS,
  probeReportContract,
  extractRows,
  measureNumerics,
  observedNullable,
  redact,
} from './adapters/callgrid-reports';
export type {
  ReportEndpointContract,
  ReportProbeInput,
  ReportProbeResult,
  NumericRepresentation,
  EvidenceGrade,
} from './adapters/callgrid-reports';

// CallGrid aggregate report client — the three endpoints VERIFIED live on
// 2026-07-18. `callStats` (POST /api/reports/stats) returned HTTP 400 and has
// deliberately no client here.
export {
  VERIFIED_REPORT_PATHS,
  REPORT_GRAIN,
  CallGridReportError,
  metric,
  parseBidStatsRow,
  parseBidRejectionsRow,
  parsePingStatsRow,
  distinctProviderOrgIds,
  hashPayload,
  fetchReportPage,
  fetchWholeReport,
  scrub,
  CALL_STATS_CONTRACT,
  callStatsRequestBody,
} from './adapters/callgrid-report-client';
export type {
  VerifiedReportEndpoint,
  BidStatsRow,
  BidRejectionsRow,
  PingStatsRow,
  ReportRow,
  FooterTotals,
  ReportPage,
  ReportFetchInput,
  PaginateInput,
  PaginatedReport,
} from './adapters/callgrid-report-client';

// --- Loop AI provider boundary (slice AI S0) ---
// The ONLY place in Loop that may import a model SDK. Nothing here calls anything
// yet: S0 defines the interface and a recorded-fixture provider, and a repository
// fence asserts no SDK appears outside ./ai/adapters/. See ./ai/model-provider.ts
// and docs/architecture/loop-ai-runtime.md.
export { RecordedModelProvider, ModelProviderError, unconfirmedCapabilities } from './ai/model-provider';
export type { ModelProvider, RecordedInvocation } from './ai/model-provider';
// The two real adapters (slice B5). NOT ACTIVATED: each takes an injected client, so
// nothing here reads a credential or builds one, and no call can happen until S1
// supplies one under the activation gates. These files, and only these, may import a
// model SDK -- a repository-wide fence asserts it.
export { AnthropicAdapter, ANTHROPIC_PROVIDER_ID } from './ai/adapters/anthropic.adapter';
export type { AnthropicAdapterDeps, AnthropicMessagesClient } from './ai/adapters/anthropic.adapter';
export { OpenAiAdapter, OPENAI_PROVIDER_ID } from './ai/adapters/openai.adapter';
export type { OpenAiAdapterDeps, OpenAiResponsesClient } from './ai/adapters/openai.adapter';
export { classifyProviderError, providerFailureMessage, retryAfterMs as providerRetryAfterMs } from './ai/adapters/failure-mapping';
// How supplied evidence is written into a model request: one rendering for every
// provider, with element boundaries source content cannot forge.
export { renderAiSources, escapeAiSourceText, AI_SOURCES_OPEN, AI_SOURCES_CLOSE } from './ai/source-rendering';
// The verified model catalog and the reviewed routing and budget policies. The only
// place a model id is written; changing one is a reviewed pull request.
export { AI_MODEL_CATALOG, ANTHROPIC_PRICE_LIST, OPENAI_PRICE_LIST, aiCatalogModel, aiCatalogCapabilities } from './ai/policy/model-catalog';
export type { AiCatalogModel } from './ai/policy/model-catalog';
export {
  AI_ROUTING_POLICY,
  AI_ROUTING_POLICY_VERSION,
  AI_BUDGET_POLICY,
  AI_BUDGET_POLICY_VERSION,
  AI_MAX_ATTEMPTS_PER_TARGET,
  AI_PLATFORM_REQUEST_LIMIT_MS,
} from './ai/policy/routing-policy';
// Provider specialization by capability route (B2): which provider each route prefers,
// as versioned data the routing policy must conform to.
export { AI_PROVIDER_SPECIALIZATION_POLICY, AI_PROVIDER_SPECIALIZATION_POLICY_VERSION } from './ai/policy/provider-specialization';
// Google Workspace connection: the OAuth 2.0 web-server flow, and ID-token verification
// (signature against Google's published keys first, then claims).
// Protocol only -- no environment, no key, no storage; the network is injected.
export {
  GOOGLE_OAUTH_ENDPOINTS,
  GOOGLE_OAUTH_TIMEOUT_MS,
  googleAuthorizationUrl,
  exchangeGoogleAuthorizationCode,
  refreshGoogleAccessToken,
  revokeGoogleToken,
} from './google-workspace/oauth';
export type {
  GoogleAuthorizationRequest,
  GoogleOAuthFailure,
  GoogleTokenGrant,
  GoogleTokenResult,
  GoogleClientCredentials,
  GoogleRevokeResult,
} from './google-workspace/oauth';
// The Calendar sensor (DL-2): bounded reads of the primary calendar, normalized into the
// provider-neutral facts in @emgloop/shared. Observes and emits; decides nothing.
export {
  GOOGLE_CALENDAR_EVENTS_ENDPOINT,
  GOOGLE_CALENDAR_PAGE_SIZE,
  GOOGLE_CALENDAR_MAX_PAGE_SIZE,
  GOOGLE_CALENDAR_MAX_PAGES,
  googleCalendarAddressHash,
  googleAddressHash,
  normalizeGoogleCalendarEvent,
  readGoogleCalendarWindow,
  readGoogleCalendarChanges,
} from './google-workspace/calendar';
export type {
  CalendarIdentityContext,
  CalendarWindowRequest,
  CalendarChangesRequest,
} from './google-workspace/calendar';
export {
  GOOGLE_JWKS_URI,
  GOOGLE_ID_TOKEN_ALGORITHM,
  GOOGLE_ID_TOKEN_ISSUERS,
  GOOGLE_ID_TOKEN_SKEW_SECONDS,
  GOOGLE_SIGNING_KEYS_MAX_AGE_SECONDS,
  GOOGLE_SIGNING_KEYS_REFRESH_INTERVAL_MS,
  GoogleSigningKeys,
  googleSigningKeysLifetimeSeconds,
  verifyGoogleIdToken,
} from './google-workspace/id-token';
export type {
  GoogleSigningKeysFetch,
  GoogleSigningKeysOptions,
  GoogleSigningKeyLookup,
  GoogleIdentity,
  GoogleIdTokenRefusal,
  GoogleIdTokenResult,
  GoogleIdTokenExpectations,
} from './google-workspace/id-token';

// The Gmail sensor (GM-1): bounded reads of one employee's own mailbox, normalized into the
// provider-neutral facts in @emgloop/shared. The sync read asks for metadata only; a thread
// read carries bodies and is never persisted.
export {
  GOOGLE_GMAIL_ENDPOINT,
  GOOGLE_GMAIL_PAGE_SIZE,
  GOOGLE_GMAIL_MAX_PAGE_SIZE,
  GOOGLE_GMAIL_MAX_PAGES,
  GOOGLE_GMAIL_MAX_MESSAGES_PER_PASS,
  GOOGLE_GMAIL_INITIAL_DAYS,
  GOOGLE_GMAIL_METADATA_HEADERS,
  GOOGLE_GMAIL_MAX_MIME_DEPTH,
  GOOGLE_GMAIL_MAX_BODY_CHARS,
  gmailMessageFact,
  gmailMessageBody,
  readGoogleGmailWindow,
  readGoogleGmailChanges,
  readGoogleGmailThread,
  sendGoogleGmailMessage,
  lookupGoogleGmailSent,
  GOOGLE_GMAIL_RECONCILE_RECENT,
  GOOGLE_GMAIL_RECONCILE_MAX_PAGES,
} from './google-workspace/gmail';
export type { GmailCallOptions, GmailWindowRequest, GmailChangesRequest } from './google-workspace/gmail';
