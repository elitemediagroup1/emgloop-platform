import 'server-only';

// Integration OS bridge  -  Sprint 16 (The Connection Layer).
//
// Server-only glue between the static provider catalog (@emgloop/database) and the
// live status engine (@emgloop/database). The Integration Center pages call
// these helpers and render the result  -  no provider-specific code lives in the
// pages, so a future provider appears automatically once it is in the catalog.

import {
  listProviders,
  getProviderSpec,
  allSecretRefs,
  webhookUrlFor,
  EMG_WEBSITE_PROPERTIES,
  type ProviderSpec,
} from '@emgloop/database';
import {
  IntegrationOsService,
  type ProviderStatus,
  type ProviderStatusInput,
} from '@emgloop/database';
import { prisma } from '@emgloop/database';

export type ProviderCard = { spec: ProviderSpec; status: ProviderStatus };

export interface SystemHealth {
  overallPercent: number;
  connected: number;
  needsSetup: number;
  errors: number;
  warnings: number;
  missingItems: string[];
}

function specToInput(spec: ProviderSpec): ProviderStatusInput {
  return {
    providerId: spec.id,
    hasWebhook: Boolean(spec.webhookPath),
    planned: spec.readiness === 'planned',
    secrets: spec.secrets.map((s) => ({ envVar: s.envVar, label: s.label, required: s.required })),
  };
}

/** Build the full set of provider cards (spec + live status) for an org. */
export async function loadProviderCards(organizationId: string): Promise<ProviderCard[]> {
  const svc = new IntegrationOsService(prisma);
  const specs = listProviders();
  const statuses = await svc.statusForAll(organizationId, specs.map(specToInput));
  const byId = new Map(statuses.map((s) => [s.providerId, s]));
  return specs.map((spec) => ({ spec, status: byId.get(spec.id)! }));
}

/** Load a single provider card by id. */
export async function loadProviderCard(
  organizationId: string,
  providerId: string,
): Promise<ProviderCard | null> {
  const spec = getProviderSpec(providerId);
  if (!spec) return null;
  const svc = new IntegrationOsService(prisma);
  const status = await svc.statusFor(organizationId, specToInput(spec));
  return { spec, status };
}

/** Compute the system-wide integration health rollup for the page header. */
export function computeSystemHealth(cards: ProviderCard[]): SystemHealth {
  let connected = 0;
  let needsSetup = 0;
  let errors = 0;
  let warnings = 0;
  const missingItems: string[] = [];

  for (const { spec, status } of cards) {
    if (status.connection === 'connected') {
      connected += 1;
    } else if (status.connection === 'error') {
      errors += 1;
      missingItems.push(spec.displayName + ' connection error');
    } else {
      needsSetup += 1;
    }
    if (status.missingRequiredSecrets.length > 0) {
      warnings += 1;
      missingItems.push(spec.displayName + ' missing ' + status.missingRequiredSecrets.join(', '));
    } else if (status.connection === 'waiting' && spec.readiness === 'production_ready') {
      warnings += 1;
      missingItems.push(spec.displayName + ' not verified  -  awaiting first event');
    }
    if (spec.readiness === 'planned' && status.connection !== 'connected') {
      missingItems.push(spec.displayName + ' not connected');
    }
  }

  // Overall percent: weight connected providers, penalise errors. A provider
  // that is intentionally planned counts toward the denominator only lightly so
  // the score reflects readiness of what is meant to be live today.
  const total = cards.length || 1;
  const liveTargets = cards.filter((c) => c.spec.readiness === 'production_ready').length || 1;
  const liveConnected = cards.filter(
    (c) => c.spec.readiness === 'production_ready' && c.status.connection === 'connected',
  ).length;
  const base = Math.round((liveConnected / liveTargets) * 70);
  const breadth = Math.round((connected / total) * 30);
  const penalty = errors * 10;
  const overallPercent = Math.max(0, Math.min(100, base + breadth - penalty));

  return { overallPercent, connected, needsSetup, errors, warnings, missingItems };
}

// ---- Display helpers (CSS class + label mapping) ------------------------

export function connectionLabel(c: ProviderStatus['connection']): string {
  switch (c) {
    case 'connected': return 'Connected';
    case 'waiting': return 'Waiting';
    case 'error': return 'Error';
    default: return 'Needs Setup';
  }
}

export function healthLabel(h: ProviderStatus['health']): string {
  switch (h) {
    case 'healthy': return 'Healthy';
    case 'degraded': return 'Degraded';
    case 'down': return 'Down';
    default: return 'Unknown';
  }
}

/** Map a connection state to an existing crm status CSS modifier. */
export function connectionClass(c: ProviderStatus['connection']): string {
  switch (c) {
    case 'connected': return 'CONNECTED';
    case 'waiting': return 'PENDING';
    case 'error': return 'ERROR';
    default: return 'NOT_CONNECTED';
  }
}

export function fmtTime(ts: string | null): string {
  if (!ts) return ' - ';
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

export function relativeTime(ts: string | null): string {
  if (!ts) return 'Never';
  const diff = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(diff)) return 'Never';
  const s = Math.round(diff / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

/** Honest go-live label for the Integration OS. 'Live' ONLY after real events. */
export function liveStateLabel(s: ProviderStatus['liveState']): string {
  switch (s) {
    case 'live': return 'Live';
    case 'ready_for_setup': return 'Ready for setup';
    case 'needs_setup': return 'Needs setup';
    default: return 'Not available';
  }
}

/** Map liveState to an existing crm status CSS modifier (no new classes). */
export function liveStateClass(s: ProviderStatus['liveState']): string {
  switch (s) {
    case 'live': return 'CONNECTED';
    case 'ready_for_setup': return 'PENDING';
    case 'needs_setup': return 'NOT_CONNECTED';
    default: return 'NOT_CONNECTED';
  }
}

/** Human summary of the last verification diagnostic for the diagnostics panel. */
/** Human label for the authentication method that last succeeded. */
export type AuthMethodLabelInput = 'hmac' | 'bearer' | 'static-header' | 'unsigned-preview' | undefined;
export function authMethodLabel(m: AuthMethodLabelInput): string {
  switch (m) {
    case 'hmac': return 'HMAC signature';
    case 'bearer': return 'Bearer token';
    case 'static-header': return 'Static header';
    case 'unsigned-preview': return 'Unsigned (preview)';
    default: return 'Unknown';
  }
}

export function verificationSummary(v: ProviderStatus['lastVerification']): string {
  if (!v) return 'No verification recorded yet';
  const when = relativeTime(v.at);
  if (v.valid) {
    const sig = v.signaturePrefix ? ' (sig ' + v.signaturePrefix + ')' : '';
    const via = v.method ? ' via ' + authMethodLabel(v.method) : '';
    return 'Verified ' + when + via + sig;
  }
  return 'Rejected ' + when + (v.reason ? ' - ' + v.reason : '');
}

/** One-line summary of the last CallGrid API reconciliation sync. */
/**
 * Production-safe verification label. An 'unsigned-preview' verification is a
 * preview/test event and must NOT be presented as a live production verification
 * once the webhook signing secret is configured. In that case we surface a clear
 * pending state instead of a stale "Verified ... via Unsigned (preview)".
 */
export function productionVerificationSummary(
  v: ProviderStatus['lastVerification'],
  secretConfigured: boolean,
): string {
  if (secretConfigured && (!v || !v.valid || v.method === 'unsigned-preview')) {
    return 'Awaiting first signed production webhook';
  }
  return verificationSummary(v);
}

export function apiSyncSummary(s: ProviderStatus['apiSync']): string {
  if (!s) return 'No API sync run yet';
  const when = relativeTime(s.at);
  const parts = [
    s.fetched + ' fetched',
    s.imported + ' imported',
    s.enriched + ' enriched',
    s.skippedDuplicate + ' duplicate',
  ];
  const errs = s.failed > 0 || s.errorCount > 0 ? ', ' + (s.failed + s.errorCount) + ' errors' : '';
  return 'Synced ' + when + ' (' + s.range + '): ' + parts.join(', ') + errs;
}

export { listProviders, getProviderSpec, allSecretRefs, webhookUrlFor, EMG_WEBSITE_PROPERTIES };
