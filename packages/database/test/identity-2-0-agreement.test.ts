// Identity Slice 2.0: the pure contracts agree with the authorities that enforce them.
//
// `@emgloop/shared` cannot import this package, so agreement is held here:
//   - every identity act's required action is held by exactly the roles the
//     decision record names, in the live IDENTITY_RESOLUTION_GRANTS, and never by
//     AI_EMPLOYEE;
//   - the establishment bases available today are exactly what PartyService
//     accepts: MANUAL and EXPLICIT_LINK;
//   - the use-policy vocabularies mirror the Prisma enums they will be stored in;
//   - nothing new writes identity evidence. The only writer is the dormant
//     cognitive repository, reached only by the dormant resolver retired in 2.1a.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ConsentBasis, GovernancePolicyStatus } from '@prisma/client';
import {
  IDENTITY_ACTS,
  IDENTITY_ESTABLISHMENT_METHODS_AVAILABLE_NOW,
  EVIDENCE_LEGAL_BASES,
  EVIDENCE_USE_POLICY_STATUSES,
  identityActRule,
  type IdentityResolutionAction,
} from '@emgloop/shared';
import { IDENTITY_RESOLUTION_GRANTS, matrixAllows } from '../src/repositories/iam.repository';
import { PARTY_ESTABLISHMENT_BASES } from '../src/services/party.service';

const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY', 'AI_EMPLOYEE'];

/** The holders the decision record (section 6) names for each action. */
const RECORD_HOLDERS: Record<IdentityResolutionAction, string[]> = {
  view: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE', 'READ_ONLY'],
  create: ['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'],
  update: ['OWNER', 'ADMIN', 'MANAGER'],
  approve: ['OWNER', 'ADMIN'],
};

test('every human identity act is held by exactly the roles the decision record names, and never by AI_EMPLOYEE', () => {
  assert.deepEqual(Object.keys(IDENTITY_RESOLUTION_GRANTS).sort(), [...ROLES].sort());
  for (const act of IDENTITY_ACTS) {
    const action = identityActRule(act).requiredAction;
    if (action === null) continue;
    const holders = ROLES.filter((role) => (IDENTITY_RESOLUTION_GRANTS[role] ?? []).includes(action));
    assert.deepEqual(holders, RECORD_HOLDERS[action], `${act} requires ${action}`);
    for (const role of ROLES) {
      assert.equal(matrixAllows(role, 'identityResolution', action), holders.includes(role), `${act} ${role}`);
    }
    assert.equal(matrixAllows('AI_EMPLOYEE', 'identityResolution', action), false);
    assert.equal(matrixAllows('UNKNOWN_ROLE', 'identityResolution', action), false);
  }
});

test('establishment bases available today are exactly what PartyService accepts', () => {
  assert.deepEqual([...PARTY_ESTABLISHMENT_BASES].sort(), ['EXPLICIT_LINK', 'MANUAL']);
  assert.deepEqual([...IDENTITY_ESTABLISHMENT_METHODS_AVAILABLE_NOW].sort(), [...PARTY_ESTABLISHMENT_BASES].sort());
});

test('use-policy vocabularies mirror the enums DataGovernancePolicy will store them in', () => {
  assert.deepEqual([...EVIDENCE_USE_POLICY_STATUSES].sort(), Object.values(GovernancePolicyStatus).sort());
  assert.deepEqual(
    [...EVIDENCE_LEGAL_BASES].sort(),
    Object.values(ConsentBasis).filter((b) => b !== 'NONE').sort(),
  );
});

// --- Fence: no new identity evidence writers ------------------------------------

const REPO = join(__dirname, '..', '..', '..');
const SOURCE_ROOTS = ['packages', 'apps'];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.next', 'dist', '.turbo', 'test', 'e2e'].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  for (const root of SOURCE_ROOTS) walk(join(REPO, root));
  return out;
}

test('fence: only the dormant cognitive repository writes identity evidence, and only the dormant resolver calls it', () => {
  const directWriters: string[] = [];
  const repositoryWriters: string[] = [];
  for (const file of sourceFiles()) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(REPO, file);
    if (/identityEvidence\s*\.\s*(create|createMany|upsert|update|updateMany|delete|deleteMany)\b/.test(src)) directWriters.push(rel);
    if (/identity_evidence/.test(src) && /\$executeRaw|\$queryRaw/.test(src)) directWriters.push(`${rel} (raw SQL)`);
    if (/identityEvidence\s*\.\s*(record|revoke)\s*\(/.test(src)) repositoryWriters.push(rel);
  }
  assert.deepEqual(directWriters, ['packages/database/src/repositories/cognitive/identity.repository.ts']);
  assert.deepEqual(repositoryWriters, ['packages/database/src/services/cognitive/identity-resolution.ts']);
});
