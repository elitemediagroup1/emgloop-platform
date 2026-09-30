// WebPropertyRepository -- the governed property -> organization authority for website evidence (2026-09-30).
//
// A website property (a site running Loop's tracker, and later the GA4 property / Search Console site / Bing
// site / Clarity project that observe it) belongs to exactly ONE organization, and this table is the only
// thing that says which. The website webhook resolves tenancy here and nowhere else: no browser-supplied
// field, no domain a request claims, no code constant and no default organization selects one. An
// unregistered property is refused (PROPERTY_UNREGISTERED); a DISABLED one is refused (PROPERTY_DISABLED).
//
// THE ONE CROSS-ORGANIZATION READ is `resolveForIngest(key)`: turning an incoming property key into its
// organization is, by definition, a lookup before the organization is known -- the same shape as resolving a
// session. It returns only what admission needs (id, organization, status, allowed domains). Every other
// method takes `organizationId` first and is scoped by it.
//
// Registration is an OPERATOR act (scripts/operations/register-web-property.ts), never a migration and never
// a request path: the migration that creates this table inserts nothing, because a guessed binding would
// route one business's visitors into another's evidence.

import type { PrismaClient, WebProperty } from '@prisma/client';
import {
  WEB_PROPERTY_STATUSES,
  isWebPropertyKey,
  normalizeWebDomain,
  type WebPropertyStatus,
} from '@emgloop/shared';

/** What admission needs about a property. Nothing else crosses the organization boundary. */
export interface WebPropertyAdmission {
  readonly id: string;
  readonly key: string;
  readonly organizationId: string;
  readonly status: WebPropertyStatus;
  readonly allowedDomains: readonly string[];
}

export interface WebPropertyRegistration {
  readonly key: string;
  readonly label?: string | null;
  readonly allowedDomains: readonly string[];
  readonly ga4PropertyId?: string | null;
  readonly searchConsoleSiteUrl?: string | null;
  readonly bingSiteUrl?: string | null;
  readonly clarityProjectId?: string | null;
  readonly registeredByUserId?: string | null;
}

export type WebPropertyRegistrationOutcome =
  | { readonly outcome: 'REGISTERED' | 'UPDATED' | 'UNCHANGED'; readonly property: WebProperty }
  | { readonly outcome: 'REFUSED'; readonly problems: readonly string[] };

const GA4_PROPERTY_ID = /^\d{1,20}$/;
const CLARITY_PROJECT_ID = /^[a-z0-9]{6,32}$/;

/** A Search Console / Bing site: `sc-domain:<host>` or an https URL prefix ending in '/'. */
function siteUrlOk(value: string): boolean {
  if (value.startsWith('sc-domain:')) return normalizeWebDomain(value.slice('sc-domain:'.length)) !== null;
  const m = /^https?:\/\/([^/?#]+)\/(?:[^?#]*\/)?$/.exec(value);
  return !!m && normalizeWebDomain(m[1]!) !== null;
}

/** Why a registration would be refused. Empty means it may be stored. Codes only. */
export function webPropertyRegistrationProblems(r: WebPropertyRegistration): string[] {
  const problems: string[] = [];
  if (!isWebPropertyKey(r.key)) problems.push('KEY_SHAPE');
  if (r.allowedDomains.length === 0) problems.push('NO_ALLOWED_DOMAINS');
  if (r.allowedDomains.length > 32) problems.push('TOO_MANY_DOMAINS');
  if (r.allowedDomains.some((d) => normalizeWebDomain(d) !== d)) problems.push('DOMAIN_SHAPE');
  if (r.label != null && (r.label.length === 0 || r.label.length > 120)) problems.push('LABEL_SHAPE');
  if (r.ga4PropertyId != null && !GA4_PROPERTY_ID.test(r.ga4PropertyId)) problems.push('GA4_PROPERTY_ID_SHAPE');
  if (r.searchConsoleSiteUrl != null && !siteUrlOk(r.searchConsoleSiteUrl)) problems.push('SEARCH_CONSOLE_SITE_SHAPE');
  if (r.bingSiteUrl != null && !siteUrlOk(r.bingSiteUrl)) problems.push('BING_SITE_SHAPE');
  if (r.clarityProjectId != null && !CLARITY_PROJECT_ID.test(r.clarityProjectId)) problems.push('CLARITY_PROJECT_ID_SHAPE');
  return problems;
}

function fieldsOf(r: WebPropertyRegistration) {
  return {
    label: r.label ?? null,
    allowedDomains: [...new Set(r.allowedDomains)].sort(),
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

/** Which of a registration's external bindings another property (of any organization) already holds. */
async function bindingsHeldElsewhere(
  db: Pick<PrismaClient, 'webProperty'>,
  key: string,
  f: ReturnType<typeof fieldsOf>,
): Promise<string[]> {
  const checks: [string, Record<string, string>][] = [];
  if (f.ga4PropertyId) checks.push(['GA4_PROPERTY_BOUND_ELSEWHERE', { ga4PropertyId: f.ga4PropertyId }]);
  if (f.searchConsoleSiteUrl) checks.push(['SEARCH_CONSOLE_SITE_BOUND_ELSEWHERE', { searchConsoleSiteUrl: f.searchConsoleSiteUrl }]);
  if (f.bingSiteUrl) checks.push(['BING_SITE_BOUND_ELSEWHERE', { bingSiteUrl: f.bingSiteUrl }]);
  if (f.clarityProjectId) checks.push(['CLARITY_PROJECT_BOUND_ELSEWHERE', { clarityProjectId: f.clarityProjectId }]);
  const problems: string[] = [];
  for (const [code, where] of checks) {
    const other = await db.webProperty.findFirst({ where: { ...where, NOT: { key } }, select: { id: true } });
    if (other) problems.push(code);
  }
  return problems;
}

function isStatus(value: string): value is WebPropertyStatus {
  return (WEB_PROPERTY_STATUSES as readonly string[]).includes(value);
}

export class WebPropertyRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * The property a key names, for admission -- or null when no property is registered under it. The ONE
   * cross-organization read (see the header). A row with an unknown status is reported DISABLED: fail closed.
   */
  async resolveForIngest(key: string): Promise<WebPropertyAdmission | null> {
    if (!isWebPropertyKey(key)) return null;
    const row = await this.prisma.webProperty.findUnique({
      where: { key },
      select: { id: true, key: true, organizationId: true, status: true, allowedDomains: true },
    });
    if (!row) return null;
    return { ...row, status: isStatus(row.status) ? row.status : 'DISABLED' };
  }

  /** What `register` would do, writing nothing: the dry run's answer. */
  async previewRegistration(organizationId: string, r: WebPropertyRegistration): Promise<{ outcome: 'REGISTERED' | 'UPDATED' | 'UNCHANGED' | 'REFUSED'; problems: readonly string[] }> {
    const problems = webPropertyRegistrationProblems(r);
    if (problems.length > 0) return { outcome: 'REFUSED', problems };
    const existing = await this.prisma.webProperty.findUnique({ where: { key: r.key } });
    if (!existing) {
      const held = await bindingsHeldElsewhere(this.prisma, r.key, fieldsOf(r));
      return held.length > 0 ? { outcome: 'REFUSED', problems: held } : { outcome: 'REGISTERED', problems: [] };
    }
    if (existing.organizationId !== organizationId) return { outcome: 'REFUSED', problems: ['KEY_REGISTERED_ELSEWHERE'] };
    const held = await bindingsHeldElsewhere(this.prisma, r.key, fieldsOf(r));
    if (held.length > 0) return { outcome: 'REFUSED', problems: held };
    return { outcome: sameRegistration(existing, fieldsOf(r)) ? 'UNCHANGED' : 'UPDATED', problems: [] };
  }

  /**
   * Register a property for an organization, or update its bindings. A key already registered to ANOTHER
   * organization is refused (KEY_REGISTERED_ELSEWHERE) -- a property is never moved between organizations
   * by a registration; that is a disable-and-reregister an operator does deliberately. An external binding
   * another property already holds is refused (<SOURCE>_BOUND_ELSEWHERE).
   */
  async register(organizationId: string, r: WebPropertyRegistration): Promise<WebPropertyRegistrationOutcome> {
    const problems = webPropertyRegistrationProblems(r);
    if (problems.length > 0) return { outcome: 'REFUSED', problems };
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
    if (!org) return { outcome: 'REFUSED', problems: ['ORGANIZATION_NOT_FOUND'] };

    const fields = fieldsOf(r);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.webProperty.findUnique({ where: { key: r.key } });
      if (existing && existing.organizationId !== organizationId) {
        return { outcome: 'REFUSED' as const, problems: ['KEY_REGISTERED_ELSEWHERE'] };
      }
      // One external property belongs to one Loop property (unique in the database too): a GA4 property, a
      // Search Console / Bing site or a Clarity project another property holds is refused, never shared.
      const held = await bindingsHeldElsewhere(tx, r.key, fields);
      if (held.length > 0) return { outcome: 'REFUSED' as const, problems: held };
      if (!existing) {
        const property = await tx.webProperty.create({
          data: { organizationId, key: r.key, registeredByUserId: r.registeredByUserId ?? null, ...fields },
        });
        return { outcome: 'REGISTERED' as const, property };
      }
      if (sameRegistration(existing, fields)) return { outcome: 'UNCHANGED' as const, property: existing };
      const property = await tx.webProperty.update({ where: { id: existing.id }, data: fields });
      return { outcome: 'UPDATED' as const, property };
    });
  }

  /** Enable or disable one of this organization's properties. Null when it is not this organization's. */
  async setStatus(organizationId: string, key: string, status: WebPropertyStatus): Promise<WebProperty | null> {
    const row = await this.prisma.webProperty.findFirst({ where: { organizationId, key } });
    if (!row) return null;
    if (row.status === status) return row;
    return this.prisma.webProperty.update({ where: { id: row.id }, data: { status } });
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
