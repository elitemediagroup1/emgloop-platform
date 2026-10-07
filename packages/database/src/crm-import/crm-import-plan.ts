// The CRM outreach importer's planner (CRM slice 5). PURE: no I/O, no clock, no randomness.
//
// Given the parsed source rows and everything the database already answered -- the reviewed
// creator aliases and route classifications, the stage mapping, the keys of subjects earlier
// APPLYs created, exact Contact Point match outcomes, earlier entries -- it decides, row by row,
// what would be created, reused, linked or blocked. The same input always yields the same plan.
//
// THE RULES IT APPLIES (decisions 2026-10-07):
//   - A Company is selected only by a reviewed route mapping (its explicit target) or by an
//     earlier APPLY's import key; a Company route with neither PROPOSES a Company under the
//     reviewer's name for it. No name, domain or fuzzy matching exists anywhere.
//   - A Person is proposed only for a declared INDIVIDUAL with a verified, real name, and is reused
//     only by an exact Contact Point MATCH or an earlier import key. Never from an email address.
//   - Every value attaches through the Contact Point authority: INDIVIDUAL to the Person,
//     ROLE_INBOX or UNATTRIBUTED to the Company. A value two rows send to different places, or that
//     the exact match cannot settle, is a review item -- never a guess, never a duplicate.
//   - A row without a creator (v2: `creator_alias` is optional) may import its governed Company, Person
//     and Contact Points when its status allows it (CONTACTS_ONLY), but NEVER an Opportunity. If its
//     status maps to OPPORTUNITY it is OPPORTUNITY_REQUIRES_CREATOR: held whole, for review. No creator
//     is ever inferred.
//   - One Opportunity per creator x governed brand Company. Several rows of one pursuit are one
//     Opportunity; their verified People are its PRIMARY_CONTACTs (all of them). Title:
//     `<Creator> × <Brand>`. No Relationship, no owner, nothing creator-visible.
//   - A status with no reviewed mapping blocks every write the row would cause
//     (STAGE_MAPPING_REQUIRED); rows of one pursuit that map to different stages block it.
//   - No AFFILIATION, from anything. A PRIMARY_CONTACT is the contact for this Opportunity only.

import {
  CRM_IMPORT_CLEAR_OUTCOMES,
  CRM_IMPORT_COMPANY_ROUTES,
  CRM_IMPORT_INERT_ROUTES,
  crmImportKey,
  crmImportOpportunityTitle,
  crmImportPersonEligible,
  type CrmContactPointClassification,
  type CrmContactPointKind,
  type CrmImportOutcome,
  type CrmImportRouteClassification,
  type CrmImportSourceRow,
  type CrmImportStageMappingEntry,
} from '@emgloop/shared';

// --- Inputs ----------------------------------------------------------------------------------

export interface CrmImportPlanValue {
  readonly kind: CrmContactPointKind;
  /** Normalized by the Contact Point authority's own rule. In memory only; never persisted here. */
  readonly normalized: string;
  /** The Contact Point keyed hash: how two rows' values are compared, and how matches are looked up. */
  readonly hash: string;
}

export interface CrmImportPlanRowInput {
  readonly row: CrmImportSourceRow;
  /** Keyed fingerprint of the row's canonical contents. */
  readonly fingerprint: string;
  readonly values: readonly CrmImportPlanValue[];
  /** Kinds whose source value failed the Contact Point authority's normalization. */
  readonly invalidValueKinds: readonly CrmContactPointKind[];
  /** The deterministic Person key, when the row is Person-eligible: `email:<h>` | `phone:<h>` | `row:<rowKey>`. */
  readonly personKey: string | null;
}

export interface CrmImportCompanyView {
  readonly partyId: string;
  readonly name: string | null;
  /** Established, current, not archived, and a COMPANY -- by the Party Reference contract. */
  readonly referenceable: boolean;
}

export interface CrmImportRouteView {
  readonly mappingId: string;
  readonly classification: CrmImportRouteClassification;
  readonly targetCompany: CrmImportCompanyView | null;
  readonly proposedCompanyName: string | null;
  readonly representedBrand: CrmImportCompanyView | null;
  readonly representedBrandRouteKey: string | null;
}

export interface CrmImportAliasView {
  readonly mappingId: string;
  readonly creatorPartyId: string;
  readonly creatorName: string | null;
  /** Established, current, not archived, and a PERSON. */
  readonly referenceable: boolean;
}

export type CrmImportMatchView =
  | { readonly outcome: 'MATCH'; readonly partyId: string }
  | { readonly outcome: 'NO_MATCH' | 'CONFLICT' | 'TYPE_MISMATCH' | 'PARTY_NOT_REFERENCEABLE' | 'INACTIVE_MATCH' | 'INVALID' };

export interface CrmImportPlanContext {
  readonly aliases: ReadonlyMap<string, CrmImportAliasView>;
  readonly routes: ReadonlyMap<string, CrmImportRouteView>;
  readonly stageMapping: ReadonlyMap<string, CrmImportStageMappingEntry>;
  /** `<KIND>:<keyValue>` -> subject id, for subjects earlier APPLYs created. */
  readonly importKeys: ReadonlyMap<string, string>;
  /** Names of Companies resolved through import keys (proposals that already became Parties). */
  readonly importedCompanies: ReadonlyMap<string, CrmImportCompanyView>;
  /** `<kind>:<hash>:<PERSON|COMPANY>` -> the Contact Point authority's exact match outcome. */
  readonly matches: ReadonlyMap<string, CrmImportMatchView>;
  /** The latest applied entry per source row key. */
  readonly priorEntries: ReadonlyMap<string, { readonly fingerprint: string | null; readonly outcome: string }>;
  /** `<creatorPartyId>|<brandPartyId>` -> Opportunities that exist but were not created by an import key. */
  readonly existingPursuits: ReadonlyMap<string, number>;
}

// --- Outputs ---------------------------------------------------------------------------------

export type CrmImportContactAction = 'ADD' | 'EXISTS' | 'REVIEW';

export interface CrmImportPlannedContact {
  readonly kind: CrmContactPointKind;
  readonly classification: CrmContactPointClassification;
  readonly action: CrmImportContactAction;
  /** `party:<id>` | `route:<routeKey>` | `person:<personKey>`. */
  readonly targetKey: string;
  readonly hash: string;
  readonly ambiguity: string | null;
}

export interface CrmImportPlannedRow {
  readonly line: number;
  readonly sourceRowKey: string;
  readonly fingerprint: string;
  readonly routeMappingId: string | null;
  readonly routeClassification: CrmImportRouteClassification | null;
  readonly creatorAliasId: string | null;
  readonly creatorPartyId: string | null;
  readonly companyKey: string | null;
  readonly companyAction: 'EXISTING' | 'PROPOSED' | 'IMPORTED' | null;
  /** The Company's recorded name, or the reviewer's name for a proposal. Never the source's brand text. */
  readonly companyName: string | null;
  readonly personKey: string | null;
  readonly personAction: 'PROPOSED' | 'EXISTING_BY_CONTACT_POINT' | 'IMPORTED' | 'REVIEW' | null;
  readonly contacts: readonly CrmImportPlannedContact[];
  readonly pursuitKey: string | null;
  readonly opportunityAction: 'CREATE' | 'RECONCILE' | 'BLOCKED' | 'NONE';
  readonly outcome: CrmImportOutcome;
  readonly ambiguityCode: string | null;
  /** Whether this row's Company, Person and Contact Points may be written in an APPLY. */
  readonly subjectsApplicable: boolean;
}

export interface CrmImportPlannedCompany {
  readonly key: string;
  readonly action: 'EXISTING' | 'PROPOSED' | 'IMPORTED';
  readonly partyId: string | null;
  readonly routeKey: string | null;
  readonly name: string | null;
  readonly contacts: readonly CrmImportPlannedContact[];
  readonly lines: readonly number[];
}

export interface CrmImportPlannedPerson {
  readonly key: string;
  readonly action: 'PROPOSED' | 'EXISTING_BY_CONTACT_POINT' | 'IMPORTED';
  readonly partyId: string | null;
  readonly name: string;
  readonly contacts: readonly CrmImportPlannedContact[];
  readonly lines: readonly number[];
}

export interface CrmImportPlannedPursuit {
  readonly key: string;
  readonly creatorPartyId: string;
  readonly brandKey: string;
  readonly title: string | null;
  readonly category: string | null;
  readonly stage: string | null;
  readonly action: 'CREATE' | 'RECONCILE' | 'BLOCKED';
  readonly opportunityId: string | null;
  readonly blockedBy: readonly CrmImportOutcome[];
  readonly primaryContactKeys: readonly string[];
  readonly lines: readonly number[];
}

export interface CrmImportPlan {
  readonly rows: readonly CrmImportPlannedRow[];
  /** Units an APPLY may execute (blocked ones are excluded). */
  readonly companies: readonly CrmImportPlannedCompany[];
  readonly persons: readonly CrmImportPlannedPerson[];
  readonly pursuits: readonly CrmImportPlannedPursuit[];
  readonly counts: Readonly<Record<string, number>>;
}

// --- Planning --------------------------------------------------------------------------------

const ROW_PRECEDENCE: readonly CrmImportOutcome[] = [
  'ALREADY_IMPORTED_UNCHANGED',
  'SOURCE_ROW_CHANGED',
  'EXCLUDED_BY_STATUS',
  'ROUTE_UNMAPPED',
  'ROUTE_NOT_IMPORTABLE',
  'NO_COMPANY_CONTEXT',
  'COMPANY_NOT_REFERENCEABLE',
  'COMPANY_NAME_REQUIRED',
  'CONTACT_VALUE_INVALID',
  'CONTACT_VALUE_CONFLICT',
  'PERSON_NAME_CONFLICT',
  'PERSON_MATCH_REVIEW',
  'CONTACT_POINT_REVIEW',
  'OPPORTUNITY_REQUIRES_CREATOR',
  'STAGE_MAPPING_REQUIRED',
  'CREATOR_ALIAS_UNMAPPED',
  'CREATOR_NOT_REFERENCEABLE',
  'STAGE_CONFLICT',
  'EXISTING_PURSUIT_REVIEW',
];

/** Blocks the row's Company, Person and Contact Points (everything before the pursuit-only codes). */
const SUBJECT_BLOCKERS: readonly CrmImportOutcome[] = ROW_PRECEDENCE.slice(0, ROW_PRECEDENCE.indexOf('STAGE_MAPPING_REQUIRED') + 1);

interface Working {
  input: CrmImportPlanRowInput;
  codes: Set<CrmImportOutcome>;
  ambiguity: string | null;
  route: CrmImportRouteView | null;
  status: CrmImportStageMappingEntry | null;
  companyKey: string | null;
  company: { action: 'EXISTING' | 'PROPOSED' | 'IMPORTED'; partyId: string | null; routeKey: string | null; name: string | null } | null;
  brandKey: string | null;
  brand: { partyId: string | null; name: string | null } | null;
  alias: CrmImportAliasView | null;
  person: boolean;
  classification: CrmContactPointClassification;
  contacts: CrmImportPlannedContact[];
}

const matchKey = (kind: string, hash: string, partyType: 'PERSON' | 'COMPANY') => `${kind}:${hash}:${partyType}`;

export function planCrmImport(inputs: readonly CrmImportPlanRowInput[], ctx: CrmImportPlanContext): CrmImportPlan {
  // Rows sharing a source row key are all refused: the key is the row's identity across exports.
  const keyCount = new Map<string, number>();
  for (const i of inputs) keyCount.set(i.row.sourceRowKey, (keyCount.get(i.row.sourceRowKey) ?? 0) + 1);

  const duplicates: CrmImportPlannedRow[] = [];
  const work: Working[] = [];
  for (const input of [...inputs].sort((a, b) => a.row.line - b.row.line)) {
    if ((keyCount.get(input.row.sourceRowKey) ?? 0) > 1) {
      duplicates.push(blankRow(input, 'DUPLICATE_SOURCE_ROW_KEY'));
      continue;
    }
    work.push(resolveRow(input, ctx));
  }

  // People: one per Person key; the same key must carry the same name.
  const personRows = new Map<string, Working[]>();
  for (const w of work) {
    if (w.person && w.input.personKey && subjectClear(w)) push(personRows, w.input.personKey, w);
  }
  const persons = new Map<string, { action: CrmImportPlannedPerson['action'] | 'REVIEW'; partyId: string | null; name: string; ambiguity: string | null }>();
  for (const [key, rows] of personRows) {
    const names = new Set(rows.map((w) => crmImportKey(w.input.row.contactName)));
    if (names.size > 1) {
      for (const w of rows) w.codes.add('PERSON_NAME_CONFLICT');
      continue;
    }
    const name = rows[0]!.input.row.contactName!.trim();
    const imported = ctx.importKeys.get(`PERSON:${key}`);
    if (imported) {
      persons.set(key, { action: 'IMPORTED', partyId: imported, name, ambiguity: null });
      continue;
    }
    const values = uniqueValues(rows.flatMap((w) => w.input.values));
    const outcomes = values.map((v) => ctx.matches.get(matchKey(v.kind, v.hash, 'PERSON')) ?? { outcome: 'INVALID' as const });
    const matched = [...new Set(outcomes.flatMap((o) => (o.outcome === 'MATCH' ? [o.partyId] : [])))];
    const unsettled = outcomes.find((o) => o.outcome !== 'MATCH' && o.outcome !== 'NO_MATCH');
    if (unsettled || matched.length > 1) {
      const ambiguity = unsettled ? unsettled.outcome : 'MATCHES_DIFFERENT_PEOPLE';
      persons.set(key, { action: 'REVIEW', partyId: null, name, ambiguity });
      for (const w of rows) {
        w.codes.add('PERSON_MATCH_REVIEW');
        w.ambiguity ??= ambiguity;
      }
      continue;
    }
    persons.set(key, matched.length === 1 ? { action: 'EXISTING_BY_CONTACT_POINT', partyId: matched[0]!, name, ambiguity: null } : { action: 'PROPOSED', partyId: null, name, ambiguity: null });
  }

  // Contact Points: each value has exactly one intended target and classification, or it is a review item.
  const valueTargets = new Map<string, { target: string; classification: CrmContactPointClassification; rows: Working[] }[]>();
  for (const w of work) {
    if (!subjectClear(w)) continue;
    const target = w.person && w.input.personKey ? `person:${w.input.personKey}` : w.companyKey;
    if (!target) continue;
    for (const v of w.input.values) {
      const list = valueTargets.get(`${v.kind}:${v.hash}`) ?? [];
      const existing = list.find((t) => t.target === target && t.classification === w.classification);
      if (existing) existing.rows.push(w);
      else list.push({ target, classification: w.classification, rows: [w] });
      valueTargets.set(`${v.kind}:${v.hash}`, list);
    }
  }
  for (const [valueKey, targets] of valueTargets) {
    const [kind, hash] = splitOnce(valueKey) as [CrmContactPointKind, string];
    if (targets.length > 1) {
      for (const t of targets) for (const w of t.rows) w.codes.add('CONTACT_VALUE_CONFLICT');
      continue;
    }
    const { target, classification, rows } = targets[0]!;
    const planned = plannedContact(kind, hash, target, classification, ctx, persons);
    for (const w of rows) {
      w.contacts.push(planned);
      if (planned.action === 'REVIEW') {
        w.codes.add('CONTACT_POINT_REVIEW');
        w.ambiguity ??= planned.ambiguity;
      }
    }
  }

  // Pursuits: creator x governed brand, from rows whose status maps to an Opportunity.
  const pursuitRows = new Map<string, Working[]>();
  for (const w of work) {
    if (!w.alias || !w.brandKey || !w.brand) continue;
    if (w.status?.action === 'EXCLUDE' || w.status?.action === 'CONTACTS_ONLY') continue;
    if (w.codes.has('ALREADY_IMPORTED_UNCHANGED') || w.codes.has('SOURCE_ROW_CHANGED')) continue;
    push(pursuitRows, `${w.alias.creatorPartyId}|${w.brandKey}`, w);
  }
  const pursuits: CrmImportPlannedPursuit[] = [];
  for (const [key, rows] of [...pursuitRows].sort(([a], [b]) => a.localeCompare(b))) {
    const first = rows[0]!;
    const alias = first.alias!;
    const brand = first.brand!;
    const blockedBy = new Set<CrmImportOutcome>();
    if (!alias.referenceable || !alias.creatorName) blockedBy.add('CREATOR_NOT_REFERENCEABLE');
    for (const w of rows) for (const code of w.codes) if (SUBJECT_BLOCKERS.includes(code)) blockedBy.add(code);
    const stages = new Set(rows.filter((w) => w.status?.action === 'OPPORTUNITY').map((w) => `${w.status!.category}\u0000${w.status!.stage!.trim()}`));
    if (stages.size > 1) blockedBy.add('STAGE_CONFLICT');
    if (!brand.name) blockedBy.add('COMPANY_NAME_REQUIRED');

    let action: CrmImportPlannedPursuit['action'] = 'CREATE';
    let opportunityId: string | null = null;
    if (brand.partyId) {
      const imported = ctx.importKeys.get(`OPPORTUNITY:${alias.creatorPartyId}|${brand.partyId}`);
      if (imported) {
        action = 'RECONCILE';
        opportunityId = imported;
      } else if ((ctx.existingPursuits.get(`${alias.creatorPartyId}|${brand.partyId}`) ?? 0) > 0) {
        blockedBy.add('EXISTING_PURSUIT_REVIEW');
      }
    }
    const [stageEntry] = rows.filter((w) => w.status?.action === 'OPPORTUNITY').map((w) => w.status!);
    const primaryContactKeys = [...new Set(rows.filter((w) => w.person && w.input.personKey).map((w) => w.input.personKey!))].sort();
    const ordered = [...blockedBy].sort((a, b) => ROW_PRECEDENCE.indexOf(a) - ROW_PRECEDENCE.indexOf(b));
    for (const w of rows) {
      if (ordered.includes('STAGE_CONFLICT')) w.codes.add('STAGE_CONFLICT');
      if (ordered.includes('EXISTING_PURSUIT_REVIEW')) w.codes.add('EXISTING_PURSUIT_REVIEW');
      if (ordered.includes('CREATOR_NOT_REFERENCEABLE')) w.codes.add('CREATOR_NOT_REFERENCEABLE');
      if (ordered.includes('COMPANY_NAME_REQUIRED')) w.codes.add('COMPANY_NAME_REQUIRED');
    }
    pursuits.push({
      key,
      creatorPartyId: alias.creatorPartyId,
      brandKey: first.brandKey!,
      title: alias.creatorName && brand.name ? crmImportOpportunityTitle(alias.creatorName, brand.name) : null,
      category: stageEntry?.category ?? null,
      stage: stageEntry?.stage?.trim() ?? null,
      action: ordered.length > 0 ? 'BLOCKED' : action,
      opportunityId,
      blockedBy: ordered,
      primaryContactKeys,
      lines: rows.map((w) => w.input.row.line),
    });
  }
  const pursuitByKey = new Map(pursuits.map((p) => [p.key, p]));

  // Rows.
  const rows: CrmImportPlannedRow[] = [
    ...duplicates,
    ...work.map((w): CrmImportPlannedRow => {
      const outcome = rowOutcome(w);
      const pursuitKey = w.alias && w.brandKey ? `${w.alias.creatorPartyId}|${w.brandKey}` : null;
      const pursuit = pursuitKey ? pursuitByKey.get(pursuitKey) : undefined;
      const person = w.person && w.input.personKey ? persons.get(w.input.personKey) : undefined;
      return {
        line: w.input.row.line,
        sourceRowKey: w.input.row.sourceRowKey,
        fingerprint: w.input.fingerprint,
        routeMappingId: w.route?.mappingId ?? null,
        routeClassification: w.route?.classification ?? null,
        creatorAliasId: w.alias?.mappingId ?? null,
        creatorPartyId: w.alias?.creatorPartyId ?? null,
        companyKey: w.companyKey,
        companyAction: w.company?.action ?? null,
        companyName: w.company?.name ?? null,
        personKey: w.person ? w.input.personKey : null,
        personAction: person ? person.action : w.person ? 'REVIEW' : null,
        contacts: w.contacts,
        pursuitKey: pursuit ? pursuitKey : null,
        opportunityAction: !pursuit ? 'NONE' : pursuit.action,
        outcome,
        ambiguityCode: w.ambiguity,
        subjectsApplicable: subjectClear(w) && (w.codes.size === 0 || [...w.codes].every((c) => !SUBJECT_BLOCKERS.includes(c))),
      };
    }),
  ].sort((a, b) => a.line - b.line);

  // Units an APPLY may execute: only what clear rows (or ready pursuits) need.
  const applicable = work.filter((w) => rows.find((r) => r.line === w.input.row.line)?.subjectsApplicable);
  const readyPursuits = pursuits.filter((p) => p.action !== 'BLOCKED');
  const companies = new Map<string, CrmImportPlannedCompany>();
  const addCompany = (key: string, w: Working | null, company: Working['company'] | { action: 'EXISTING' | 'PROPOSED' | 'IMPORTED'; partyId: string | null; routeKey: string | null; name: string | null }) => {
    if (!company) return;
    const current = companies.get(key) ?? { key, action: company.action, partyId: company.partyId, routeKey: company.routeKey, name: company.name, contacts: [], lines: [] };
    companies.set(key, {
      ...current,
      contacts: w ? mergeContacts(current.contacts, w.contacts.filter((c) => c.targetKey === key && c.action === 'ADD')) : current.contacts,
      lines: w ? [...new Set([...current.lines, w.input.row.line])].sort((a, b) => a - b) : current.lines,
    });
  };
  for (const w of applicable) if (w.companyKey) addCompany(w.companyKey, w, w.company);
  for (const p of readyPursuits) {
    const brandRow = work.find((w) => w.brandKey === p.brandKey)!;
    addCompany(p.brandKey, null, brandCompany(brandRow));
  }
  const personUnits = new Map<string, CrmImportPlannedPerson>();
  for (const w of applicable) {
    if (!w.person || !w.input.personKey) continue;
    const p = persons.get(w.input.personKey);
    if (!p || p.action === 'REVIEW') continue;
    const key = w.input.personKey;
    const current = personUnits.get(key) ?? { key, action: p.action, partyId: p.partyId, name: p.name, contacts: [], lines: [] };
    personUnits.set(key, {
      ...current,
      contacts: mergeContacts(current.contacts, w.contacts.filter((c) => c.targetKey === `person:${key}` && c.action === 'ADD')),
      lines: [...new Set([...current.lines, w.input.row.line])].sort((a, b) => a - b),
    });
  }

  return {
    rows,
    companies: [...companies.values()].sort((a, b) => a.key.localeCompare(b.key)),
    persons: [...personUnits.values()].sort((a, b) => a.key.localeCompare(b.key)),
    pursuits,
    counts: countPlan(rows, [...companies.values()], [...personUnits.values()], pursuits, inputs.length),
  };
}

// --- Row resolution --------------------------------------------------------------------------

function resolveRow(input: CrmImportPlanRowInput, ctx: CrmImportPlanContext): Working {
  const { row } = input;
  const w: Working = {
    input,
    codes: new Set(),
    ambiguity: null,
    route: null,
    status: null,
    companyKey: null,
    company: null,
    brandKey: null,
    brand: null,
    alias: null,
    person: crmImportPersonEligible(row),
    classification: 'UNATTRIBUTED',
    contacts: [],
  };

  const prior = ctx.priorEntries.get(row.sourceRowKey);
  if (prior) {
    if (prior.fingerprint !== input.fingerprint) {
      w.codes.add('SOURCE_ROW_CHANGED');
      return w;
    }
    if ((CRM_IMPORT_CLEAR_OUTCOMES as readonly string[]).includes(prior.outcome)) {
      w.codes.add('ALREADY_IMPORTED_UNCHANGED');
      return w;
    }
    // Applied earlier with something still blocked: planned again, idempotently.
  }

  w.status = ctx.stageMapping.get(crmImportKey(row.sourceStatus)) ?? null;
  if (w.status?.action === 'EXCLUDE') {
    w.codes.add('EXCLUDED_BY_STATUS');
    return w;
  }

  w.route = ctx.routes.get(crmImportKey(row.routeKey)) ?? null;
  if (!w.route) {
    w.codes.add('ROUTE_UNMAPPED');
    return w;
  }
  if (CRM_IMPORT_INERT_ROUTES.includes(w.route.classification)) {
    w.codes.add('ROUTE_NOT_IMPORTABLE');
    return w;
  }

  // The Company this row's addresses belong to, and the brand its pursuit is with.
  const own = CRM_IMPORT_COMPANY_ROUTES.includes(w.route.classification) ? ownCompany(crmImportKey(row.routeKey), w.route, ctx) : null;
  const represented = representedBrand(w.route, ctx);
  if (own && 'code' in own) w.codes.add(own.code);
  if (represented && 'code' in represented) w.codes.add(represented.code);
  const ownOk = own && !('code' in own) ? own : null;
  const repOk = represented && !('code' in represented) ? represented : null;
  const contactCompany = ownOk ?? repOk;
  if (!contactCompany && w.codes.size === 0) w.codes.add('NO_COMPANY_CONTEXT');
  if (contactCompany) {
    w.companyKey = contactCompany.key;
    w.company = contactCompany.company;
  }
  const brand = w.route.classification === 'BRAND_COMPANY' ? ownOk : repOk;
  if (brand) {
    w.brandKey = brand.key;
    w.brand = { partyId: brand.company.partyId, name: brand.company.name };
  }

  w.classification = w.person ? 'INDIVIDUAL' : row.contactKind === 'ROLE_INBOX' || w.route.classification === 'ROLE_INBOX_ROUTE' ? 'ROLE_INBOX' : 'UNATTRIBUTED';
  if (input.invalidValueKinds.length > 0) {
    w.codes.add('CONTACT_VALUE_INVALID');
    w.ambiguity = `INVALID_${input.invalidValueKinds.join('_')}`;
  }

  if (!w.status) w.codes.add('STAGE_MAPPING_REQUIRED');
  if (row.creatorAlias === null) {
    // No creator: never inferred. Contacts may proceed; an Opportunity cannot.
    if (w.status?.action === 'OPPORTUNITY') w.codes.add('OPPORTUNITY_REQUIRES_CREATOR');
    return w;
  }
  const alias = ctx.aliases.get(crmImportKey(row.creatorAlias)) ?? null;
  if (!alias) w.codes.add('CREATOR_ALIAS_UNMAPPED');
  else {
    w.alias = alias;
    if (!alias.referenceable || !alias.creatorName) w.codes.add('CREATOR_NOT_REFERENCEABLE');
  }
  return w;
}

type CompanyResolution = { key: string; company: NonNullable<Working['company']> } | { code: CrmImportOutcome };

function ownCompany(routeKey: string, route: CrmImportRouteView, ctx: CrmImportPlanContext): CompanyResolution {
  if (route.targetCompany) {
    return route.targetCompany.referenceable
      ? { key: `party:${route.targetCompany.partyId}`, company: { action: 'EXISTING', partyId: route.targetCompany.partyId, routeKey: null, name: route.targetCompany.name } }
      : { code: 'COMPANY_NOT_REFERENCEABLE' };
  }
  const imported = ctx.importKeys.get(`COMPANY:route:${routeKey}`);
  if (imported) {
    const view = ctx.importedCompanies.get(imported);
    if (!view?.referenceable) return { code: 'COMPANY_NOT_REFERENCEABLE' };
    return { key: `party:${imported}`, company: { action: 'IMPORTED', partyId: imported, routeKey, name: view.name } };
  }
  if (!route.proposedCompanyName?.trim()) return { code: 'COMPANY_NAME_REQUIRED' };
  return { key: `route:${routeKey}`, company: { action: 'PROPOSED', partyId: null, routeKey, name: route.proposedCompanyName.trim() } };
}

function representedBrand(route: CrmImportRouteView, ctx: CrmImportPlanContext): CompanyResolution | null {
  if (route.representedBrand) {
    return route.representedBrand.referenceable
      ? { key: `party:${route.representedBrand.partyId}`, company: { action: 'EXISTING', partyId: route.representedBrand.partyId, routeKey: null, name: route.representedBrand.name } }
      : { code: 'COMPANY_NOT_REFERENCEABLE' };
  }
  if (route.representedBrandRouteKey) {
    const brandRoute = ctx.routes.get(route.representedBrandRouteKey);
    if (!brandRoute || brandRoute.classification !== 'BRAND_COMPANY') return { code: 'ROUTE_UNMAPPED' };
    return ownCompany(route.representedBrandRouteKey, brandRoute, ctx);
  }
  return null;
}

function brandCompany(w: Working): CrmImportPlannedCompany | null {
  if (!w.brandKey || !w.brand) return null;
  const isProposal = w.brandKey.startsWith('route:');
  const imported = !isProposal && w.company?.action === 'IMPORTED' && w.companyKey === w.brandKey;
  return {
    key: w.brandKey,
    action: isProposal ? 'PROPOSED' : imported ? 'IMPORTED' : 'EXISTING',
    partyId: w.brand.partyId,
    routeKey: isProposal ? w.brandKey.slice('route:'.length) : null,
    name: w.brand.name,
    contacts: [],
    lines: [],
  };
}

function plannedContact(
  kind: CrmContactPointKind,
  hash: string,
  target: string,
  classification: CrmContactPointClassification,
  ctx: CrmImportPlanContext,
  persons: ReadonlyMap<string, { action: string; partyId: string | null; ambiguity: string | null }>,
): CrmImportPlannedContact {
  const base = { kind, classification, targetKey: target, hash };
  const partyType = target.startsWith('person:') ? 'PERSON' : 'COMPANY';
  const match = ctx.matches.get(matchKey(kind, hash, partyType)) ?? { outcome: 'INVALID' as const };
  // The Party this value would land on, if it already exists.
  let partyId: string | null = null;
  if (target.startsWith('party:')) partyId = target.slice('party:'.length);
  else if (target.startsWith('person:')) {
    const p = persons.get(target.slice('person:'.length));
    if (!p || p.action === 'REVIEW') return { ...base, action: 'REVIEW', ambiguity: p?.ambiguity ?? 'PERSON_UNRESOLVED' };
    partyId = p.partyId;
  }
  if (match.outcome === 'NO_MATCH') return { ...base, action: 'ADD', ambiguity: null };
  if (match.outcome === 'MATCH') {
    return partyId && match.partyId === partyId ? { ...base, action: 'EXISTS', ambiguity: null } : { ...base, action: 'REVIEW', ambiguity: 'HELD_BY_ANOTHER_PARTY' };
  }
  return { ...base, action: 'REVIEW', ambiguity: match.outcome };
}

// --- Helpers ---------------------------------------------------------------------------------

function subjectClear(w: Working): boolean {
  return ![...w.codes].some((c) => SUBJECT_BLOCKERS.includes(c));
}

function rowOutcome(w: Working): CrmImportOutcome {
  const ordered = ROW_PRECEDENCE.filter((c) => w.codes.has(c));
  if (ordered.length > 0) return ordered[0]!;
  if (w.status?.action === 'CONTACTS_ONLY' || !w.brandKey) return 'CONTACTS_ONLY';
  return 'READY';
}

function blankRow(input: CrmImportPlanRowInput, outcome: CrmImportOutcome): CrmImportPlannedRow {
  return {
    line: input.row.line,
    sourceRowKey: input.row.sourceRowKey,
    fingerprint: input.fingerprint,
    routeMappingId: null,
    routeClassification: null,
    creatorAliasId: null,
    creatorPartyId: null,
    companyKey: null,
    companyAction: null,
    companyName: null,
    personKey: null,
    personAction: null,
    contacts: [],
    pursuitKey: null,
    opportunityAction: 'NONE',
    outcome,
    ambiguityCode: null,
    subjectsApplicable: false,
  };
}

function uniqueValues(values: readonly CrmImportPlanValue[]): CrmImportPlanValue[] {
  const seen = new Map<string, CrmImportPlanValue>();
  for (const v of values) seen.set(`${v.kind}:${v.hash}`, v);
  return [...seen.values()].sort((a, b) => `${a.kind}:${a.hash}`.localeCompare(`${b.kind}:${b.hash}`));
}

function mergeContacts(a: readonly CrmImportPlannedContact[], b: readonly CrmImportPlannedContact[]): CrmImportPlannedContact[] {
  const out = new Map<string, CrmImportPlannedContact>();
  for (const c of [...a, ...b]) out.set(`${c.kind}:${c.hash}`, c);
  return [...out.values()].sort((x, y) => `${x.kind}:${x.hash}`.localeCompare(`${y.kind}:${y.hash}`));
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function splitOnce(s: string): [string, string] {
  const at = s.indexOf(':');
  return [s.slice(0, at), s.slice(at + 1)];
}

function countPlan(
  rows: readonly CrmImportPlannedRow[],
  companies: readonly CrmImportPlannedCompany[],
  persons: readonly CrmImportPlannedPerson[],
  pursuits: readonly CrmImportPlannedPursuit[],
  sourceRows: number,
): Record<string, number> {
  const counts: Record<string, number> = { sourceRows };
  const inc = (k: string, n = 1) => (counts[k] = (counts[k] ?? 0) + n);
  for (const r of rows) {
    inc(`outcome.${r.outcome}`);
    for (const c of r.contacts) inc(`contactPoint.${c.classification}.${c.action}`);
  }
  for (const c of companies) inc(`company.${c.action}`);
  for (const p of persons) inc(`person.${p.action}`);
  for (const p of pursuits) {
    inc(`opportunity.${p.action}`);
    for (const b of p.blockedBy) inc(`opportunity.blockedBy.${b}`);
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}
