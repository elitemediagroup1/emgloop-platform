// Source fences for the CRM outreach importer (CRM slice 5). Static: they read the code.
//
// The importer is a coordinator, never a second CRM authority, so its code must not:
//   - write a CRM table directly (Party, Contact Point, Opportunity, Participant, Relationship,
//     IdentityEvidence) -- every write goes through a governed service;
//   - create a Relationship or an AFFILIATION, or touch identity evidence;
//   - match by name, domain, similarity or an email local-part;
//   - log anything (values could be source data);
//   - be read by AI, Brain or intelligence code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ').replace(/\s\/\/.*$/gm, ' ');
const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((name) => {
    const p = join(dir, name);
    return statSync(join(ROOT, p)).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : [];
  });

const IMPORTER = ['packages/database/src/crm-import', 'scripts/operations/crm-import.ts'].flatMap((p) => (p.endsWith('.ts') ? [p] : walk(p)));

test('the importer writes no CRM table directly: every write is a governed service', () => {
  for (const file of IMPORTER) {
    const src = code(read(file));
    assert.equal(
      /\.(cognitiveIdentity|crmContactPoint|crmContactPointEvent|crmOpportunity|crmOpportunityTransition|crmParticipant|crmRelationship|identityEvidence|auditLog|stateChangeOutbox)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(src),
      false,
      `${file} writes a CRM table directly`,
    );
  }
  const service = code(read('packages/database/src/crm-import/crm-import.service.ts'));
  for (const writer of ['this.parties.create(', 'this.parties.establish(', 'this.contactPoints.add(', 'this.opportunities.create(', 'this.opportunities.addParticipant(']) {
    assert.ok(service.includes(writer), `the service writes through ${writer}`);
  }
  assert.equal(/assignOwner|ownerUserId:/.test(service), false, 'the importer never assigns an owner');
  assert.match(service, /relationshipId: null/, 'and never links a Relationship');
});

test('the importer never creates a Relationship, an AFFILIATION or identity evidence', () => {
  for (const file of IMPORTER) {
    const src = code(read(file));
    assert.equal(/AFFILIATION|crmRelationship|CrmRelationshipService|identityEvidence|IdentityEvidence/.test(src), false, file);
  }
});

test('no name, domain, similarity or local-part matching anywhere in the importer or its contract', () => {
  for (const file of [...IMPORTER, 'packages/shared/src/crm-import.ts']) {
    const src = code(read(file));
    assert.equal(/levenshtein|similarity|fuzzy|soundex|startsWith\(name|split\('@'\)|indexOf\('@'\)|\.domain\b|displayName:\s*\{\s*(equals|contains)/i.test(src), false, file);
  }
  const shared = code(read('packages/shared/src/crm-import.ts'));
  const person = shared.slice(shared.indexOf('export function crmImportPersonEligible'), shared.indexOf('// --- Stage mapping'));
  assert.equal(/email|phone/i.test(person), false, 'the Person rule never reads an address');
});

test('the importer does not log: output is the operator command\'s structured lines only', () => {
  for (const file of IMPORTER.filter((f) => f.startsWith('packages/'))) {
    assert.equal(/console\.|process\.stdout|process\.stderr/.test(code(read(file))), false, file);
  }
  const cli = code(read('scripts/operations/crm-import.ts'));
  for (const field of ['email', 'phone', 'contactName', 'contactTitle', 'sourceNotes', 'brandName', 'routeName']) {
    const logged = [...cli.matchAll(/log\(line\(\{([\s\S]*?)\}\)\)/g)].some((m) => new RegExp(`\\b${field}\\b`).test(m[1]!));
    assert.equal(logged, false, `the command never logs ${field}`);
  }
});

test('AI, Brain and intelligence code never reads the import authority', () => {
  const fenced = ['packages/database/src/services/ai-runtime', 'packages/database/src/services/intelligence', 'packages/database/src/services/intelligence-fabric', 'packages/database/src/repositories/intelligence', 'packages/database/src/repositories/brain', 'packages/brain/src', 'apps/brain-executor/src'];
  for (const dir of fenced) {
    for (const file of walk(dir)) {
      assert.equal(/crmImport|crm_import|CrmImport/.test(read(file)), false, relative(ROOT, join(ROOT, file)));
    }
  }
});
