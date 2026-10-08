// The People command center's migration (CRM slice 6) is additive, enforces its vocabularies, and
// keeps a person's private dismissals keyed by hash and owned by their membership.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../prisma/migrations/', import.meta.url);
const NAME = '20261013000000_crm_people_command_center';
const SQL = readFileSync(new URL(`${NAME}/migration.sql`, DIR), 'utf8');
const code = SQL.replace(/^--.*$/gm, '');

test('the newest migration', () => {
  const dirs = readdirSync(DIR).filter((d) => /^\d{14}_/.test(d)).sort();
  assert.equal(dirs.at(-1), NAME);
});

test('additive only: four new tables, one normalized Gmail metadata column, and one new outbox subject value; nothing destructive or rewritten', () => {
  assert.deepEqual([...code.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort(), [
    'crm_discovery_dismissals',
    'crm_outreach_events',
    'crm_outreach_states',
    'crm_subject_context_facts',
  ]);
  assert.equal(/\bDROP\b|DELETE\s+FROM|^\s*UPDATE\s|\bTRUNCATE\b|RENAME/im.test(code), false);
  const altered = [...code.matchAll(/ALTER TABLE "([a-z_]+)"/g)].map((m) => m[1]!);
  for (const table of altered) {
    assert.ok(
      /^crm_(subject_context_facts|outreach_|discovery_)/.test(table) || table === 'work_messages',
      `only the new CRM tables or work_messages are altered (${table})`,
    );
  }
  assert.equal(altered.filter((t) => t === 'work_messages').length, 2, 'work_messages is changed only to add the normalized automation classification and its check');
  assert.match(code, /ALTER TABLE "work_messages" ADD COLUMN "automationClass" TEXT;/);
  assert.match(code, /work_messages_automationClass_check/);
  assert.match(code, /"automationClass" IS NULL OR "automationClass" IN \('AUTO_SUBMITTED','MAILING_LIST','BULK'\)/);
  assert.deepEqual([...code.matchAll(/ALTER TYPE "(\w+)" ADD VALUE '(\w+)'/g)].map((m) => [m[1], m[2]]), [['OutboxSubjectType', 'CRM_OUTREACH']]);
  assert.equal(/intelligence_digests/.test(code), false, 'the unrelated pre-existing drift is not folded in');
});

test('the vocabularies, time precision and import provenance are enforced by the database', () => {
  assert.match(code, /"kind" IN \('TITLE', 'NOTE', 'SOURCE_STATUS', 'SOURCE_LAST_CONTACTED', 'CREATOR_CONTEXT', 'COMPANY_CONTEXT', 'ORIGIN'\)/);
  assert.match(code, /"basis" IN \('IMPORTED', 'OPERATOR_RECORDED'\)/);
  assert.match(code, /\("occurredAtPrecision" = 'UNKNOWN'\) = \("occurredAt" IS NULL\)/, 'an unknown time has no time');
  assert.match(code, /"basis" <> 'IMPORTED' OR \("importRunId" IS NOT NULL AND "importLine" IS NOT NULL\)/);
  // Only human-settable states can be stored: a fact-derived state is never persisted as a person's choice.
  for (const t of ['crm_outreach_states', 'crm_outreach_events']) {
    const block = code.slice(code.indexOf(`ALTER TABLE "${t}"`));
    assert.match(block, /'ACTIVE_CONVERSATION', 'INTERESTED', 'MEETING_SCHEDULED', 'NEGOTIATING', 'ON_HOLD', 'CIRCLE_BACK', 'PASSED', 'CLOSED'/);
    assert.doesNotMatch(block.slice(0, 600), /AWAITING_REPLY|REPLIED_NEEDS_RESPONSE|NO_OUTREACH|REVIEW_REQUIRED/);
  }
  assert.match(code, /"reason" IN \('IGNORE', 'NOT_A_PERSON', 'INTERNAL', 'AUTOMATED', 'NOT_RELEVANT'\)/);
});

test('a dismissal is keyed by a hash, never an address, and belongs to the membership', () => {
  assert.match(code, /"correspondentHash" ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(code, /FOREIGN KEY \("userId", "organizationId"\) REFERENCES "organization_memberships"\("userId", "organizationId"\) ON DELETE CASCADE/);
  const dismissals = code.slice(code.indexOf('CREATE TABLE "crm_discovery_dismissals"'), code.indexOf(');', code.indexOf('CREATE TABLE "crm_discovery_dismissals"')));
  assert.equal(/address|email|displayName/i.test(dismissals.replace(/correspondentHash/g, '')), false);
});

test('no column of the outreach tables holds a contact value', () => {
  const tables = code.slice(code.indexOf('CREATE TABLE "crm_outreach_states"'), code.indexOf('CREATE TABLE "crm_discovery_dismissals"'));
  const columns = [...tables.matchAll(/^\s+"([A-Za-z]+)" [A-Z]/gm)].map((m) => m[1]!);
  for (const c of columns) assert.equal(/email|phone|address|value$/i.test(c), false, c);
});
