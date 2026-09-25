// Loop Intelligence Phase F: EVERY organization-level Case read excludes private situations. A source scan
// over the whole database package: each read of operational_priorities must carry CASE_ORGANIZATION_WHERE,
// name a specific (non-private) producer, or be one of the few reads that are the private door itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : []));

// The reads allowed without the organization filter, and why.
const ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  // The private door: resolves the owner in the query (privateScope.userId).
  'repositories/intelligence/situation.repository.ts': 'the situation repository IS the private door',
  // Detection by (sourceSystem, recurrenceKey): the writer's own identity; a private key carries its owner.
  'repositories/operational-priority.repository.ts#findByRecurrenceKey': 'detect() identity lookup',
  'repositories/operational-priority.repository.ts#appendSituationEvidence': 'resolved by (id, org, THAT situation source)',
});

test('every Case read in the database package excludes private situations or is an allowed private door', () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    const code = readFileSync(file, 'utf8');
    const re = /operationalPriority\.(findFirst|findMany|findUnique|count|groupBy|aggregate)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      scanned += 1;
      if (ALLOWED[rel]) continue;
      const before = code.slice(0, m.index);
      const method = [...before.matchAll(/\n  (?:async )?([a-zA-Z]+)\(/g)].pop()?.[1] ?? '';
      if (ALLOWED[`${rel}#${method}`]) continue;
      const call = code.slice(m.index, m.index + 400);
      const scoped = /CASE_ORGANIZATION_WHERE/.test(call) || /sourceSystem: (CALLGRID_CASE_PRODUCER|CREATOR_ONBOARDING_PRODUCER)/.test(call);
      if (!scoped) offenders.push(`${rel}:${before.split('\n').length} (${method})`);
    }
  }
  assert.ok(scanned >= 20, `the scan found the Case reads (${scanned})`);
  assert.deepEqual(offenders, [], 'a Case read that could return a private situation');
});

test('Case log, evidence and activity reads resolve the Case as an ORGANIZATION Case first', () => {
  const engine = readFileSync(join(SRC, 'services', 'decision', 'decision-engine.ts'), 'utf8');
  for (const method of ['getHistory', 'getEvidence']) {
    const body = engine.slice(engine.indexOf(`async ${method}(`), engine.indexOf(`async ${method}(`) + 600);
    assert.match(body, /CASE_ORGANIZATION_WHERE[\s\S]*return \[\]/, method);
  }
  const repo = readFileSync(join(SRC, 'repositories', 'operational-priority.repository.ts'), 'utf8');
  assert.match(repo.slice(repo.indexOf('async listObservations('), repo.indexOf('async listObservations(') + 500), /CASE_ORGANIZATION_WHERE/);
  const adapter = readFileSync(join(SRC, 'repositories', 'activity', 'observation.adapter.ts'), 'utf8');
  assert.match(adapter, /CASE_ORGANIZATION_WHERE[\s\S]*return EMPTY_PAGE/);
});
