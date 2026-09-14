// CRM Governed Search — Phase 1 authority and semantic contract.
//
// WHAT THESE PROVE
//
// 1. The search page requires customers:view before any data read.
// 2. Conversation results are gated on inbox:view (soft check, not hard deny).
// 3. Organization results are gated on organizations:view (soft check).
// 4. All repository calls pass the organization from the session context.
// 5. No result is labeled as Opportunity, Pipeline, commercial Company, or Relationship.
// 6. Customer results are labeled as Person / Intake Record.
// 7. Organization results are labeled as Workspace Organization.
// 8. The query is persisted in the URL (method=get, action=/crm/search).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const PAGE = code(read('../src/app/crm/search/page.tsx'));
// The reads and result typing moved into src/crm/search-data.ts; the page keeps
// authorization, URL handling and rendering. Both are held to this contract.
const DATA = code(read('../src/crm/search-data.ts'));
const SEARCH = PAGE + '\n' + DATA;

test('1. search requires customers:view before reading data', () => {
  const permIdx = PAGE.indexOf("requirePermission('customers', 'view')");
  const contextIdx = PAGE.indexOf('requireCrmContext');
  const repoIdx = PAGE.indexOf('runSearch(crmRepos');
  assert.notEqual(repoIdx, -1, 'the page hands the repositories to runSearch');
  assert.notEqual(permIdx, -1, 'requirePermission is called');
  assert.notEqual(contextIdx, -1, 'requireCrmContext is called');
  assert.ok(permIdx < repoIdx, 'permission check precedes data access');
});

test('2. conversation results are gated on inbox:view', () => {
  assert.match(SEARCH, /hasPermission\('inbox',\s*'view'\)/);
  assert.match(SEARCH, /canViewConversations/);
});

test('3. organization results are gated on organizations:view', () => {
  assert.match(SEARCH, /hasPermission\('organizations',\s*'view'\)/);
  assert.match(SEARCH, /canViewOrganizations/);
});

test('4. every repository call uses organizationId from the session', () => {
  assert.match(SEARCH, /requireCrmContext\(\)/);
  assert.match(PAGE, /runSearch\(crmRepos, organizationId,/, 'the page passes the session organization');
  const customerCall = DATA.match(/listCustomers\(([^,)]+)/);
  assert.ok(customerCall, 'listCustomers is called');
  assert.match(customerCall![1]!, /organizationId/, 'customer search is org-scoped');
  const convoCall = DATA.match(/listConversations\(([^,)]+)/);
  assert.ok(convoCall, 'listConversations is called');
  assert.match(convoCall![1]!, /organizationId/, 'conversation search is org-scoped');
  const orgCall = DATA.match(/findById\(([^)]+)\)/);
  assert.ok(orgCall, 'findById is called');
  assert.match(orgCall![1]!, /organizationId/, 'org lookup uses session org');
});

test('5. no result is labeled as Opportunity, Pipeline, commercial Company or Relationship', () => {
  assert.equal(/Opportunity/i.test(SEARCH), false, 'no Opportunity label');
  assert.equal(/Pipeline/i.test(SEARCH), false, 'no Pipeline label');
  assert.equal(/commercial Company/i.test(SEARCH), false, 'no commercial Company label');
  // "Relationship" may appear in the context of "commercial Relationship" but not as a result type
  assert.equal(/kind.*['":].*relationship/i.test(SEARCH), false, 'no Relationship result kind');
});

test('6. customer results are labeled as Person / Intake Record', () => {
  assert.match(SEARCH, /Person \/ Intake Record/);
});

test('7. organization results are labeled as Workspace Organization', () => {
  assert.match(SEARCH, /Workspace Organization/);
});

test('8. search form persists query in URL', () => {
  assert.match(SEARCH, /method=["']get["']/);
  assert.match(SEARCH, /action=["']\/crm\/search["']/);
  assert.match(SEARCH, /name=["']q["']/);
});

test('9. no cross-org data access (organization only returns the session org)', () => {
  // Search only checks findById(organizationId) — never lists all orgs
  assert.equal(/listSummaries/.test(SEARCH), false, 'does not list all organizations');
  assert.equal(/findBySlug/.test(SEARCH), false, 'does not search by slug');
});
