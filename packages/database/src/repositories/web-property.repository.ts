// WebPropertyRepository -- the AUTHORITATIVE EMG website-property registry (2026-09-30).
//
// Every EMG website property -- live or only owned -- is one row, belonging to exactly ONE organization, named by its
// key and its normalized primary domain (both unique across Loop). Two facts are kept apart (@emgloop/shared
// website-evidence): LIFECYCLE (OWNED / BUILDING / LIVE / PAUSED / RETIRED -- what the property is) and INGESTION
// (ENABLED / DISABLED -- whether Loop accepts its first-party telemetry now). Website ingestion admits events only
// for LIVE + ENABLED; an OWNED or BUILDING property exists here without being expected to send anything.
//
// WHAT NEVER MOVES A PROPERTY. Lifecycle and ingestion change only through `transitionLifecycle` / `setIngestion`,
// explicit operator acts scoped to the owning organization. `register` on an existing property updates its label,
// allowed domains and external bindings ONLY -- never its lifecycle, ingestion, primary domain or organization --
// so recording an external property (the shape a future account-level discovery will propose) can neither make a
// site LIVE nor move it. A key, a primary domain or an external binding another property holds is refused, never
// moved or shared.
//
// THE ONE CROSS-ORGANIZATION READ is `resolveForIngest(key)`: turning an incoming property key into its organization
// is, by definition, a lookup before the organization is known. It returns only what admission needs. Every other
// method takes `organizationId` first and is scoped by it.
//
// Registration is an OPERATOR act (scripts/operations/register-web-property.ts), never a migration and never a
// request path.

import type { PrismaClient, WebProperty } from '@prisma/client';
import {
  hostWithinPrimaryDomain,
  isWebPropertyIngestion,
  isWebPropertyKey,
  isWebPropertyLifecycle,
  normalizeWebDomain,
  WEB_PROPERTY_COMMISSION_BATCH_MAX,
  webPropertyIngestionChange,
  webPropertyLifecycleTransition,
  webPropertyLiveCommission,
  webSiteBindingHost,
  type WebPropertyIngestion,
  type WebPropertyLifecycle,
} from '@emgloop/shared';

/** What admission needs about a property. Nothing else crosses the organization boundary. */
export interface WebPropertyAdmission {
  readonly id: string;
  readonly key: string;
  readonly organizationId: string;
  readonly lifecycle: string;
  readonly ingestion: string;
  readonly allowedDomains: readonly string[];
}

export interface WebPropertyRegistration {
  readonly key: string;
  /** The property's own domain, e.g. servicesinmycity.com. Fixed once registered. */
  readonly primaryDomain: string;
  readonly label?: string | null;
  /** Hosts browser events may come from. Default: the primary domain (its subdomains, e.g. www., are covered). */
  readonly allowedDomains?: readonly string[];
  /** The lifecycle a NEW property starts in (default OWNED). For an existing property it must be unchanged. */
  readonly lifecycle?: WebPropertyLifecycle;
  readonly ga4PropertyId?: string | null;
  readonly searchConsoleSiteUrl?: string | null;
  readonly bingSiteUrl?: string | null;
  readonly clarityProjectId?: string | null;
  readonly registeredByUserId?: string | null;
}

export type WebPropertyRegistrationOutcome =
  | { readonly outcome: 'REGISTERED' | 'UPDATED' | 'UNCHANGED'; readonly property: WebProperty }
  | { readonly outcome: 'REFUSED'; readonly problems: readonly string[] };

/**
 * One requested property's place in a live-site commissioning batch -- every requested key gets exactly one entry,
 * in request order, whether the batch is refused or not (the operator sees the whole picture at once).
 *   WOULD_COMMISSION  it will be (or, after the write, was) moved to LIVE + ENABLED; `plan` says what that takes.
 *   UNCHANGED         it is already LIVE + ENABLED and is not written.
 *   REFUSED           it fails preflight; `code` says why. One REFUSED entry refuses the whole batch.
 */
export interface LiveCommissionEntry {
  readonly key: string;
  /** The state preflight read (`LIFECYCLE/INGESTION`), or null when the key named no property of this organization. */
  readonly before: { readonly lifecycle: string; readonly ingestion: string } | null;
  readonly result: 'WOULD_COMMISSION' | 'UNCHANGED' | 'REFUSED';
  readonly plan?: 'LIFECYCLE_AND_INGESTION' | 'INGESTION_ONLY';
  readonly code?: string;
}

/**
 * PLANNED: preflight passed (nothing written). COMMISSIONED: the batch was written, in one transaction. REFUSED:
 * nothing was written -- `listCode` for a malformed request, otherwise the REFUSED entries say which keys and why.
 */
export interface LiveCommissionOutcome {
  readonly outcome: 'PLANNED' | 'COMMISSIONED' | 'REFUSED';
  readonly entries: readonly LiveCommissionEntry[];
  readonly listCode?: 'EMPTY_LIST' | 'TOO_MANY_KEYS' | 'DUPLICATE_KEY' | 'KEY_SHAPE';
}

/** A write inside the batch transaction found its row changed since the preflight: the whole batch rolls back. */
class LiveCommissionConflict extends Error {
  constructor(readonly key: string) {
    super('live commission conflict');
  }
}

export type WebPropertyStateChange =
  | { readonly outcome: 'CHANGED'; readonly property: WebProperty }
  | { readonly outcome: 'REFUSED'; readonly code: string };

const GA4_PROPERTY_ID = /^\d{1,20}$/;
const CLARITY_PROJECT_ID = /^[a-z0-9]{6,32}$/;

/** Why a registration would be refused. Empty means it may be stored. Codes only. */
export function webPropertyRegistrationProblems(r: WebPropertyRegistration): string[] {
  const problems: string[] = [];
  if (!isWebPropertyKey(r.key)) problems.push('KEY_SHAPE');
  const primary = normalizeWebDomain(r.primaryDomain ?? '');
  if (!primary || primary !== r.primaryDomain) problems.push('PRIMARY_DOMAIN_SHAPE');
  const allowed = r.allowedDomains ?? (primary ? [primary] : []);
  if (allowed.length === 0) problems.push('NO_ALLOWED_DOMAINS');
  if (allowed.length > 32) problems.push('TOO_MANY_DOMAINS');
  if (allowed.some((d) => normalizeWebDomain(d) !== d)) problems.push('DOMAIN_SHAPE');
  else if (primary && allowed.some((d) => !hostWithinPrimaryDomain(d, primary))) problems.push('DOMAIN_OUTSIDE_PRIMARY');
  if (r.label != null && (r.label.length === 0 || r.label.length > 120)) problems.push('LABEL_SHAPE');
  if (r.lifecycle !== undefined && !isWebPropertyLifecycle(r.lifecycle)) problems.push('LIFECYCLE_UNKNOWN');
  if (r.ga4PropertyId != null && !GA4_PROPERTY_ID.test(r.ga4PropertyId)) problems.push('GA4_PROPERTY_ID_SHAPE');
  for (const [value, code] of [[r.searchConsoleSiteUrl, 'SEARCH_CONSOLE_SITE'], [r.bingSiteUrl, 'BING_SITE']] as const) {
    if (value == null) continue;
    const host = webSiteBindingHost(value);
    if (!host || !(value.startsWith('sc-domain:') || value.endsWith('/'))) problems.push(`${code}_SHAPE`);
    else if (primary && !hostWithinPrimaryDomain(host, primary)) problems.push(`${code}_OUTSIDE_PRIMARY`);
  }
  if (r.clarityProjectId != null && !CLARITY_PROJECT_ID.test(r.clarityProjectId)) problems.push('CLARITY_PROJECT_ID_SHAPE');
  return problems;
}

function fieldsOf(r: WebPropertyRegistration) {
  return {
    label: r.label ?? null,
    allowedDomains: [...new Set(r.allowedDomains ?? [r.primaryDomain])].sort(),
    ga4PropertyId: r.ga4PropertyId ?? null,
    searchConsoleSiteUrl: r.searchConsoleSiteUrl ?? null,
    bingSiteUrl: r.bingSiteUrl ?? null,
    clarityProjectId: r.clarityProjectId ?? null,
  };
}

function sameRegistration(existing: WebProperty, fields: ReturnType<typeof fieldsOf>): boolean {
  return (
    existing.label === fields.label &&
    JSON.stringify([...existing.allowedDomains].sort()) === JSON.stringify(fields.allowedDomains) &&
    existing.ga4PropertyId === fields.ga4PropertyId &&
    existing.searchConsoleSiteUrl === fields.searchConsoleSiteUrl &&
    existing.bingSiteUrl === fields.bingSiteUrl &&
    existing.clarityProjectId === fields.clarityProjectId
  );
}

/** Which identifying values of a registration another property (of any organization) already holds. */
async function heldElsewhere(db: Pick<PrismaClient, 'webProperty'>, r: WebPropertyRegistration, f: ReturnType<typeof fieldsOf>): Promise<string[]> {
  const checks: [string, Record<string, string>][] = [['PRIMARY_DOMAIN_REGISTERED_ELSEWHERE', { primaryDomain: r.primaryDomain }]];
  if (f.ga4PropertyId) checks.push(['GA4_PROPERTY_BOUND_ELSEWHERE', { ga4PropertyId: f.ga4PropertyId }]);
  if (f.searchConsoleSiteUrl) checks.push(['SEARCH_CONSOLE_SITE_BOUND_ELSEWHERE', { searchConsoleSiteUrl: f.searchConsoleSiteUrl }]);
  if (f.bingSiteUrl) checks.push(['BING_SITE_BOUND_ELSEWHERE', { bingSiteUrl: f.bingSiteUrl }]);
  if (f.clarityProjectId) checks.push(['CLARITY_PROJECT_BOUND_ELSEWHERE', { clarityProjectId: f.clarityProjectId }]);
  const problems: string[] = [];
  for (const [code, where] of checks) {
    const other = await db.webProperty.findFirst({ where: { ...where, NOT: { key: r.key } }, select: { id: true } });
    if (other) problems.push(code);
  }
  return problems;
}

/** Why an update of an EXISTING property is refused: its identity and state are not a registration's to change. */
function existingProblems(existing: WebProperty, organizationId: string, r: WebPropertyRegistration): string[] {
  if (existing.organizationId !== organizationId) return ['KEY_REGISTERED_ELSEWHERE'];
  const problems: string[] = [];
  if (existing.primaryDomain !== r.primaryDomain) problems.push('PRIMARY_DOMAIN_CHANGE_REFUSED');
  if (r.lifecycle !== undefined && r.lifecycle !== existing.lifecycle) problems.push('LIFECYCLE_CHANGE_NEEDS_TRANSITION');
  return problems;
}

export class WebPropertyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The property a key names, for admission -- or null when no property is registered under it. The ONE
   * cross-organization read (see the header). Admission decides with `webPropertyAdmissionRefusal`, which admits
   * only LIVE + ENABLED, so an unknown stored value can never admit.
   */
  async resolveForIngest(key: string): Promise<WebPropertyAdmission | null> {
    if (!isWebPropertyKey(key)) return null;
    return this.prisma.webProperty.findUnique({
      where: { key },
      select: { id: true, key: true, organizationId: true, lifecycle: true, ingestion: true, allowedDomains: true },
    });
  }

  /** What `register` would do, writing nothing: the dry run's answer. */
  async previewRegistration(organizationId: string, r: WebPropertyRegistration): Promise<{ outcome: 'REGISTERED' | 'UPDATED' | 'UNCHANGED' | 'REFUSED'; problems: readonly string[] }> {
    const problems = webPropertyRegistrationProblems(r);
    if (problems.length > 0) return { outcome: 'REFUSED', problems };
    const existing = await this.prisma.webProperty.findUnique({ where: { key: r.key } });
    const blocking = [...(existing ? existingProblems(existing, organizationId, r) : []), ...(await heldElsewhere(this.prisma, r, fieldsOf(r)))];
    if (blocking.length > 0) return { outcome: 'REFUSED', problems: blocking };
    if (!existing) return { outcome: 'REGISTERED', problems: [] };
    return { outcome: sameRegistration(existing, fieldsOf(r)) ? 'UNCHANGED' : 'UPDATED', problems: [] };
  }

  /**
   * Register a property for an organization (lifecycle OWNED unless given; ingestion always DISABLED), or update
   * an existing property's label, allowed domains and external bindings. Never changes an existing property's
   * organization, primary domain, lifecycle or ingestion.
   */
  async register(organizationId: string, r: WebPropertyRegistration): Promise<WebPropertyRegistrationOutcome> {
    const problems = webPropertyRegistrationProblems(r);
    if (problems.length > 0) return { outcome: 'REFUSED', problems };
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
    if (!org) return { outcome: 'REFUSED', problems: ['ORGANIZATION_NOT_FOUND'] };

    const fields = fieldsOf(r);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.webProperty.findUnique({ where: { key: r.key } });
      const blocking = [...(existing ? existingProblems(existing, organizationId, r) : []), ...(await heldElsewhere(tx, r, fields))];
      if (blocking.length > 0) return { outcome: 'REFUSED' as const, problems: blocking };
      if (!existing) {
        const property = await tx.webProperty.create({
          data: {
            organizationId,
            key: r.key,
            primaryDomain: r.primaryDomain,
            lifecycle: r.lifecycle ?? 'OWNED',
            ingestion: 'DISABLED',
            registeredByUserId: r.registeredByUserId ?? null,
            ...fields,
          },
        });
        return { outcome: 'REGISTERED' as const, property };
      }
      if (sameRegistration(existing, fields)) return { outcome: 'UNCHANGED' as const, property: existing };
      const property = await tx.webProperty.update({ where: { id: existing.id }, data: fields });
      return { outcome: 'UPDATED' as const, property };
    });
  }

  /**
   * Move one of this organization's properties through its lifecycle (WEB_PROPERTY_LIFECYCLE_TRANSITIONS). Leaving
   * LIVE disables ingestion in the same write. The organization is never touched. Refused as not-found when the
   * property is not this organization's.
   */
  async transitionLifecycle(organizationId: string, key: string, to: WebPropertyLifecycle, now: Date): Promise<WebPropertyStateChange> {
    if (!isWebPropertyLifecycle(to)) return { outcome: 'REFUSED', code: 'LIFECYCLE_UNKNOWN' };
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.webProperty.findFirst({ where: { organizationId, key } });
      if (!row) return { outcome: 'REFUSED' as const, code: 'PROPERTY_NOT_IN_ORGANIZATION' };
      if (!isWebPropertyLifecycle(row.lifecycle) || !isWebPropertyIngestion(row.ingestion)) return { outcome: 'REFUSED' as const, code: 'STATE_UNRECOGNIZED' };
      const next = webPropertyLifecycleTransition({ lifecycle: row.lifecycle, ingestion: row.ingestion }, to);
      if (!next.ok) return { outcome: 'REFUSED' as const, code: next.code };
      const updated = await tx.webProperty.updateMany({
        where: { id: row.id, organizationId, lifecycle: row.lifecycle, ingestion: row.ingestion },
        data: { lifecycle: next.lifecycle, ingestion: next.ingestion, lifecycleChangedAt: now },
      });
      if (updated.count !== 1) return { outcome: 'REFUSED' as const, code: 'CONCURRENT_CHANGE' };
      return { outcome: 'CHANGED' as const, property: (await tx.webProperty.findUnique({ where: { id: row.id } }))! };
    });
  }

  /** Enable or disable first-party ingestion for one of this organization's properties. ENABLED requires LIVE. */
  async setIngestion(organizationId: string, key: string, to: WebPropertyIngestion): Promise<WebPropertyStateChange> {
    if (!isWebPropertyIngestion(to)) return { outcome: 'REFUSED', code: 'INGESTION_UNKNOWN' };
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.webProperty.findFirst({ where: { organizationId, key } });
      if (!row) return { outcome: 'REFUSED' as const, code: 'PROPERTY_NOT_IN_ORGANIZATION' };
      if (!isWebPropertyLifecycle(row.lifecycle)) return { outcome: 'REFUSED' as const, code: 'STATE_UNRECOGNIZED' };
      if (row.ingestion === to) return { outcome: 'REFUSED' as const, code: 'INGESTION_UNCHANGED' };
      const allowed = webPropertyIngestionChange(row.lifecycle, to);
      if (!allowed.ok) return { outcome: 'REFUSED' as const, code: allowed.code };
      const updated = await tx.webProperty.updateMany({ where: { id: row.id, organizationId, lifecycle: row.lifecycle, ingestion: row.ingestion }, data: { ingestion: to } });
      if (updated.count !== 1) return { outcome: 'REFUSED' as const, code: 'CONCURRENT_CHANGE' };
      return { outcome: 'CHANGED' as const, property: (await tx.webProperty.findUnique({ where: { id: row.id } }))! };
    });
  }

  /**
   * PREFLIGHT for `commissionLive`, writing nothing: every key must name one of THIS organization's properties
   * (another organization's, or no property at all, is PROPERTY_NOT_IN_ORGANIZATION -- cross-organization is
   * not-found), and every property must be able to reach LIVE + ENABLED through the governed state machine. One
   * refusal refuses the batch; every refusal is reported.
   */
  async previewLiveCommission(organizationId: string, keys: readonly string[]): Promise<LiveCommissionOutcome> {
    return planLiveCommission(this.prisma, organizationId, keys);
  }

  /**
   * Converge a batch of this organization's properties to LIVE with ingestion ENABLED -- ALL OR NOTHING. The
   * preflight and the writes run in ONE transaction: if any property is refused, nothing is written; if any row
   * changed after the preflight read it (each write is conditional on the state it read), the transaction throws and
   * every write in it rolls back. Each property changes in a single write (lifecycle and ingestion together), so no
   * property is ever left LIVE with ingestion DISABLED by this act. A property already LIVE + ENABLED is left as it
   * is, so a re-run converges instead of failing. `organizationId` is never written.
   */
  async commissionLive(organizationId: string, keys: readonly string[], now: Date): Promise<LiveCommissionOutcome> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const planned = await planLiveCommission(tx, organizationId, keys);
        if (planned.outcome !== 'PLANNED') return planned;
        for (const entry of planned.entries) {
          if (entry.result !== 'WOULD_COMMISSION' || !entry.before) continue;
          // Conditional on exactly the state preflight read, and never touching organizationId, the primary domain,
          // allowed domains or any binding: only lifecycle, ingestion and (when the lifecycle moves) its timestamp.
          const updated = await tx.webProperty.updateMany({
            where: { organizationId, key: entry.key, lifecycle: entry.before.lifecycle, ingestion: entry.before.ingestion },
            data: { lifecycle: 'LIVE', ingestion: 'ENABLED', ...(entry.plan === 'LIFECYCLE_AND_INGESTION' ? { lifecycleChangedAt: now } : {}) },
          });
          if (updated.count !== 1) throw new LiveCommissionConflict(entry.key);
        }
        return { outcome: 'COMMISSIONED' as const, entries: planned.entries };
      });
    } catch (error) {
      if (!(error instanceof LiveCommissionConflict)) throw error;
      // The transaction rolled back: report every key, the changed one as refused.
      const entries = keys.map((key): LiveCommissionEntry => (key === error.key ? { key, before: null, result: 'REFUSED', code: 'CONCURRENT_CHANGE' } : { key, before: null, result: 'REFUSED', code: 'BATCH_ROLLED_BACK' }));
      return { outcome: 'REFUSED', entries };
    }
  }

  /** This organization's properties, by key. */
  async listForOrganization(organizationId: string): Promise<WebProperty[]> {
    return this.prisma.webProperty.findMany({ where: { organizationId }, orderBy: { key: 'asc' } });
  }

  /** One of this organization's properties, or null -- another organization's is not-found. */
  async findForOrganization(organizationId: string, key: string): Promise<WebProperty | null> {
    return this.prisma.webProperty.findFirst({ where: { organizationId, key } });
  }
}

/** The shared preflight: scoped to the organization, every key accounted for, the governed state machine applied. */
async function planLiveCommission(db: Pick<PrismaClient, 'webProperty'>, organizationId: string, keys: readonly string[]): Promise<LiveCommissionOutcome> {
  // The request itself (the operator script parses it first; this is the repository's own backstop).
  if (keys.length === 0) return { outcome: 'REFUSED', entries: [], listCode: 'EMPTY_LIST' };
  if (keys.length > WEB_PROPERTY_COMMISSION_BATCH_MAX) return { outcome: 'REFUSED', entries: [], listCode: 'TOO_MANY_KEYS' };
  if (new Set(keys).size !== keys.length) return { outcome: 'REFUSED', entries: [], listCode: 'DUPLICATE_KEY' };
  if (keys.some((key) => !isWebPropertyKey(key))) return { outcome: 'REFUSED', entries: [], listCode: 'KEY_SHAPE' };
  // Only THIS organization's rows are ever read: another organization's property is indistinguishable from none.
  const rows = await db.webProperty.findMany({
    where: { organizationId, key: { in: [...keys] } },
    select: { key: true, organizationId: true, lifecycle: true, ingestion: true },
  });
  const entries = keys.map((key): LiveCommissionEntry => {
    const matches = rows.filter((r) => r.key === key);
    if (matches.length !== 1 || matches[0]!.organizationId !== organizationId) return { key, before: null, result: 'REFUSED', code: 'PROPERTY_NOT_IN_ORGANIZATION' };
    const row = matches[0]!;
    const before = { lifecycle: row.lifecycle, ingestion: row.ingestion };
    const plan = webPropertyLiveCommission(row);
    if (!plan.ok) return { key, before, result: 'REFUSED', code: plan.code };
    if (!plan.lifecycleChange && !plan.ingestionChange) return { key, before, result: 'UNCHANGED' };
    return { key, before, result: 'WOULD_COMMISSION', plan: plan.lifecycleChange ? 'LIFECYCLE_AND_INGESTION' : 'INGESTION_ONLY' };
  });
  return { outcome: entries.some((e) => e.result === 'REFUSED') ? 'REFUSED' : 'PLANNED', entries };
}
