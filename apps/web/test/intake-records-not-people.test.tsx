// Intake Records are not People (C-04), and Customer merge is gone (PD-I2-05).
//
// Legacy Customer rows are Intake Records: transitional intake infrastructure, not
// canonical identity. People are established PERSON Parties, served by the Party
// read models. Existing screens called Customer rows "People" in at least nine
// places; this pins the smallest wording correction C-04 allows, without
// redesigning any screen.
//
// /crm/merge repointed one record's conversations, interactions, bookings, orders,
// service requests and signals onto another, keyed on a shared email or phone. A
// contact value is not identity and a merge is never Party resolution, so the page,
// its server action and the repository methods behind them are removed. Historical
// `metadata.mergedInto` markers are kept.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(WEB, 'src');
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const read = (p: string) => readFileSync(join(REPO, p), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('Screens over Customer rows say Intake Records, never People', () => {
  const customerSurfaces = [
    'apps/web/src/app/crm/customers/page.tsx',
    'apps/web/src/app/crm/customers/[id]/page.tsx',
    'apps/web/src/app/crm/page.tsx',
    'apps/web/src/app/crm/pipeline/page.tsx',
    'apps/web/src/app/crm/organizations/[id]/page.tsx',
    'apps/web/src/app/crm/analytics/page.tsx',
    'apps/web/src/app/crm/live/LiveFeed.tsx',
    'apps/web/src/crm/search-data.ts',
  ];

  it('no visible text on a Customer surface names its rows People or Person', () => {
    for (const file of customerSurfaces) {
      const src = code(read(file));
      assert.doesNotMatch(src, />\s*People\b|['"`]People\b|\bPeople (Added|added)|Total People|View People|Person \/ Intake|<th>Person<\/th>|No people|people across|Search people/, file);
    }
  });

  it('the navigation item over /crm/customers is Intake Records', () => {
    assert.match(code(read('apps/web/src/workspaces/config.ts')), /\{ href: '\/crm\/customers', label: 'Intake Records'/);
  });

  it('no copy claims calls or visitors create intake records', () => {
    for (const file of ['apps/web/src/app/crm/page.tsx', 'apps/web/src/app/crm/pipeline/page.tsx', 'apps/web/src/app/crm/organizations/[id]/page.tsx']) {
      assert.doesNotMatch(code(read(file)), /arrive through calls|enter through intake, calls/, file);
    }
  });

  it('the Brain metric over Customer rows is Intake Records added, and its area is intake, not a sales pipeline', () => {
    const data = code(read('apps/web/src/app/app/admin/_executive/executive-brain-data.ts'));
    assert.match(data, /label: 'Intake Records added'/);
    assert.doesNotMatch(data, /'Sales pipeline'|label: 'People added'/);
  });
});

describe('Customer merge is removed', () => {
  it('the /crm/merge route no longer exists', () => {
    assert.equal(existsSync(join(SRC, 'app', 'crm', 'merge')), false);
  });

  it('no server action, repository method or page writes or detects a merge', () => {
    const sources = walk(SRC).filter((p) => /\.(ts|tsx)$/.test(p));
    for (const file of sources) {
      const src = code(readFileSync(file, 'utf8'));
      assert.doesNotMatch(src, /mergeCustomers|findDuplicates|action: 'customer\.merged'/, relative(REPO, file));
    }
    const repo = code(read('packages/database/src/repositories/conversations.repository.ts'));
    assert.doesNotMatch(repo, /mergeCustomers|findDuplicates|DuplicateGroup|MergeResult/);
  });

  it('merged-away records stay refused by the governed link service', () => {
    assert.match(code(read('packages/database/src/services/customer-party-link.service.ts')), /CUSTOMER_MERGED/);
  });
});
