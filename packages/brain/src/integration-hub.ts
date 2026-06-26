// @emgloop/brain — Integration Hub & API Standards.
//
// Sprint 12: promote Integrations into a permanent platform subsystem and define
// the standard EVERY provider must satisfy. Sprint 11's @emgloop/providers
// package already implements the Provider Registry, capabilities, webhook
// verification, retry and normalization for CallGrid; this file documents the
// FULL hub surface and the provider standard so every future provider plugs into
// the same pipeline with no provider-specific business logic outside its adapter.

import type { ProviderCategory } from '@emgloop/shared';

/** The subsystems that make up the Integration Hub. */
export const INTEGRATION_HUB_SUBSYSTEMS = [
  'provider_registry',
  'provider_capabilities',
  'webhook_manager',
  'credential_manager',
  'oauth_manager',
  'vault',          // future
  'health_monitor',
  'retry_queue',
  'rate_limiter',
  'normalization',
  'provider_diagnostics',
  'provider_health',
] as const;
export type IntegrationHubSubsystem = (typeof INTEGRATION_HUB_SUBSYSTEMS)[number];

/** Implementation status of a hub subsystem (so the roadmap is explicit). */
export type SubsystemStatus = 'implemented' | 'scaffolded' | 'planned';

/** Current status of each hub subsystem as of Sprint 12. */
export const HUB_SUBSYSTEM_STATUS: Record<IntegrationHubSubsystem, SubsystemStatus> = {
  provider_registry: 'implemented',     // @emgloop/providers registry (Sprint 11)
  provider_capabilities: 'implemented', // IngestionProvider.capabilities()
  webhook_manager: 'implemented',       // verifyWebhook + webhook route (Sprint 11)
  credential_manager: 'scaffolded',     // ProviderContext.credentials contract
  oauth_manager: 'planned',
  vault: 'planned',
  health_monitor: 'scaffolded',         // healthCheck() contract exists
  retry_queue: 'implemented',           // IntegrationEvent status + retry (Sprint 11)
  rate_limiter: 'planned',
  normalization: 'implemented',         // NormalizationEngine (Sprint 10/11)
  provider_diagnostics: 'scaffolded',
  provider_health: 'scaffolded',
};

/** Webhook delivery method support. */
export type DeliveryMode = 'webhook' | 'polling' | 'streaming';

/** Retry strategy descriptor a provider declares. */
export interface RetryStrategy {
  maxAttempts: number;
  backoff: 'none' | 'fixed' | 'exponential';
  baseDelaySeconds: number;
}

/**
 * The permanent API standard every provider adapter must declare. This is the
 * contract the Integration Hub uses to operate a provider uniformly. Business
 * logic lives only inside the adapter's normalization; everything else is config.
 */
export interface ProviderStandard {
  id: string;
  category: ProviderCategory;
  displayName: string;
  /** Authentication mechanism (e.g. 'hmac', 'oauth2', 'api_key', 'none'). */
  authentication: string;
  /** What the provider can do. */
  capabilities: {
    delivery: DeliveryMode[];
    webhookSupport: boolean;
    pollingSupport: boolean;
    eventTypes: string[];
  };
  /** Whether the adapter normalizes to NormalizedEvent (required = true). */
  normalizes: boolean;
  retryStrategy: RetryStrategy;
  /** Whether a health check is implemented. */
  healthCheck: boolean;
  /** Declared rate limits (requests per minute), if any. */
  rateLimitPerMinute?: number;
  /** Idempotency key field (e.g. 'externalId'). Required for at-least-once. */
  idempotencyKey: string;
  /** Permission scopes the provider requires. */
  permissions: string[];
  /** Whether provider actions are audited. */
  audited: boolean;
  /** Link/path to provider documentation. */
  documentation?: string;
}

/** Diagnostics snapshot the hub can surface for a connected provider. */
export interface ProviderDiagnostics {
  providerId: string;
  organizationId: string;
  healthy: boolean;
  lastEventAt?: Date;
  eventsProcessed: number;
  eventsFailed: number;
  inRetryQueue: number;
  checkedAt: Date;
}
