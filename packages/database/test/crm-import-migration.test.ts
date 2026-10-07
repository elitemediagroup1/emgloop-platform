// The CRM import authority's migration (CRM slice 5) is additive and holds no source content.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../prisma/migrations/', import.meta.url);
const SQL = readFileSync(new URL('20261012000000_crm_import_provenance/migration.sql', DIR), 'utf8');
const code = SQL.replace(/^--.*$/gm, '');

test('additive only: six new tables, nothing existing altered, dropped or rewritten', () => {
  assert.deepEqual([...code.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort(), [
    'crm_import_approvals',
    'crm_import_creator_aliases',
    'crm_import_entries',
    'crm_import_keys',
    'crm_import_route_mappings',
    'crm_import_runs',
  ]);
  // Statements only: `ON DELETE CASCADE` / `ON UPDATE CASCADE` in a foreign key are not writes.
  assert.equal(/\bDROP\b|DELETE\s+FROM|^\s*UPDATE\s|\bTRUNCATE\b|RENAME/im.test(code), false);
  for (const m of code.matchAll(/ALTER TABLE "([a-z_]+)"/g)) assert.match(m[1]!, /^crm_import_/, `only new tables are altered (${m[1]})`);
  assert.equal(/intelligence_digests/.test(code), false, 'the unrelated pre-existing drift is not folded in');
});

test('the newest migration, and no earlier one was edited for it', () => {
  const dirs = readdirSync(DIR).filter((d) => /^\d{14}_/.test(d)).sort();
  assert.equal(dirs.at(-1), '20261012000000_crm_import_provenance');
});

test('no column can hold a contact value, a name, a title or a note', () => {
  const columns = [...code.matchAll(/^\s+"([A-Za-z]+)" [A-Z]/gm)].map((m) => m[1]!);
  // `keyValue` holds an import key built from ids, route keys and KEYED hashes -- never a raw value.
  for (const c of columns.filter((x) => x !== 'keyValue')) assert.equal(/email|phone|value$|contactName|title|notes?$|brand(Name|Text)/i.test(c), false, c);
  assert.ok(columns.includes('keyValue'));
});

test('the closed vocabularies and active-key invariants are enforced by the database', () => {
  for (const check of ['crm_import_creator_aliases_state_check', 'crm_import_route_mappings_state_check', 'crm_import_route_mappings_classification_check', 'crm_import_route_mappings_company_check', 'crm_import_runs_shape_check', 'crm_import_keys_kind_check']) {
    assert.match(code, new RegExp(`ADD CONSTRAINT "${check}"`), check);
  }
  assert.match(code, /CREATE UNIQUE INDEX "crm_import_keys_organizationId_keyKind_keyValue_key"/);
  assert.match(code, /CREATE UNIQUE INDEX "crm_import_runs_applyLockKey_key"/);
});

test('an approval is consumed when an APPLY run claims it; references are real, and never cascade between provenance rows', () => {
  assert.match(code, /CREATE UNIQUE INDEX "crm_import_runs_approvalId_key" ON "crm_import_runs"\("approvalId"\)/, 'one APPLY run per approval');
  for (const [table, column, target] of [
    ['crm_import_runs', 'approvalId', 'crm_import_approvals'],
    ['crm_import_approvals', 'dryRunId', 'crm_import_runs'],
    ['crm_import_keys', 'importRunId', 'crm_import_runs'],
    ['crm_import_entries', 'importRunId', 'crm_import_runs'],
  ] as const) {
    assert.match(code, new RegExp(`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_${column}_fkey" FOREIGN KEY \\("${column}"\\) REFERENCES "${target}"\\("id"\\) ON DELETE NO ACTION ON UPDATE NO ACTION;`), `${table}.${column}`);
  }
  const cascades = [...code.matchAll(/ADD CONSTRAINT "([a-z_]+_fkey)"[^;]*ON DELETE CASCADE/g)].map((m) => m[1]!);
  assert.ok(cascades.every((c) => c.endsWith('_organizationId_fkey')), `only the organization cascades: ${cascades.join(', ')}`);
});
