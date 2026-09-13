// Read membership coverage -- the read-only gate P0.2c depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseArgs,
  readEnvironment,
  readyForAuthority,
  runMembershipCoverage,
  type MembershipCoverageCounts,
} from './read-membership-coverage';

const RUNNER_CODE = readFileSync(new URL('./read-membership-coverage.ts', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');
const WORKFLOW_SOURCE = readFileSync(new URL('../../.github/workflows/read-membership-coverage.yml', import.meta.url), 'utf8');

const COMPLETE: MembershipCoverageCounts = {
  users: 4, memberships: 4, missingMemberships: 0, roleMismatches: 0, statusMismatches: 0,
  underivableRole: 0, underivableStatus: 0, removedMarkerNotDisabled: 0, orphanMemberships: 0,
};

function harness(counts: MembershipCoverageCounts = COMPLETE) {
  const lines: string[] = [];
  const asked: string[] = [];
  const deps = {
    organizations: {
      async findBySlug(slug: string) {
        return slug === 'acme' ? { id: 'org_acme', slug: 'acme' } : null;
      },
    },
    memberships: {
      async coverage(organizationId: string) {
        asked.push(organizationId);
        return counts;
      },
    },
    log: (l: string) => lines.push(l),
  };
  return { deps, lines, asked };
}

test('an unknown organization fails closed and nothing is read', async () => {
  const { deps, asked, lines } = harness();
  const r = await runMembershipCoverage({ organizationSlug: 'nope' }, deps);
  assert.equal(r.overall, 'FAILED_PRECONDITION');
  assert.deepEqual(asked, []);
  assert.match(lines[0]!, /event=PRECONDITION_FAILED/);
});

test('a malformed slug is refused before any lookup', async () => {
  const { deps, asked } = harness();
  for (const slug of ['', 'ACME', 'a b', "acme'; drop", '-acme']) {
    const r = await runMembershipCoverage({ organizationSlug: slug }, deps);
    assert.equal(r.overall, 'FAILED_PRECONDITION', slug);
  }
  assert.deepEqual(asked, []);
});

test('the read is scoped to the resolved organization, and a complete one is ready for authority', async () => {
  const { deps, asked, lines } = harness();
  const r = await runMembershipCoverage({ organizationSlug: 'acme' }, deps);
  assert.deepEqual(asked, ['org_acme']);
  assert.equal(r.readyForAuthority, true);
  assert.match(lines.join('\n'), /event=VERDICT READY_FOR_AUTHORITY=true OVERALL_RESULT=READ/);
});

test('every kind of gap withholds readiness -- and is an answer, not a failure', async () => {
  const gaps: Array<keyof MembershipCoverageCounts> = [
    'missingMemberships', 'roleMismatches', 'statusMismatches', 'orphanMemberships',
    'underivableRole', 'underivableStatus', 'removedMarkerNotDisabled',
  ];
  for (const gap of gaps) {
    const counts = { ...COMPLETE, [gap]: 1 };
    assert.equal(readyForAuthority(counts), false, gap);
    const { deps } = harness(counts);
    const r = await runMembershipCoverage({ organizationSlug: 'acme' }, deps);
    assert.equal(r.overall, 'READ', gap);
    assert.equal(r.readyForAuthority, false, gap);
  }
});

test('output is counts only: no id, email or name can be printed', async () => {
  const { deps, lines } = harness();
  await runMembershipCoverage({ organizationSlug: 'acme' }, deps);
  const out = lines.join('\n');
  assert.equal(out.includes('org_acme'), false, 'not even the organization id');
  assert.equal(/@|userId|email|name=/i.test(out), false);
});

test('only DATABASE_URL is required', () => {
  assert.deepEqual(readEnvironment({} as NodeJS.ProcessEnv), { ok: false, missing: ['DATABASE_URL'] });
  assert.deepEqual(readEnvironment({ DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv), { ok: true });
});

test('the runner has no mutation path and reaches no other machinery', () => {
  for (const symbol of [
    'create(', 'update(', 'upsert(', 'delete(', 'syncMembership', 'backfill(', 'repair',
    'activateUser', 'disableUser', 'softRemoveUser', 'prepareInvitation', 'updateUserRole',
    'recordLogin', 'createUser', '$executeRaw', '$queryRaw', 'fetch(',
  ]) {
    assert.ok(!RUNNER_CODE.includes(symbol), `the runner must not name ${symbol}`);
  }
  assert.ok(!/prisma\.\w+\./.test(RUNNER_CODE), 'persistence goes through the repository');
  assert.ok(!/\bSELECT\s|\bINSERT\s|\bUPDATE\s+\w+\s+SET\b/.test(RUNNER_CODE));
});

test('the workflow is human-started only, proves safety before reading, and interpolates no input', () => {
  assert.ok(WORKFLOW_SOURCE.includes('workflow_dispatch:'));
  for (const trigger of ['\n  schedule:', '\n  push:', '\n  pull_request:', '\n  workflow_call:']) {
    assert.ok(!WORKFLOW_SOURCE.includes(trigger), `no ${trigger.trim()}`);
  }
  const proof = WORKFLOW_SOURCE.indexOf('test:operations');
  const read = WORKFLOW_SOURCE.indexOf('read:membership-coverage');
  assert.ok(proof > 0 && proof < read);
  assert.ok(!WORKFLOW_SOURCE.includes('migrate deploy'));
  const runBodies = WORKFLOW_SOURCE.split(/\n\s+run: \|/).slice(1);
  for (const body of runBodies) {
    const step = body.split(/\n\s+- name:/)[0] ?? '';
    assert.ok(!/\$\{\{\s*inputs\./.test(step), 'no input interpolated into a run body');
  }
});

test('flags parse in either spelling', () => {
  assert.deepEqual(parseArgs(['--organization', 'acme']), { organization: 'acme' });
  assert.deepEqual(parseArgs(['--org', ' acme ']), { organization: 'acme' });
  assert.deepEqual(parseArgs([]), { organization: '' });
});
