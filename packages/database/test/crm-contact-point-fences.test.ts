// Source fences for CRM Contact Points (PD-F-05, Product 2026-10-06). No database needed.
//
// A raw contact value must reach exactly one place: an authorized human view. These fences keep
// every other path from acquiring one:
//   1. only the Contact Point repository touches the table, and only `revealValues` selects the value;
//   2. no AI runtime, Brain or intelligence code reads Contact Points or `internalNotes` (which can
//      carry contact data);
//   3. the authority never writes identity evidence, a Party, or a log line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

const rel = (p: string) => relative(ROOT, p);
const REPOSITORY = 'packages/database/src/repositories/crm-contact-point.repository.ts';
const SERVICE = 'packages/database/src/services/crm-contact-point.service.ts';

test('only the Contact Point repository touches the table, and only revealValues selects the value', () => {
  const sources = [...files(join(ROOT, 'packages')), ...files(join(ROOT, 'apps')), ...files(join(ROOT, 'scripts'))];
  const touching = sources.filter((p) => /\.crmContactPoint(Event)?\b/.test(readFileSync(p, 'utf8'))).map(rel).sort();
  assert.deepEqual(touching, [REPOSITORY], 'no other file reads or writes contact points directly');

  const repo = readFileSync(join(ROOT, REPOSITORY), 'utf8');
  const valueSelects = repo.split('\n').filter((l) => /\bvalue:\s*true\b/.test(l));
  assert.equal(valueSelects.length, 1, 'exactly one select of the raw value');
  const reveal = repo.slice(repo.indexOf('async revealValues'), repo.indexOf('// --- Writes'));
  assert.match(reveal, /value:\s*true/, 'and it is inside revealValues');
  const summary = repo.slice(repo.indexOf('const SUMMARY_SELECT'), repo.indexOf('} as const satisfies'));
  assert.doesNotMatch(summary, /\bvalue:|valueHash/, 'the default read model carries neither the value nor its hash');
});

test('no AI runtime, Brain or intelligence code reads Contact Points or internalNotes', () => {
  const fenced = [
    'packages/database/src/services/ai-runtime',
    'packages/database/src/services/intelligence',
    'packages/database/src/services/intelligence-fabric',
    'packages/database/src/repositories/intelligence',
    'packages/database/src/repositories/brain',
    'packages/brain/src',
    'apps/brain-executor/src',
  ];
  for (const dir of fenced) {
    for (const p of files(join(ROOT, dir))) {
      const text = readFileSync(p, 'utf8');
      assert.doesNotMatch(text, /crmContactPoint|CrmContactPoint|crm_contact_point|contact_point|internalNotes/, `${rel(p)} must not read contact values or internal notes`);
    }
  }
});

test('the authority writes no identity evidence, no Party, and no log line', () => {
  for (const path of [REPOSITORY, SERVICE]) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    assert.doesNotMatch(text, /identityEvidence\.|cognitiveIdentity\.(create|update|upsert)|PartyService/, `${path} is not identity`);
    assert.doesNotMatch(text, /console\.|logger\./, `${path} prints nothing`);
  }
  const service = readFileSync(join(ROOT, SERVICE), 'utf8');
  const record = service.slice(service.indexOf('private async record('), service.indexOf('private async role('));
  assert.doesNotMatch(record, /\bvalue\b(?!s)|valueHash/, 'audit metadata and outbox payloads are built without the value or its hash');
});
