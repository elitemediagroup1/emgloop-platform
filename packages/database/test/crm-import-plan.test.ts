// The CRM outreach importer's planner (CRM slice 5), as a pure function: no database.
//
// Proves the decided rules row by row: route classification, Company selection only by mapping or
// import key (never a name), the Person rule, Contact Point placement and fail-closed matching, the
// creator x brand pursuit grain and title, the stage-mapping gate, idempotency signals, and
// determinism.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CrmImportSourceRow, CrmImportStageMappingEntry } from '@emgloop/shared';

import { planCrmImport, type CrmImportMatchView, type CrmImportPlanContext, type CrmImportPlanRowInput, type CrmImportRouteView } from '../src/crm-import/crm-import-plan';

let line = 1;
function row(over: Partial<CrmImportSourceRow> & { email?: string | null } = {}): CrmImportSourceRow {
  line += 1;
  return {
    line,
    sourceRowKey: `r-${line}`,
    creatorAlias: 'Trevon Hill',
    routeKey: 'lund',
    sourceStatus: 'Mapped',
    routeName: null,
    brandName: null,
    contactName: null,
    contactNameVerified: false,
    contactKind: null,
    contactTitle: null,
    email: null,
    phone: null,
    sourceNotes: null,
    sourceLastContactedAt: null,
    ...over,
  };
}

/** A row input with the hash taken as the value itself (the planner only compares hashes). */
function input(r: CrmImportSourceRow, fingerprint = `fp-${r.sourceRowKey}`): CrmImportPlanRowInput {
  const values = [
    ...(r.email ? [{ kind: 'EMAIL' as const, normalized: r.email, hash: `h:${r.email}` }] : []),
    ...(r.phone ? [{ kind: 'PHONE' as const, normalized: r.phone, hash: `h:${r.phone}` }] : []),
  ];
  const eligible = r.contactKind === 'INDIVIDUAL' && r.contactNameVerified && Boolean(r.contactName);
  return { row: r, fingerprint, values, invalidValueKinds: [], personKey: eligible ? (r.email ? `email:k:${r.email}` : `row:${r.sourceRowKey}`) : null };
}

const route = (over: Partial<CrmImportRouteView> & Pick<CrmImportRouteView, 'classification'>): CrmImportRouteView => ({
  mappingId: `m-${over.classification}`,
  targetCompany: null,
  proposedCompanyName: null,
  representedBrand: null,
  representedBrandRouteKey: null,
  ...over,
});

const OPEN: CrmImportStageMappingEntry = { sourceStatus: 'Mapped', action: 'OPPORTUNITY', category: 'OPEN', stage: 'Imported' };

function ctx(over: Partial<{ routes: Record<string, CrmImportRouteView>; matches: Record<string, CrmImportMatchView>; stage: CrmImportStageMappingEntry[]; importKeys: Record<string, string>; prior: Record<string, { fingerprint: string; outcome: string }>; existing: Record<string, number>; aliasOk: boolean }> = {}): CrmImportPlanContext {
  const routes = over.routes ?? { lund: route({ classification: 'BRAND_COMPANY', proposedCompanyName: 'Lund Boats' }) };
  return {
    aliases: new Map([['trevon hill', { mappingId: 'a-1', creatorPartyId: 'p_trevon', creatorName: 'Trevon Hill', referenceable: over.aliasOk ?? true }]]),
    routes: new Map(Object.entries(routes)),
    stageMapping: new Map((over.stage ?? [OPEN]).map((e) => [e.sourceStatus.toLowerCase(), e])),
    importKeys: new Map(Object.entries(over.importKeys ?? {})),
    importedCompanies: new Map(Object.values(over.importKeys ?? {}).map((id) => [id, { partyId: id, name: 'Imported Co', referenceable: true }])),
    matches: new Map(Object.entries(over.matches ?? {})),
    priorEntries: new Map(Object.entries(over.prior ?? {})),
    existingPursuits: new Map(Object.entries(over.existing ?? {})),
  };
}

/** Every value NO_MATCH for both Party types, unless overridden. */
function noMatches(rows: CrmImportSourceRow[], extra: Record<string, CrmImportMatchView> = {}): Record<string, CrmImportMatchView> {
  const out: Record<string, CrmImportMatchView> = {};
  for (const r of rows) for (const v of [r.email, r.phone]) if (v) for (const t of ['PERSON', 'COMPANY']) out[`${v.includes('@') ? 'EMAIL' : 'PHONE'}:h:${v}:${t}`] = { outcome: 'NO_MATCH' };
  return { ...out, ...extra };
}

const pat = (over: Partial<CrmImportSourceRow> = {}) => row({ contactName: 'Pat Rivera', contactNameVerified: true, contactKind: 'INDIVIDUAL', email: 'pat@lund.example', ...over });

test('a BRAND_COMPANY route proposes its reviewed Company; a verified individual becomes a Person and PRIMARY_CONTACT; one pursuit', () => {
  const rows = [pat(), row({ email: 'team@lund.example', contactKind: 'ROLE_INBOX' }), row({ email: 'someone@lund.example' })];
  const plan = planCrmImport(rows.map((r) => input(r)), ctx({ matches: noMatches(rows) }));
  assert.deepEqual(plan.rows.map((r) => r.outcome), ['READY', 'READY', 'READY']);
  assert.deepEqual(plan.companies.map((c) => [c.key, c.action, c.name, c.contacts.map((x) => x.classification).sort()]), [['route:lund', 'PROPOSED', 'Lund Boats', ['ROLE_INBOX', 'UNATTRIBUTED']]]);
  assert.deepEqual(plan.persons.map((p) => [p.action, p.name, p.contacts.map((x) => x.classification)]), [['PROPOSED', 'Pat Rivera', ['INDIVIDUAL']]]);
  assert.equal(plan.pursuits.length, 1, 'three contact rows, ONE creator x brand pursuit');
  const [p] = plan.pursuits;
  assert.deepEqual([p!.key, p!.title, p!.category, p!.stage, p!.action, p!.primaryContactKeys], ['p_trevon|route:lund', 'Trevon Hill × Lund Boats', 'OPEN', 'Imported', 'CREATE', ['email:k:pat@lund.example']]);
});

test('an explicit route target is the Company; nothing is matched by name', () => {
  const rows = [row({ email: 'a@x.example' })];
  const target = { classification: 'BRAND_COMPANY' as const, targetCompany: { partyId: 'p_lund', name: 'Lund Boats', referenceable: true } };
  const plan = planCrmImport(rows.map((r) => input(r)), ctx({ routes: { lund: route(target) }, matches: noMatches(rows) }));
  assert.deepEqual(plan.companies.map((c) => [c.key, c.action, c.partyId]), [['party:p_lund', 'EXISTING', 'p_lund']]);
  // Two routes proposing the same NAME are two Companies: a name is never identity.
  const twins = [row({ routeKey: 'one' }), row({ routeKey: 'two' })];
  const named = planCrmImport(twins.map((r) => input(r)), ctx({ routes: { one: route({ classification: 'BRAND_COMPANY', proposedCompanyName: 'Same Name' }), two: route({ classification: 'BRAND_COMPANY', proposedCompanyName: 'Same Name' }) } }));
  assert.deepEqual(named.companies.map((c) => c.key), ['route:one', 'route:two']);
  assert.equal(named.pursuits.length, 2);
});

test('a target Company that is not referenceable blocks; a Company route with no target and no reviewed name blocks', () => {
  const rows = [row()];
  const dead = planCrmImport(rows.map((r) => input(r)), ctx({ routes: { lund: route({ classification: 'BRAND_COMPANY', targetCompany: { partyId: 'p', name: 'X', referenceable: false } }) } }));
  assert.equal(dead.rows[0]!.outcome, 'COMPANY_NOT_REFERENCEABLE');
  const nameless = planCrmImport(rows.map((r) => input(r)), ctx({ routes: { lund: route({ classification: 'BRAND_COMPANY' }) } }));
  assert.equal(nameless.rows[0]!.outcome, 'COMPANY_NAME_REQUIRED');
  assert.deepEqual([nameless.companies, nameless.pursuits.filter((p) => p.action !== 'BLOCKED')], [[], []]);
});

test('each classification: what it may create', () => {
  const brand = route({ classification: 'BRAND_COMPANY', proposedCompanyName: 'Lund Boats' });
  const cases: [string, CrmImportRouteView, string, number, number][] = [
    ['AGENCY with represented brand', route({ classification: 'AGENCY', proposedCompanyName: 'Big Agency', representedBrandRouteKey: 'lund' }), 'READY', 2, 1],
    ['AGENCY alone', route({ classification: 'AGENCY', proposedCompanyName: 'Big Agency' }), 'CONTACTS_ONLY', 1, 0],
    ['PARENT_COMPANY alone', route({ classification: 'PARENT_COMPANY', proposedCompanyName: 'Parent Co' }), 'CONTACTS_ONLY', 1, 0],
    ['ROLE_INBOX_ROUTE with brand', route({ classification: 'ROLE_INBOX_ROUTE', representedBrandRouteKey: 'lund' }), 'READY', 1, 1],
    ['ROLE_INBOX_ROUTE alone', route({ classification: 'ROLE_INBOX_ROUTE' }), 'NO_COMPANY_CONTEXT', 0, 0],
    ['PERSONAL_GENERIC alone', route({ classification: 'PERSONAL_GENERIC' }), 'NO_COMPANY_CONTEXT', 0, 0],
    ['PERSONAL_GENERIC with brand', route({ classification: 'PERSONAL_GENERIC', representedBrandRouteKey: 'lund' }), 'READY', 1, 1],
    ['CREATOR_ROUTE', route({ classification: 'CREATOR_ROUTE' }), 'ROUTE_NOT_IMPORTABLE', 0, 0],
    ['INTERNAL', route({ classification: 'INTERNAL' }), 'ROUTE_NOT_IMPORTABLE', 0, 0],
    ['UNKNOWN', route({ classification: 'UNKNOWN' }), 'ROUTE_NOT_IMPORTABLE', 0, 0],
  ];
  for (const [label, r, outcome, companies, pursuits] of cases) {
    const rows = [row({ routeKey: 'x', email: 'someone@x.example' })];
    const plan = planCrmImport(rows.map((x) => input(x)), ctx({ routes: { lund: brand, x: r }, matches: noMatches(rows) }));
    assert.equal(plan.rows[0]!.outcome, outcome, label);
    assert.equal(plan.companies.length, companies, `${label}: companies`);
    assert.equal(plan.pursuits.filter((p) => p.action !== 'BLOCKED').length, pursuits, `${label}: pursuits`);
  }
  const role = planCrmImport([input(row({ routeKey: 'x', email: 'press@x.example' }))], ctx({ routes: { lund: brand, x: route({ classification: 'ROLE_INBOX_ROUTE', representedBrandRouteKey: 'lund' }) }, matches: noMatches([row({ email: 'press@x.example' })]) }));
  assert.equal(role.rows[0]!.contacts[0]?.classification, 'ROLE_INBOX', 'a role-inbox route attaches its addresses as ROLE_INBOX on the brand');
});

test('an unmapped route blocks everything the row would cause', () => {
  const plan = planCrmImport([input(row({ routeKey: 'nobody-reviewed-this', email: 'a@b.example' }))], ctx());
  assert.deepEqual([plan.rows[0]!.outcome, plan.companies.length, plan.persons.length, plan.pursuits.length], ['ROUTE_UNMAPPED', 0, 0, 0]);
});

test('People: blank, unverified, undeclared or placeholder names stay on the Company; nothing is read from an address', () => {
  const rows = [
    row({ contactName: 'Name not verified', contactNameVerified: true, contactKind: 'INDIVIDUAL', email: 'jane.doe@lund.example' }),
    row({ contactName: 'Jane Doe', contactNameVerified: false, contactKind: 'INDIVIDUAL', email: 'jd@lund.example' }),
    row({ contactName: '', contactNameVerified: true, contactKind: 'INDIVIDUAL', email: 'x@lund.example' }),
  ];
  const plan = planCrmImport(rows.map((r) => input(r)), ctx({ matches: noMatches(rows) }));
  assert.equal(plan.persons.length, 0, 'no Person -- not even from "jane.doe@"');
  assert.deepEqual(plan.rows.map((r) => r.contacts.map((c) => [c.classification, c.targetKey])), [
    [['UNATTRIBUTED', 'route:lund']],
    [['UNATTRIBUTED', 'route:lund']],
    [['UNATTRIBUTED', 'route:lund']],
  ]);
  assert.deepEqual(plan.pursuits[0]!.primaryContactKeys, [], 'no PRIMARY_CONTACT without a governed Person');
});

test('several verified people in one pursuit are several PRIMARY_CONTACTs; the same person in two rows is one Person', () => {
  const rows = [pat(), pat({ sourceRowKey: 'again' }), row({ contactName: 'Sam Lee', contactNameVerified: true, contactKind: 'INDIVIDUAL', email: 'sam@lund.example' })];
  const plan = planCrmImport(rows.map((r) => input(r)), ctx({ matches: noMatches(rows) }));
  assert.equal(plan.persons.length, 2);
  assert.deepEqual(plan.pursuits[0]!.primaryContactKeys, ['email:k:pat@lund.example', 'email:k:sam@lund.example']);
  const renamed = [pat(), pat({ contactName: 'Patricia Rivera' })];
  const conflict = planCrmImport(renamed.map((r) => input(r)), ctx({ matches: noMatches(renamed) }));
  assert.deepEqual(conflict.rows.map((r) => r.outcome), ['PERSON_NAME_CONFLICT', 'PERSON_NAME_CONFLICT']);
  assert.equal(conflict.pursuits[0]!.action, 'BLOCKED');
});

test('Person reuse is an exact Contact Point MATCH only; anything unsettled is review, never a duplicate', () => {
  const rows = [pat()];
  const reuse = planCrmImport(rows.map((r) => input(r)), ctx({ matches: noMatches(rows, { 'EMAIL:h:pat@lund.example:PERSON': { outcome: 'MATCH', partyId: 'p_pat' } }) }));
  assert.deepEqual([reuse.persons[0]!.action, reuse.persons[0]!.partyId, reuse.rows[0]!.contacts[0]!.action], ['EXISTING_BY_CONTACT_POINT', 'p_pat', 'EXISTS']);
  for (const outcome of ['CONFLICT', 'TYPE_MISMATCH', 'PARTY_NOT_REFERENCEABLE', 'INACTIVE_MATCH'] as const) {
    const plan = planCrmImport(rows.map((r) => input(r)), ctx({ matches: noMatches(rows, { 'EMAIL:h:pat@lund.example:PERSON': { outcome } }) }));
    assert.deepEqual([plan.rows[0]!.outcome, plan.rows[0]!.ambiguityCode, plan.persons.length], ['PERSON_MATCH_REVIEW', outcome, 0], outcome);
    assert.equal(plan.pursuits[0]!.action, 'BLOCKED');
  }
});

test('a Company address held by another Party, or a value two rows send to different places, is review', () => {
  const rows = [row({ email: 'shared@x.example' })];
  const held = planCrmImport(rows.map((r) => input(r)), ctx({ matches: noMatches(rows, { 'EMAIL:h:shared@x.example:COMPANY': { outcome: 'MATCH', partyId: 'p_someone_else' } }) }));
  assert.deepEqual([held.rows[0]!.outcome, held.rows[0]!.ambiguityCode], ['CONTACT_POINT_REVIEW', 'HELD_BY_ANOTHER_PARTY']);
  const two = [row({ email: 'dup@x.example', routeKey: 'lund' }), row({ email: 'dup@x.example', routeKey: 'zen' })];
  const conflict = planCrmImport(two.map((r) => input(r)), ctx({ routes: { lund: route({ classification: 'BRAND_COMPANY', proposedCompanyName: 'Lund' }), zen: route({ classification: 'BRAND_COMPANY', proposedCompanyName: 'Zen' }) }, matches: noMatches(two) }));
  assert.deepEqual(conflict.rows.map((r) => r.outcome), ['CONTACT_VALUE_CONFLICT', 'CONTACT_VALUE_CONFLICT']);
  assert.equal(conflict.companies.length, 0);
});

test('the stage gate: an unmapped status blocks every write the row would cause; differing stages in one pursuit block it', () => {
  const rows = [pat()];
  const unmapped = planCrmImport(rows.map((r) => input(r)), ctx({ stage: [], matches: noMatches(rows) }));
  assert.equal(unmapped.rows[0]!.outcome, 'STAGE_MAPPING_REQUIRED');
  assert.deepEqual([unmapped.companies.length, unmapped.persons.length, unmapped.pursuits[0]!.action], [0, 0, 'BLOCKED']);
  for (const status of ['Not due', 'Historical', 'Other hold', 'Human reply–hold', 'Excluded', 'Pending draft']) {
    const plan = planCrmImport([input(row({ sourceStatus: status }))], ctx());
    assert.equal(plan.rows[0]!.outcome, 'STAGE_MAPPING_REQUIRED', `${status} is never a stage by its wording`);
  }
  const split = [row({ sourceStatus: 'A' }), row({ sourceStatus: 'B' })];
  const conflict = planCrmImport(split.map((r) => input(r)), ctx({ stage: [{ sourceStatus: 'A', action: 'OPPORTUNITY', category: 'OPEN', stage: 'One' }, { sourceStatus: 'B', action: 'OPPORTUNITY', category: 'OPEN', stage: 'Two' }] }));
  assert.deepEqual([conflict.rows.map((r) => r.outcome), conflict.pursuits[0]!.blockedBy], [['STAGE_CONFLICT', 'STAGE_CONFLICT'], ['STAGE_CONFLICT']]);
  const excluded = planCrmImport([input(row({ sourceStatus: 'X' }))], ctx({ stage: [{ sourceStatus: 'X', action: 'EXCLUDE' }] }));
  assert.deepEqual([excluded.rows[0]!.outcome, excluded.companies.length, excluded.pursuits.length], ['EXCLUDED_BY_STATUS', 0, 0]);
  const contactsOnly = planCrmImport([input(row({ sourceStatus: 'C', email: 'c@lund.example' }))], ctx({ stage: [{ sourceStatus: 'C', action: 'CONTACTS_ONLY' }], matches: noMatches([row({ email: 'c@lund.example' })]) }));
  assert.deepEqual([contactsOnly.rows[0]!.outcome, contactsOnly.companies.length, contactsOnly.pursuits.length], ['CONTACTS_ONLY', 1, 0]);
});

test('the creator: an unmapped alias blocks the pursuit only; an unreferenceable creator blocks it too', () => {
  const rows = [row({ creatorAlias: 'Somebody Unmapped', email: 'a@lund.example' })];
  const plan = planCrmImport(rows.map((r) => input(r)), ctx({ matches: noMatches(rows) }));
  assert.deepEqual([plan.rows[0]!.outcome, plan.companies.length, plan.pursuits.length], ['CREATOR_ALIAS_UNMAPPED', 1, 0], 'its Company and addresses are still governed facts');
  const dead = planCrmImport([input(row())], ctx({ aliasOk: false }));
  assert.deepEqual([dead.rows[0]!.outcome, dead.pursuits[0]!.action], ['CREATOR_NOT_REFERENCEABLE', 'BLOCKED']);
});

test('idempotency signals: import keys resolve proposals; an unchanged applied row is skipped; a changed one is review', () => {
  const rows = [pat()];
  const keys = { 'COMPANY:route:lund': 'p_lund', 'PERSON:email:k:pat@lund.example': 'p_pat', 'OPPORTUNITY:p_trevon|p_lund': 'o_1' };
  const matches = noMatches(rows, { 'EMAIL:h:pat@lund.example:PERSON': { outcome: 'MATCH', partyId: 'p_pat' } });
  const again = planCrmImport(rows.map((r) => input(r)), ctx({ importKeys: keys, matches }));
  assert.deepEqual([again.companies[0]!.key, again.companies[0]!.action], ['party:p_lund', 'IMPORTED']);
  assert.deepEqual([again.persons[0]!.action, again.rows[0]!.contacts[0]!.action], ['IMPORTED', 'EXISTS']);
  assert.deepEqual([again.pursuits[0]!.action, again.pursuits[0]!.opportunityId], ['RECONCILE', 'o_1']);

  const done = planCrmImport([input(rows[0]!)], ctx({ prior: { [rows[0]!.sourceRowKey]: { fingerprint: `fp-${rows[0]!.sourceRowKey}`, outcome: 'READY' } } }));
  assert.deepEqual([done.rows[0]!.outcome, done.companies.length, done.pursuits.length], ['ALREADY_IMPORTED_UNCHANGED', 0, 0]);
  const changed = planCrmImport([input(rows[0]!, 'fp-different')], ctx({ prior: { [rows[0]!.sourceRowKey]: { fingerprint: `fp-${rows[0]!.sourceRowKey}`, outcome: 'READY' } } }));
  assert.deepEqual([changed.rows[0]!.outcome, changed.companies.length], ['SOURCE_ROW_CHANGED', 0], 'never silently updated');
});

test('an Opportunity that already exists for the creator x brand (not by import) is review, never a second one', () => {
  const rows = [row()];
  const target = route({ classification: 'BRAND_COMPANY', targetCompany: { partyId: 'p_lund', name: 'Lund Boats', referenceable: true } });
  const plan = planCrmImport(rows.map((r) => input(r)), ctx({ routes: { lund: target }, existing: { 'p_trevon|p_lund': 1 } }));
  assert.deepEqual([plan.rows[0]!.outcome, plan.pursuits[0]!.action], ['EXISTING_PURSUIT_REVIEW', 'BLOCKED']);
});

test('duplicated source row keys are all refused', () => {
  const a = row();
  const plan = planCrmImport([input(a), input({ ...a, line: a.line + 100 })], ctx());
  assert.deepEqual(plan.rows.map((r) => r.outcome), ['DUPLICATE_SOURCE_ROW_KEY', 'DUPLICATE_SOURCE_ROW_KEY']);
});

test('deterministic: the same input in any order yields the same plan', () => {
  const rows = [pat(), row({ email: 'team@lund.example', contactKind: 'ROLE_INBOX' }), row({ creatorAlias: 'Nobody' }), row({ routeKey: 'unmapped' })];
  const c = ctx({ matches: noMatches(rows) });
  const one = planCrmImport(rows.map((r) => input(r)), c);
  const two = planCrmImport([...rows].reverse().map((r) => input(r)), c);
  assert.deepEqual(one, two);
});
