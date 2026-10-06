// Fences for CRM slice 3's migration (20261011000000_crm_opportunity_owner_participants). Pure.
//
// The participant shape CHECK is the one thing replaced: it is dropped and re-added with the second
// subject, in the same migration. Nothing else is dropped, no row is touched, and the file is ASCII
// (a non-ASCII character once blocked replay of the whole migration ledger).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(join(__dirname, '..', 'prisma', 'migrations', '20261011000000_crm_opportunity_owner_participants', 'migration.sql'), 'utf8');

test('additive apart from the replaced participant shape CHECK; no data statements; ASCII', () => {
  const drops = [...sql.matchAll(/DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE)\s+"?(\w+)"?/gi)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`);
  assert.deepEqual(drops, ['CONSTRAINT crm_participants_shape'], 'only the shape CHECK is dropped');
  assert.match(sql, /ADD CONSTRAINT "crm_participants_shape"/, 'and it is re-added in the same migration');
  assert.doesNotMatch(sql, /^\s*(UPDATE\s|DELETE\s+FROM|INSERT\s+INTO|SELECT\s)/im, 'no row is read, written or moved');
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(sql, /[^\x00-\x7F]/, 'ASCII only');
});

test('the new CHECK keeps the Relationship rule verbatim and pins the Opportunity roles to their Party types', () => {
  assert.match(sql, /\("relationshipId" IS NOT NULL\) <> \("opportunityId" IS NOT NULL\)/, 'exactly one subject');
  assert.match(sql, /"relationshipId" IS NOT NULL AND \(\("side" IS NULL\) <> \("actsForSide" IS NULL\)\)/, 'a Relationship row: side XOR acts-for, as before');
  assert.match(sql, /\("role" = 'BRAND' AND "partyType" = 'COMPANY'\) OR \("role" = 'PRIMARY_CONTACT' AND "partyType" = 'PERSON'\)/);
  assert.match(sql, /ADD COLUMN "ownerUserId" TEXT;/, 'the owner is nullable: unknown is not a default');
  assert.match(sql, /"crm_opportunities_ownerUserId_fkey" FOREIGN KEY \("ownerUserId"\) REFERENCES "users"\("id"\) ON DELETE SET NULL/);
});
