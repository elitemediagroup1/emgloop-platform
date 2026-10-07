// The governed CRM outreach importer's contract (CRM slice 5, decisions 2026-10-07).
//
// THE SOURCE IS EVIDENCE, NOT AUTHORITY. A row of the structured outreach source is read through
// reviewed rules -- route classification, creator aliases, a stage mapping -- before anything in
// the CRM is proposed. Nothing here creates, matches or guesses: it parses, normalizes and checks
// shapes. Planning lives in `@emgloop/database` (crm-import), writing in the governed services.
//
// WHAT IS LOCKED HERE:
//   - one importer version string, recorded on every run;
//   - the act table (who may dry-run, map, approve and apply);
//   - the route classifications;
//   - the canonical CSV schema (no workbook layout, tabs, merged cells or formatting);
//   - how a creator alias, a route key and a source status are compared (documented normalization);
//   - when a source contact may become a PERSON (never from an email local-part, never unverified);
//   - the reviewed configuration and stage-mapping shapes;
//   - the Opportunity title rule.
//
// PURE. No clock, no I/O, no hashing (hashing is keyed and lives server-side).

import { crmContactPointReasonCarriesContactValue } from './crm-contact-point';

/**
 * Recorded on every run. Change it whenever normalization, matching, mapping or planning changes.
 *   v1 (2026-10-07) every row named a creator.
 *   v2 (2026-10-07) `creator_alias` is OPTIONAL: a row without one may still import its governed
 *       Company, Person and Contact Points, but can never create an Opportunity. A v1 plan is never
 *       reinterpreted under v2 (approvals bind the version).
 */
export const CRM_IMPORT_VERSION = 'crm-outreach-import.v2' as const;

// --- Who may do what (decided 2026-10-07) --------------------------------------------------

export const CRM_IMPORT_ACTS = ['VIEW', 'DRY_RUN', 'MAP_CREATOR_ALIAS', 'MAP_ROUTE', 'APPROVE_APPLY', 'APPLY'] as const;
export type CrmImportAct = (typeof CRM_IMPORT_ACTS)[number];

const HUMAN_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'] as const;
const EMPLOYEE_AND_ABOVE = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'] as const;
const OWNER_ADMIN = ['OWNER', 'ADMIN'] as const;

/** AI_EMPLOYEE and CREATOR appear nowhere. */
export const CRM_IMPORT_ACT_ROLES: Readonly<Record<CrmImportAct, readonly string[]>> = Object.freeze({
  VIEW: HUMAN_ROLES,
  DRY_RUN: EMPLOYEE_AND_ABOVE,
  MAP_CREATOR_ALIAS: OWNER_ADMIN,
  MAP_ROUTE: OWNER_ADMIN,
  APPROVE_APPLY: OWNER_ADMIN,
  APPLY: OWNER_ADMIN,
});

export const CRM_IMPORT_FORBIDDEN_ROLES: readonly string[] = Object.freeze(['AI_EMPLOYEE']);

export function crmImportActPermitted(request: { readonly act: string; readonly role: string; readonly actorType: string }): boolean {
  if (request.actorType !== 'HUMAN') return false;
  if (CRM_IMPORT_FORBIDDEN_ROLES.includes(request.role)) return false;
  const roles = (CRM_IMPORT_ACT_ROLES as Readonly<Record<string, readonly string[]>>)[request.act];
  return Array.isArray(roles) && roles.includes(request.role);
}

// --- Route classification ------------------------------------------------------------------

/**
 * What a source route (a heading or mailbox group in the outreach directory) IS, decided by an
 * OWNER/ADMIN and recorded, never inferred from a domain or a name:
 *   BRAND_COMPANY     the route is a brand: it is (or proposes) the brand Company of a pursuit.
 *   AGENCY            an agency: may be (or propose) its own Company; a pursuit's brand only through
 *                     an explicit represented brand.
 *   PARENT_COMPANY    a parent company: as AGENCY.
 *   ROLE_INBOX_ROUTE  a shared/team mailbox route with no Company of its own: its addresses are
 *                     ROLE_INBOX on the represented brand, when one is mapped.
 *   CREATOR_ROUTE     a creator's own route: never a Company, never a pursuit.
 *   INTERNAL          EMG's own: never a Company, never a pursuit.
 *   PERSONAL_GENERIC  personal mail (e.g. a gmail.com group): never a Company; contacts only through
 *                     an explicit represented brand.
 *   UNKNOWN           reviewed and still unknown: nothing is created.
 * An unmapped route is not UNKNOWN: it is unreviewed, and blocks the same way.
 */
export const CRM_IMPORT_ROUTE_CLASSIFICATIONS = [
  'BRAND_COMPANY',
  'AGENCY',
  'PARENT_COMPANY',
  'ROLE_INBOX_ROUTE',
  'CREATOR_ROUTE',
  'INTERNAL',
  'PERSONAL_GENERIC',
  'UNKNOWN',
] as const;
export type CrmImportRouteClassification = (typeof CRM_IMPORT_ROUTE_CLASSIFICATIONS)[number];

/** Classifications whose route is (or proposes) a Company of its own. */
export const CRM_IMPORT_COMPANY_ROUTES: readonly CrmImportRouteClassification[] = ['BRAND_COMPANY', 'AGENCY', 'PARENT_COMPANY'];
/** Classifications that may name a represented brand (a pursuit's brand that is not the route itself). */
export const CRM_IMPORT_REPRESENTING_ROUTES: readonly CrmImportRouteClassification[] = ['AGENCY', 'PARENT_COMPANY', 'ROLE_INBOX_ROUTE', 'PERSONAL_GENERIC'];
/** Classifications that never create anything. */
export const CRM_IMPORT_INERT_ROUTES: readonly CrmImportRouteClassification[] = ['CREATOR_ROUTE', 'INTERNAL', 'UNKNOWN'];

export function isCrmImportRouteClassification(value: unknown): value is CrmImportRouteClassification {
  return typeof value === 'string' && (CRM_IMPORT_ROUTE_CLASSIFICATIONS as readonly string[]).includes(value);
}

// --- Keys and normalization ----------------------------------------------------------------

/**
 * How a creator alias, a route key and a source status are compared: Unicode NFKC, trimmed, inner
 * whitespace collapsed to one space, lower-cased. Nothing else: no punctuation stripping, no
 * accent folding, no stemming, no "close enough". Two different written forms that normalize to
 * the same key are the SAME key -- and two reviewed mappings that collide on a key are refused.
 */
export function crmImportKey(text: unknown): string {
  if (typeof text !== 'string') return '';
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** A source row key: stable across re-exports, safe characters, no contact value. */
export function crmImportSourceRowKeyValid(key: unknown): key is string {
  return typeof key === 'string' && /^[A-Za-z0-9._:/-]{1,120}$/.test(key) && !crmContactPointReasonCarriesContactValue(key);
}

// --- The canonical source CSV --------------------------------------------------------------

/**
 * The columns, in no required order. Header names are exact (case-sensitive). An unknown or
 * repeated column refuses the whole file: a column the importer does not understand is never
 * silently ignored.
 */
export const CRM_IMPORT_REQUIRED_COLUMNS = ['source_row_key', 'route_key', 'source_status'] as const;
/**
 * `creator_alias` is optional (v2): EMG's CRM imports any business contact, not only creator pursuits. A
 * blank alias means "no creator" -- never inferred from a note, route, address, brand, title or domain --
 * and a row without one can never create an Opportunity.
 */
export const CRM_IMPORT_OPTIONAL_COLUMNS = [
  'creator_alias',
  'route_name',
  'brand_name',
  'contact_name',
  'contact_name_verified',
  'contact_kind',
  'contact_title',
  'email',
  'phone',
  'source_notes',
  'source_last_contacted_at',
] as const;
export const CRM_IMPORT_COLUMNS = [...CRM_IMPORT_REQUIRED_COLUMNS, ...CRM_IMPORT_OPTIONAL_COLUMNS] as const;
export type CrmImportColumn = (typeof CRM_IMPORT_COLUMNS)[number];

/** Limits that refuse a file rather than reading a malformed or oversized one. */
export const CRM_IMPORT_MAX_ROWS = 50_000;
export const CRM_IMPORT_MAX_FIELD = 4_000;

/** A source contact's declared kind. Blank is "not declared", which never becomes a Person. */
export const CRM_IMPORT_CONTACT_KINDS = ['INDIVIDUAL', 'ROLE_INBOX'] as const;
export type CrmImportContactKind = (typeof CRM_IMPORT_CONTACT_KINDS)[number];

export interface CrmImportSourceRow {
  /** 1-based data line (the header is line 1), for messages only; never an identity. */
  readonly line: number;
  readonly sourceRowKey: string;
  /** The creator as the source labels them, or null: no creator, and so no Opportunity from this row. */
  readonly creatorAlias: string | null;
  readonly routeKey: string;
  readonly sourceStatus: string;
  readonly routeName: string | null;
  readonly brandName: string | null;
  readonly contactName: string | null;
  readonly contactNameVerified: boolean;
  readonly contactKind: CrmImportContactKind | null;
  readonly contactTitle: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly sourceNotes: string | null;
  /** ISO calendar date or instant, when the source records the last human contact. */
  readonly sourceLastContactedAt: string | null;
}

export type CrmImportRowViolation =
  | 'SOURCE_ROW_KEY_INVALID'
  | 'KEY_CARRIES_CONTACT_VALUE'
  | 'ROUTE_KEY_REQUIRED'
  | 'SOURCE_STATUS_REQUIRED'
  | 'CONTACT_NAME_VERIFIED_INVALID'
  | 'CONTACT_KIND_INVALID'
  | 'LAST_CONTACTED_AT_INVALID'
  | 'FIELD_TOO_LONG'
  | 'COLUMN_COUNT_MISMATCH';

export type CrmImportFileProblem =
  | 'EMPTY_FILE'
  | 'UNTERMINATED_QUOTE'
  | 'MISSING_COLUMN'
  | 'UNKNOWN_COLUMN'
  | 'DUPLICATE_COLUMN'
  | 'TOO_MANY_ROWS';

export type CrmImportParseResult =
  | {
      readonly ok: true;
      readonly rows: readonly CrmImportSourceRow[];
      /** Rows refused by shape, by line. Their contents are not echoed. */
      readonly invalid: readonly { readonly line: number; readonly sourceRowKey: string | null; readonly violations: readonly CrmImportRowViolation[] }[];
    }
  /**
   * `column` is named only when it is one of the contract's own column names. An unknown header cell is
   * reported by its 1-based POSITION: a headerless export would otherwise put a data cell -- an address,
   * a name -- into an error message.
   */
  | { readonly ok: false; readonly problem: CrmImportFileProblem; readonly column?: string; readonly position?: number };

/** RFC 4180 records: quoted fields, doubled quotes, CRLF or LF, a leading BOM ignored. */
export function parseCsvRecords(text: string): { ok: true; records: string[][] } | { ok: false; problem: 'UNTERMINATED_QUOTE' } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      record.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += c === '\r' && src[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (quoted) return { ok: false, problem: 'UNTERMINATED_QUOTE' };
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // A blank line is not a record.
  return { ok: true, records: records.filter((r) => !(r.length === 1 && r[0]!.trim() === '')) };
}

const blank = (v: string | undefined): string | null => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t.length > 0 ? t : null;
};

/** Parse and shape-check the canonical CSV. Never interprets a value beyond its declared shape. */
export function parseCrmImportCsv(text: string): CrmImportParseResult {
  const parsed = parseCsvRecords(text);
  if (!parsed.ok) return { ok: false, problem: parsed.problem };
  const [header, ...data] = parsed.records;
  if (!header || header.every((h) => h.trim() === '')) return { ok: false, problem: 'EMPTY_FILE' };
  const names = header.map((h) => h.trim());
  const seen = new Set<string>();
  for (const [i, name] of names.entries()) {
    if (!(CRM_IMPORT_COLUMNS as readonly string[]).includes(name)) return { ok: false, problem: 'UNKNOWN_COLUMN', position: i + 1 };
    if (seen.has(name)) return { ok: false, problem: 'DUPLICATE_COLUMN', column: name };
    seen.add(name);
  }
  for (const required of CRM_IMPORT_REQUIRED_COLUMNS) {
    if (!seen.has(required)) return { ok: false, problem: 'MISSING_COLUMN', column: required };
  }
  if (data.length > CRM_IMPORT_MAX_ROWS) return { ok: false, problem: 'TOO_MANY_ROWS' };

  const rows: CrmImportSourceRow[] = [];
  const invalid: { line: number; sourceRowKey: string | null; violations: CrmImportRowViolation[] }[] = [];
  data.forEach((record, index) => {
    const line = index + 2;
    const violations: CrmImportRowViolation[] = [];
    if (record.length !== names.length) violations.push('COLUMN_COUNT_MISMATCH');
    if (record.some((f) => f.length > CRM_IMPORT_MAX_FIELD)) violations.push('FIELD_TOO_LONG');
    const get = (column: CrmImportColumn): string | undefined => {
      const at = names.indexOf(column);
      return at >= 0 ? record[at] : undefined;
    };
    const rowKey = blank(get('source_row_key'));
    if (!crmImportSourceRowKeyValid(rowKey)) violations.push('SOURCE_ROW_KEY_INVALID');
    // Optional: blank is "no creator", never a violation.
    const creatorAlias = blank(get('creator_alias'));
    const routeKey = blank(get('route_key'));
    if (!routeKey) violations.push('ROUTE_KEY_REQUIRED');
    // Aliases and route keys are kept in provenance and plans; an address or a number never is.
    if ((creatorAlias && crmContactPointReasonCarriesContactValue(creatorAlias)) || (routeKey && crmContactPointReasonCarriesContactValue(routeKey))) {
      violations.push('KEY_CARRIES_CONTACT_VALUE');
    }
    const status = blank(get('source_status'));
    if (!status) violations.push('SOURCE_STATUS_REQUIRED');
    const verifiedRaw = (blank(get('contact_name_verified')) ?? '').toUpperCase();
    if (verifiedRaw !== '' && verifiedRaw !== 'TRUE' && verifiedRaw !== 'FALSE') violations.push('CONTACT_NAME_VERIFIED_INVALID');
    const kindRaw = (blank(get('contact_kind')) ?? '').toUpperCase();
    if (kindRaw !== '' && !(CRM_IMPORT_CONTACT_KINDS as readonly string[]).includes(kindRaw)) violations.push('CONTACT_KIND_INVALID');
    const lastContacted = blank(get('source_last_contacted_at'));
    if (lastContacted !== null && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(lastContacted)) {
      violations.push('LAST_CONTACTED_AT_INVALID');
    } else if (lastContacted !== null && !Number.isFinite(Date.parse(lastContacted))) {
      violations.push('LAST_CONTACTED_AT_INVALID');
    }
    if (violations.length > 0) {
      invalid.push({ line, sourceRowKey: crmImportSourceRowKeyValid(rowKey) ? rowKey : null, violations });
      return;
    }
    rows.push({
      line,
      sourceRowKey: rowKey!,
      creatorAlias,
      routeKey: routeKey!,
      sourceStatus: status!,
      routeName: blank(get('route_name')),
      brandName: blank(get('brand_name')),
      contactName: blank(get('contact_name')),
      contactNameVerified: verifiedRaw === 'TRUE',
      contactKind: kindRaw === '' ? null : (kindRaw as CrmImportContactKind),
      contactTitle: blank(get('contact_title')),
      email: blank(get('email')),
      phone: blank(get('phone')),
      sourceNotes: blank(get('source_notes')),
      sourceLastContactedAt: lastContacted,
    });
  });
  return { ok: true, rows, invalid };
}

// --- When a source contact may become a PERSON (decision P, locked) ------------------------

/** Names that are never a person, compared as `crmImportKey`. */
export const CRM_IMPORT_NON_NAMES: readonly string[] = Object.freeze([
  'name not verified',
  'not verified',
  'unverified',
  'unknown',
  'n/a',
  'na',
  'none',
  'tbd',
  'tba',
  '-',
  '--',
  '?',
  'no name',
  'team',
  'info',
  'support',
  'marketing',
  'partnerships',
  'press',
  'pr',
]);

/**
 * Whether a row may propose (or reuse, by exact Contact Point) a PERSON: the source declares the
 * contact an INDIVIDUAL, says the name is verified, and the name is nonblank and not a known
 * non-name. Nothing is read from an email address. Anything else stays on the Company as a
 * ROLE_INBOX or UNATTRIBUTED Contact Point.
 */
export function crmImportPersonEligible(row: Pick<CrmImportSourceRow, 'contactName' | 'contactNameVerified' | 'contactKind'>): boolean {
  if (row.contactKind !== 'INDIVIDUAL' || !row.contactNameVerified) return false;
  const key = crmImportKey(row.contactName);
  if (!key) return false;
  if (CRM_IMPORT_NON_NAMES.includes(key)) return false;
  // A name with no letter in it ("—", "123") is not a name.
  return /\p{L}/u.test(key);
}

// --- Stage mapping (decision F: contract built, mapping NOT decided) -----------------------

/**
 * What a reviewed source status means for import:
 *   OPPORTUNITY    the row contributes to its creator x brand pursuit, opened in `category`/`stage`;
 *   CONTACTS_ONLY  the row's Company, Person and Contact Points may be imported, but it does not
 *                  create or shape an Opportunity;
 *   EXCLUDE        the row is not imported at all.
 * A status with no entry is STAGE_MAPPING_REQUIRED and blocks every write the row would cause.
 */
export const CRM_IMPORT_STATUS_ACTIONS = ['OPPORTUNITY', 'CONTACTS_ONLY', 'EXCLUDE'] as const;
export type CrmImportStatusAction = (typeof CRM_IMPORT_STATUS_ACTIONS)[number];

export interface CrmImportStageMappingEntry {
  readonly sourceStatus: string;
  readonly action: CrmImportStatusAction;
  readonly category?: string | null;
  readonly stage?: string | null;
}

// --- The reviewed configuration artifact ---------------------------------------------------

export const CRM_IMPORT_CONFIG_VERSION = 'crm-outreach-import-config.v1' as const;

export interface CrmImportCreatorAliasConfig {
  readonly alias: string;
  readonly creatorPartyId: string;
}

export interface CrmImportRouteConfig {
  readonly routeKey: string;
  readonly classification: CrmImportRouteClassification;
  /** An existing Company this route IS (BRAND_COMPANY, AGENCY, PARENT_COMPANY). */
  readonly targetCompanyPartyId?: string | null;
  /** The reviewed name of the Company this route proposes, when it has no target. */
  readonly proposedCompanyName?: string | null;
  /** The brand a representing route speaks for: an existing Company... */
  readonly representedBrandPartyId?: string | null;
  /** ...or the route key of a BRAND_COMPANY route (which may itself be a proposal). */
  readonly representedBrandRouteKey?: string | null;
}

export interface CrmImportConfig {
  readonly version: typeof CRM_IMPORT_CONFIG_VERSION;
  readonly creatorAliases: readonly CrmImportCreatorAliasConfig[];
  readonly routes: readonly CrmImportRouteConfig[];
  readonly stageMapping: readonly CrmImportStageMappingEntry[];
}

export type CrmImportConfigViolation = { readonly at: string; readonly code: string };

const COMPANY_NAME_MAX = 200;

/** Shape-check one route mapping. Party ids are checked against the Party authority by the writer. */
export function validateCrmImportRoute(route: Partial<CrmImportRouteConfig>): string[] {
  const out: string[] = [];
  if (!crmImportKey(route.routeKey)) out.push('ROUTE_KEY_REQUIRED');
  else if (crmContactPointReasonCarriesContactValue(route.routeKey!)) out.push('ROUTE_KEY_CARRIES_CONTACT_VALUE');
  if (!isCrmImportRouteClassification(route.classification)) {
    out.push('UNKNOWN_CLASSIFICATION');
    return out;
  }
  const c = route.classification;
  const target = route.targetCompanyPartyId?.trim() || null;
  const proposed = route.proposedCompanyName?.trim() || null;
  const repParty = route.representedBrandPartyId?.trim() || null;
  const repRoute = crmImportKey(route.representedBrandRouteKey) || null;
  const ownsCompany = CRM_IMPORT_COMPANY_ROUTES.includes(c);
  if (!ownsCompany && (target || proposed)) out.push('COMPANY_NOT_PERMITTED_FOR_CLASSIFICATION');
  if (target && proposed) out.push('TARGET_AND_PROPOSAL_BOTH_GIVEN');
  if (proposed && proposed.length > COMPANY_NAME_MAX) out.push('PROPOSED_NAME_TOO_LONG');
  if (proposed && crmContactPointReasonCarriesContactValue(proposed)) out.push('PROPOSED_NAME_CARRIES_CONTACT_VALUE');
  if ((repParty || repRoute) && !CRM_IMPORT_REPRESENTING_ROUTES.includes(c)) out.push('REPRESENTED_BRAND_NOT_PERMITTED_FOR_CLASSIFICATION');
  if (repParty && repRoute) out.push('REPRESENTED_BRAND_GIVEN_TWICE');
  if (repRoute && repRoute === crmImportKey(route.routeKey)) out.push('REPRESENTS_ITSELF');
  return out;
}

/** Shape-check one stage-mapping entry. Nothing here decides what any status means. */
export function validateCrmImportStageMapping(entry: Partial<CrmImportStageMappingEntry>): string[] {
  const out: string[] = [];
  if (!crmImportKey(entry.sourceStatus)) out.push('SOURCE_STATUS_REQUIRED');
  if (!(CRM_IMPORT_STATUS_ACTIONS as readonly string[]).includes(entry.action as string)) {
    out.push('UNKNOWN_ACTION');
    return out;
  }
  if (entry.action === 'OPPORTUNITY') {
    if (!['OPEN', 'CLOSED_WON', 'CLOSED_LOST'].includes(entry.category ?? '')) out.push('CATEGORY_REQUIRED');
    const stage = entry.stage?.trim() ?? '';
    if (!stage) out.push('STAGE_REQUIRED');
    else if (stage.length > 120) out.push('STAGE_TOO_LONG');
  } else if (entry.category || entry.stage) {
    out.push('STAGE_NOT_PERMITTED_FOR_ACTION');
  }
  return out;
}

/**
 * Shape-check the whole reviewed configuration, including collisions: two aliases (or routes, or
 * statuses) that normalize to the same key are refused, never resolved by order.
 */
export function validateCrmImportConfig(config: unknown): { ok: true; config: CrmImportConfig } | { ok: false; violations: CrmImportConfigViolation[] } {
  const violations: CrmImportConfigViolation[] = [];
  const c = config as Partial<CrmImportConfig> | null;
  if (!c || typeof c !== 'object' || c.version !== CRM_IMPORT_CONFIG_VERSION) {
    return { ok: false, violations: [{ at: 'version', code: 'UNKNOWN_CONFIG_VERSION' }] };
  }
  const aliases = Array.isArray(c.creatorAliases) ? c.creatorAliases : null;
  const routes = Array.isArray(c.routes) ? c.routes : null;
  const stages = Array.isArray(c.stageMapping) ? c.stageMapping : null;
  if (!aliases) violations.push({ at: 'creatorAliases', code: 'LIST_REQUIRED' });
  if (!routes) violations.push({ at: 'routes', code: 'LIST_REQUIRED' });
  if (!stages) violations.push({ at: 'stageMapping', code: 'LIST_REQUIRED' });

  const collide = (list: readonly unknown[], key: (x: never) => string, at: string) => {
    const seen = new Map<string, number>();
    list.forEach((item, i) => {
      const k = key(item as never);
      if (!k) return;
      if (seen.has(k)) violations.push({ at: `${at}[${i}]`, code: 'KEY_COLLISION' });
      else seen.set(k, i);
    });
  };
  aliases?.forEach((a, i) => {
    if (!crmImportKey(a?.alias)) violations.push({ at: `creatorAliases[${i}]`, code: 'ALIAS_REQUIRED' });
    else if (crmContactPointReasonCarriesContactValue(a.alias)) violations.push({ at: `creatorAliases[${i}]`, code: 'ALIAS_CARRIES_CONTACT_VALUE' });
    if (typeof a?.creatorPartyId !== 'string' || !a.creatorPartyId.trim()) violations.push({ at: `creatorAliases[${i}]`, code: 'CREATOR_PARTY_REQUIRED' });
  });
  if (aliases) collide(aliases, (a: CrmImportCreatorAliasConfig) => crmImportKey(a?.alias), 'creatorAliases');
  routes?.forEach((r, i) => validateCrmImportRoute(r ?? {}).forEach((code) => violations.push({ at: `routes[${i}]`, code })));
  if (routes) {
    collide(routes, (r: CrmImportRouteConfig) => crmImportKey(r?.routeKey), 'routes');
    const byKey = new Map(routes.map((r) => [crmImportKey(r?.routeKey), r] as const));
    routes.forEach((r, i) => {
      const rep = crmImportKey(r?.representedBrandRouteKey);
      if (!rep) return;
      const target = byKey.get(rep);
      if (!target || target.classification !== 'BRAND_COMPANY') violations.push({ at: `routes[${i}]`, code: 'REPRESENTED_ROUTE_NOT_A_BRAND_COMPANY' });
    });
  }
  stages?.forEach((e, i) => validateCrmImportStageMapping(e ?? {}).forEach((code) => violations.push({ at: `stageMapping[${i}]`, code })));
  if (stages) collide(stages, (e: CrmImportStageMappingEntry) => crmImportKey(e?.sourceStatus), 'stageMapping');

  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, config: c as CrmImportConfig };
}

// --- The Opportunity title (decision D) ----------------------------------------------------

/** `<Creator display name> × <Brand Company display name>`. Nothing else is ever appended. */
export function crmImportOpportunityTitle(creatorName: string, brandName: string): string {
  return `${creatorName.trim()} × ${brandName.trim()}`;
}

// --- Outcomes --------------------------------------------------------------------------------

/**
 * Why a row (or the pursuit it feeds) was planned the way it was. Every blocked code is a reason a
 * person must look; none is resolved by guessing.
 */
export const CRM_IMPORT_OUTCOMES = [
  'READY',
  'CONTACTS_ONLY',
  'ALREADY_IMPORTED_UNCHANGED',
  'EXCLUDED_BY_STATUS',
  'INVALID_ROW',
  'DUPLICATE_SOURCE_ROW_KEY',
  'SOURCE_ROW_CHANGED',
  'ROUTE_UNMAPPED',
  'ROUTE_NOT_IMPORTABLE',
  'NO_COMPANY_CONTEXT',
  'COMPANY_NOT_REFERENCEABLE',
  'COMPANY_NAME_REQUIRED',
  'CREATOR_ALIAS_UNMAPPED',
  'CREATOR_NOT_REFERENCEABLE',
  /**
   * The row's status maps to OPPORTUNITY, but the row names no creator. An Opportunity needs a creator,
   * and none is ever invented, so the row is held for review -- its Company, Person and Contact Points
   * too, because its mapping says it belongs to a pursuit that cannot be built.
   */
  'OPPORTUNITY_REQUIRES_CREATOR',
  'STAGE_MAPPING_REQUIRED',
  'STAGE_CONFLICT',
  'CONTACT_VALUE_INVALID',
  'CONTACT_VALUE_CONFLICT',
  'CONTACT_POINT_REVIEW',
  'PERSON_NAME_CONFLICT',
  'PERSON_MATCH_REVIEW',
  'EXISTING_PURSUIT_REVIEW',
] as const;
export type CrmImportOutcome = (typeof CRM_IMPORT_OUTCOMES)[number];

/** Outcomes that are not blocking: nothing about the row needs a person before APPLY. */
export const CRM_IMPORT_CLEAR_OUTCOMES: readonly CrmImportOutcome[] = ['READY', 'CONTACTS_ONLY', 'ALREADY_IMPORTED_UNCHANGED', 'EXCLUDED_BY_STATUS'];
