// Read identity footprint -- the production read P0.2d's schema alignment depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from '../../packages/database/test/helpers/cognitive-prisma-fake';
import {
  createCognitiveRepositories,
  IdentityFootprintRepository,
} from '../../packages/database/src/repositories/cognitive';
import {
  isEmptyFootprint,
  parseArgs,
  readEnvironment,
  runIdentityFootprint,
} from './read-identity-footprint';

const RUNNER_CODE = readFileSync(new URL('./read-identity-footprint.ts', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');
const READER_CODE = readFileSync(
  new URL('../../packages/database/src/repositories/cognitive/identity-footprint.repository.ts', import.meta.url),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const WORKFLOW_SOURCE = readFileSync(new URL('../../.github/workflows/read-identity-footprint.yml', import.meta.url), 'utf8');

const ORG = 'org_acme';
const OTHER = 'org_other';

function world() {
  const fake: any = makeCognitivePrisma();
  const prisma = fake as PrismaClient;
  const repos = createCognitiveRepositories(prisma);
  const lines: string[] = [];
  const deps = {
    organizations: {
      async findBySlug(slug: string) {
        return slug === 'acme' ? { id: ORG, slug: 'acme' } : null;
      },
    },
    identities: new IdentityFootprintRepository(prisma),
    log: (l: string) => lines.push(l),
  };
  return { fake, repos, deps, lines };
}

test('an empty organization reads EMPTY=true with zero duplicates and zero unresolved references', async () => {
  const { deps, lines } = world();
  const r = await runIdentityFootprint({ organizationSlug: 'acme' }, deps);
  assert.equal(r.overall, 'READ');
  assert.equal(r.empty, true);
  assert.equal(r.counts?.identities.duplicateKeyGroups, 0);
  assert.equal(r.counts?.unresolvedReferences, 0);
  assert.match(lines.join('\n'), /event=VERDICT EMPTY=true EXCEEDED_BOUND=false OVERALL_RESULT=READ/);
});

test('it counts identities by type and status, Party-typed rows, and keys a (org, canonicalKey) unique would reject', async () => {
  const { repos, deps, lines } = world();
  await repos.identities.create(ORG, { entityType: 'PERSON', canonicalKey: 'k1', status: 'KNOWN' });
  await repos.identities.create(ORG, { entityType: 'CREATOR', canonicalKey: 'k1' });
  await repos.identities.create(ORG, { entityType: 'COMPANY', canonicalKey: 'k2' });
  await repos.identities.create(ORG, { entityType: 'CALL', canonicalKey: 'k3' });
  await repos.identities.create(OTHER, { entityType: 'PERSON', canonicalKey: 'k2' });
  const r = await runIdentityFootprint({ organizationSlug: 'acme' }, deps);
  const c = r.counts!;
  assert.equal(c.identities.total, 4, 'the other organization is not counted');
  assert.equal(c.identities.partyTyped, 2);
  assert.equal(c.identities.byEntityType.PERSON, 1);
  assert.equal(c.identities.byEntityType.CREATOR, 1);
  assert.equal(c.identities.byStatus.KNOWN, 1);
  assert.equal(c.identities.byStatus.ANONYMOUS, 3);
  assert.equal(c.identities.duplicateKeyGroups, 1);
  assert.equal(c.identities.duplicateKeyRows, 2);
  assert.equal(r.empty, false);
  const out = lines.join('\n');
  assert.match(out, /TYPE_PERSON=1/);
  assert.equal(/TYPE_OPPORTUNITY/.test(out), false, 'zero buckets are omitted');
});

test('satellites, cognitive references and unresolved references are counted per organization', async () => {
  const { fake, repos, deps } = world();
  const a = await repos.identities.create(ORG, { entityType: 'PERSON', canonicalKey: 'a' });
  const b = await repos.identities.create(ORG, { entityType: 'PERSON', canonicalKey: 'b' });
  const elsewhere = await repos.identities.create(OTHER, { entityType: 'PERSON', canonicalKey: 'z' });
  await repos.identityRoles.addRole(ORG, { identityId: a.id, roleType: 'LEAD' });
  const ev = await repos.identityEvidence.record(ORG, { identityId: a.id, evidenceType: 'EMAIL', rawValue: 'pat@example.com' });
  await repos.identityEvidence.revoke(ORG, ev.id);
  const link = await repos.identityResolutionLinks.propose(ORG, { sourceIdentityId: a.id, targetIdentityId: b.id, method: 'MANUAL' });
  await repos.identityResolutionLinks.confirm(ORG, link.id);
  // A reference in this org to an identity that lives in ANOTHER org, and one to nothing at all.
  await fake.identityRole.create({ data: { organizationId: ORG, identityId: elsewhere.id, roleType: 'LEAD', status: 'ACTIVE' } });
  await fake.cognitiveDecision.create({ data: { organizationId: ORG, subjectIdentityId: 'ghost', decisionType: 'x' } });

  const c = (await runIdentityFootprint({ organizationSlug: 'acme' }, deps)).counts!;
  assert.equal(c.satellites.roles, 2);
  assert.equal(c.satellites.evidence, 1);
  assert.equal(c.satellites.revokedEvidence, 1);
  assert.equal(c.satellites.evidenceByType.EMAIL, 1);
  assert.equal(c.satellites.linksByStatus.CONFIRMED, 1);
  assert.equal(c.satellites.linksByMethod.MANUAL, 1);
  assert.equal(c.references.decisionsWithSubject, 1);
  assert.equal(c.unresolvedReferences, 2, 'another tenant\'s identity and a ghost both fail to resolve here');
});

test('output is counts only: no id, key, name, hash or contact value is printed', async () => {
  const { repos, deps, lines } = world();
  const a = await repos.identities.create(ORG, { entityType: 'PERSON', canonicalKey: 'secret-key-123', displayName: 'Pat Doe' });
  await repos.identityEvidence.record(ORG, { identityId: a.id, evidenceType: 'EMAIL', rawValue: 'pat@example.com' });
  await runIdentityFootprint({ organizationSlug: 'acme' }, deps);
  const out = lines.join('\n');
  for (const secret of [a.id, 'secret-key-123', 'Pat Doe', 'pat@example.com', ORG]) {
    assert.equal(out.includes(secret), false, `must not print ${secret}`);
  }
  assert.equal(/[0-9a-f]{64}/.test(out), false, 'no hash');
});

test('unknown or malformed organizations fail closed before any read', async () => {
  const { deps } = world();
  let read = 0;
  const counting = { ...deps, identities: { footprint: async (o: string) => { read += 1; return deps.identities.footprint(o); } } };
  for (const slug of ['nope', '', 'ACME', "acme' or 1=1"]) {
    const r = await runIdentityFootprint({ organizationSlug: slug }, counting);
    assert.equal(r.overall, 'FAILED_PRECONDITION', slug);
  }
  assert.equal(read, 0);
});

test('isEmptyFootprint is false when anything identity-shaped exists', async () => {
  const { fake, deps } = world();
  await fake.stateChangeOutbox.create({ data: { organizationId: ORG, identityId: 'x', subjectType: 'IDENTITY', status: 'PENDING' } });
  const r = await runIdentityFootprint({ organizationSlug: 'acme' }, deps);
  assert.equal(isEmptyFootprint(r.counts!), false);
  assert.equal(r.counts?.references.outboxWithIdentity, 1);
});

test('the reader and the runner have no mutation path; every reader query is organization-scoped', () => {
  for (const code of [RUNNER_CODE, READER_CODE]) {
    for (const symbol of ['create(', 'update(', 'upsert(', 'delete(', 'createMany(', 'updateMany(', 'deleteMany(', '$executeRaw', '$queryRaw', 'fetch(']) {
      assert.ok(!code.includes(symbol), `must not name ${symbol}`);
    }
    assert.ok(!/\bSELECT\s|\bINSERT\s|\bUPDATE\s+\w+\s+SET\b/.test(code));
  }
  assert.ok(!/prisma\.\w+\./.test(RUNNER_CODE), 'the runner goes through the repository');
  // Every count/findMany in the reader carries the organization.
  const calls = [...READER_CODE.matchAll(/\.(count|findMany)\(\{([\s\S]*?)\}\)/g)];
  assert.ok(calls.length >= 10);
  for (const [, op, body] of calls) {
    assert.match(body!, /organizationId|\borg\b|\.\.\.org/, `${op} is organization-scoped`);
  }
  assert.ok(READER_CODE.includes('async footprint(organizationId: string)'));
});

test('the workflow is human-started only, proves safety before reading, and interpolates no input', () => {
  assert.ok(WORKFLOW_SOURCE.includes('workflow_dispatch:'));
  for (const trigger of ['\n  schedule:', '\n  push:', '\n  pull_request:', '\n  workflow_call:']) {
    assert.ok(!WORKFLOW_SOURCE.includes(trigger), `no ${trigger.trim()}`);
  }
  const proof = WORKFLOW_SOURCE.indexOf('test:operations');
  const read = WORKFLOW_SOURCE.indexOf('read:identity-footprint');
  assert.ok(proof > 0 && proof < read);
  assert.ok(!WORKFLOW_SOURCE.includes('migrate deploy'));
  for (const body of WORKFLOW_SOURCE.split(/\n\s+run: \|/).slice(1)) {
    const step = body.split(/\n\s+- name:/)[0] ?? '';
    assert.ok(!/\$\{\{\s*inputs\./.test(step), 'no input interpolated into a run body');
  }
});

test('flags and environment', () => {
  assert.deepEqual(parseArgs(['--org', 'acme']), { organization: 'acme' });
  assert.deepEqual(readEnvironment({} as NodeJS.ProcessEnv), { ok: false, missing: ['DATABASE_URL'] });
  assert.deepEqual(readEnvironment({ DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv), { ok: true });
});
