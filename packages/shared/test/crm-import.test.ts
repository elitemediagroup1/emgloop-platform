// The CRM outreach importer's pure contract (CRM slice 5): canonical CSV, normalization, the Person
// rule, reviewed configuration and stage-mapping shapes, the act table and the title rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CRM_IMPORT_ACT_ROLES,
  CRM_IMPORT_CONFIG_VERSION,
  CRM_IMPORT_ROUTE_CLASSIFICATIONS,
  CRM_IMPORT_VERSION,
  crmImportActPermitted,
  crmImportKey,
  crmImportOpportunityTitle,
  crmImportPersonEligible,
  parseCrmImportCsv,
  parseCsvRecords,
  validateCrmImportConfig,
  validateCrmImportRoute,
  validateCrmImportStageMapping,
} from '../src/crm-import';

const HEADER = 'source_row_key,creator_alias,route_key,source_status,contact_name,contact_name_verified,contact_kind,email,phone';

test('the importer version is explicit and stable', () => {
  assert.equal(CRM_IMPORT_VERSION, 'crm-outreach-import.v1');
});

test('CSV records: quotes, doubled quotes, CRLF and LF, a BOM, embedded newlines, blank lines', () => {
  const parsed = parseCsvRecords('﻿a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n\n');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.records, [['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', 'z']]);
  assert.deepEqual(parseCsvRecords('a,"open'), { ok: false, problem: 'UNTERMINATED_QUOTE' });
});

test('the header is exact: an unknown, repeated or missing column refuses the whole file', () => {
  assert.deepEqual(parseCrmImportCsv(''), { ok: false, problem: 'EMPTY_FILE' });
  assert.deepEqual(parseCrmImportCsv(`${HEADER},Email\n`), { ok: false, problem: 'UNKNOWN_COLUMN', column: 'Email' });
  assert.deepEqual(parseCrmImportCsv(`${HEADER},email\n`), { ok: false, problem: 'DUPLICATE_COLUMN', column: 'email' });
  assert.deepEqual(parseCrmImportCsv('source_row_key,creator_alias,route_key\n'), { ok: false, problem: 'MISSING_COLUMN', column: 'source_status' });
});

test('rows are shape-checked; a bad row is refused by line, its contents never echoed', () => {
  const csv = [
    HEADER,
    'r-1,Trevon Hill,lund-boats,Not due,Pat Rivera,TRUE,INDIVIDUAL,pat@lund.example,',
    'bad key!,Trevon,lund,Not due,,,,,',
    'r-3,,lund,Not due,,,,,',
    'r-4,Trevon,lund,Not due,,maybe,,,',
    'r-5,Trevon,lund,Not due,,,ROBOT,,',
    'r-6,pat@lund.example,lund,Not due,,,,,',
    'r-7,Trevon,lund',
  ].join('\n');
  const parsed = parseCrmImportCsv(csv);
  assert.ok(parsed.ok);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0], {
    line: 2,
    sourceRowKey: 'r-1',
    creatorAlias: 'Trevon Hill',
    routeKey: 'lund-boats',
    sourceStatus: 'Not due',
    routeName: null,
    brandName: null,
    contactName: 'Pat Rivera',
    contactNameVerified: true,
    contactKind: 'INDIVIDUAL',
    contactTitle: null,
    email: 'pat@lund.example',
    phone: null,
    sourceNotes: null,
    sourceLastContactedAt: null,
  });
  assert.deepEqual(
    parsed.invalid.map((r) => [r.line, r.sourceRowKey, r.violations]),
    [
      [3, null, ['SOURCE_ROW_KEY_INVALID']],
      [4, 'r-3', ['CREATOR_ALIAS_REQUIRED']],
      [5, 'r-4', ['CONTACT_NAME_VERIFIED_INVALID']],
      [6, 'r-5', ['CONTACT_KIND_INVALID']],
      [7, 'r-6', ['KEY_CARRIES_CONTACT_VALUE']],
      [8, 'r-7', ['COLUMN_COUNT_MISMATCH', 'SOURCE_STATUS_REQUIRED']],
    ],
  );
  assert.ok(!JSON.stringify(parsed.invalid).includes('pat@'), 'an invalid row reports codes, never values');
});

test('a source row key with a contact value in it is refused', () => {
  const parsed = parseCrmImportCsv(`${HEADER}\n4155550100,Trevon,lund,Not due,,,,,`);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.invalid[0]?.violations, ['SOURCE_ROW_KEY_INVALID']);
});

test('last contacted is an ISO date or instant, or the row is refused', () => {
  const h = 'source_row_key,creator_alias,route_key,source_status,source_last_contacted_at';
  const parsed = parseCrmImportCsv(`${h}\na,T,r,s,2026-09-01\nb,T,r,s,2026-09-01T10:00:00Z\nc,T,r,s,last week\nd,T,r,s,2026-13-45`);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.rows.map((r) => r.sourceRowKey), ['a', 'b']);
  assert.deepEqual(parsed.invalid.map((r) => r.violations), [['LAST_CONTACTED_AT_INVALID'], ['LAST_CONTACTED_AT_INVALID']]);
});

test('keys normalize by NFKC, trim, whitespace and case only -- never punctuation, accents or similarity', () => {
  assert.equal(crmImportKey('  Trevon   HILL '), 'trevon hill');
  assert.equal(crmImportKey('ＴＲＥＶＯＮ'), 'trevon', 'full-width letters are NFKC-equal');
  assert.notEqual(crmImportKey('Trevon Hill'), crmImportKey('Trevon-Hill'));
  assert.notEqual(crmImportKey("O'Brien"), crmImportKey('OBrien'), 'punctuation is never stripped');
  assert.notEqual(crmImportKey('T.Hill'), crmImportKey('THill'));
  assert.notEqual(crmImportKey('Renée'), crmImportKey('Renee'));
  assert.notEqual(crmImportKey('Trevon'), crmImportKey('Trevon H'));
  assert.equal(crmImportKey(42), '');
});

test('a Person only from a declared INDIVIDUAL with a verified, real name -- never from an address', () => {
  const ok = { contactName: 'Pat Rivera', contactNameVerified: true, contactKind: 'INDIVIDUAL' as const };
  assert.equal(crmImportPersonEligible(ok), true);
  assert.equal(crmImportPersonEligible({ ...ok, contactNameVerified: false }), false, 'unverified');
  assert.equal(crmImportPersonEligible({ ...ok, contactKind: null }), false, 'kind not declared');
  assert.equal(crmImportPersonEligible({ ...ok, contactKind: 'ROLE_INBOX' }), false);
  for (const name of [null, '', '   ', 'Name not verified', 'NAME NOT VERIFIED', 'Unknown', 'N/A', 'tbd', '—', '123', 'Team', 'Partnerships']) {
    assert.equal(crmImportPersonEligible({ ...ok, contactName: name }), false, `"${name}"`);
  }
});

test('route mappings: a Company only on a Company route, a represented brand only on a representing one', () => {
  for (const c of CRM_IMPORT_ROUTE_CLASSIFICATIONS) assert.deepEqual(validateCrmImportRoute({ routeKey: 'r', classification: c }), [], c);
  assert.deepEqual(validateCrmImportRoute({ routeKey: 'r', classification: 'BRAND_COMPANY', proposedCompanyName: 'Lund Boats' }), []);
  assert.deepEqual(validateCrmImportRoute({ routeKey: 'r', classification: 'INTERNAL', proposedCompanyName: 'EMG' }), ['COMPANY_NOT_PERMITTED_FOR_CLASSIFICATION']);
  assert.deepEqual(validateCrmImportRoute({ routeKey: 'r', classification: 'CREATOR_ROUTE', targetCompanyPartyId: 'p' }), ['COMPANY_NOT_PERMITTED_FOR_CLASSIFICATION']);
  assert.deepEqual(validateCrmImportRoute({ routeKey: 'r', classification: 'BRAND_COMPANY', targetCompanyPartyId: 'p', proposedCompanyName: 'X' }), ['TARGET_AND_PROPOSAL_BOTH_GIVEN']);
  assert.deepEqual(validateCrmImportRoute({ routeKey: 'r', classification: 'BRAND_COMPANY', representedBrandPartyId: 'p' }), ['REPRESENTED_BRAND_NOT_PERMITTED_FOR_CLASSIFICATION']);
  assert.deepEqual(validateCrmImportRoute({ routeKey: 'r', classification: 'AGENCY', representedBrandPartyId: 'p', representedBrandRouteKey: 'b' }), ['REPRESENTED_BRAND_GIVEN_TWICE']);
  assert.deepEqual(validateCrmImportRoute({ routeKey: 'r', classification: 'AGENCY', representedBrandRouteKey: 'R' }), ['REPRESENTS_ITSELF']);
  assert.deepEqual(validateCrmImportRoute({ routeKey: 'r', classification: 'GUESSED' as never }), ['UNKNOWN_CLASSIFICATION']);
  assert.deepEqual(validateCrmImportRoute({ routeKey: 'pr@brand.example', classification: 'UNKNOWN' }), ['ROUTE_KEY_CARRIES_CONTACT_VALUE']);
});

test('stage mapping: the shape only -- a status means nothing until a reviewer maps it', () => {
  assert.deepEqual(validateCrmImportStageMapping({ sourceStatus: 'Signed', action: 'OPPORTUNITY', category: 'CLOSED_WON', stage: 'Won' }), []);
  assert.deepEqual(validateCrmImportStageMapping({ sourceStatus: 'x', action: 'OPPORTUNITY', category: 'MAYBE', stage: '' }), ['CATEGORY_REQUIRED', 'STAGE_REQUIRED']);
  assert.deepEqual(validateCrmImportStageMapping({ sourceStatus: 'x', action: 'CONTACTS_ONLY', stage: 'Pitching' }), ['STAGE_NOT_PERMITTED_FOR_ACTION']);
  assert.deepEqual(validateCrmImportStageMapping({ sourceStatus: 'x', action: 'GUESS' as never }), ['UNKNOWN_ACTION']);
});

test('the configuration is checked whole, and normalized collisions are refused, never resolved by order', () => {
  const ok = {
    version: CRM_IMPORT_CONFIG_VERSION,
    creatorAliases: [{ alias: 'Trevon Hill', creatorPartyId: 'p_t' }],
    routes: [
      { routeKey: 'lund', classification: 'BRAND_COMPANY', proposedCompanyName: 'Lund Boats' },
      { routeKey: 'agency', classification: 'AGENCY', representedBrandRouteKey: 'Lund' },
    ],
    stageMapping: [],
  };
  assert.ok(validateCrmImportConfig(ok).ok);
  const bad = validateCrmImportConfig({
    ...ok,
    creatorAliases: [...ok.creatorAliases, { alias: '  trevon   hill', creatorPartyId: 'p_other' }],
    routes: [...ok.routes, { routeKey: 'x', classification: 'ROLE_INBOX_ROUTE', representedBrandRouteKey: 'agency' }],
    stageMapping: [
      { sourceStatus: 'Signed', action: 'EXCLUDE' },
      { sourceStatus: 'SIGNED', action: 'EXCLUDE' },
    ],
  });
  assert.ok(!bad.ok);
  assert.deepEqual(
    bad.violations.map((v) => `${v.at}:${v.code}`).sort(),
    ['creatorAliases[1]:KEY_COLLISION', 'routes[2]:REPRESENTED_ROUTE_NOT_A_BRAND_COMPANY', 'stageMapping[1]:KEY_COLLISION'],
  );
  assert.deepEqual(validateCrmImportConfig({ version: 'v0' }), { ok: false, violations: [{ at: 'version', code: 'UNKNOWN_CONFIG_VERSION' }] });
});

test('act table: dry run EMPLOYEE+, mappings / approve / apply OWNER+ADMIN, view every human role; AI and CREATOR nothing', () => {
  const allowed = (act: string) => ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE', 'CREATOR'].filter((role) => crmImportActPermitted({ act, role, actorType: 'HUMAN' }));
  assert.deepEqual(allowed('VIEW'), ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY']);
  assert.deepEqual(allowed('DRY_RUN'), ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE']);
  for (const act of ['MAP_CREATOR_ALIAS', 'MAP_ROUTE', 'APPROVE_APPLY', 'APPLY']) assert.deepEqual(allowed(act), ['OWNER', 'ADMIN'], act);
  assert.equal(crmImportActPermitted({ act: 'APPLY', role: 'OWNER', actorType: 'AI' }), false, 'a machine actor never');
  assert.equal(crmImportActPermitted({ act: 'UNKNOWN', role: 'OWNER', actorType: 'HUMAN' }), false);
  assert.ok(Object.isFrozen(CRM_IMPORT_ACT_ROLES));
});

test('the title is exactly `<Creator> × <Brand>`', () => {
  assert.equal(crmImportOpportunityTitle(' Trevon Hill ', 'Lund Boats'), 'Trevon Hill × Lund Boats');
  assert.equal(crmImportOpportunityTitle('Katrina', 'Brother'), 'Katrina × Brother');
});
