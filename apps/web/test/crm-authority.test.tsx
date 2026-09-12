// CRM Phase Zero — the authority the legacy CRM assumed and never checked.
//
// WHAT THESE PROVE
//
// AUTHORIZATION IS ON THE SERVER PATH, NOT THE SCREEN. Every CRM customer and
// pipeline mutation names a resource and an action before it writes, and the
// five record surfaces that had no check at all now have the one the matrix has
// defined since Sprint 7. Until this PR a READ_ONLY member -- granted
// `customers: view` and nothing else -- could restage, retag, reassign and edit
// every customer in the tenant, because the actions established only that
// somebody was signed in.
//
// TENANCY IS PASSED, NOT ASSUMED. Every repository call from these actions
// carries the organization from the session, so the data layer can resolve the
// row within it rather than trusting the call site to have checked.
//
// NO FABRICATED CONFIDENCE. The CRM rendered `confidence 70%` from a constant in
// a rule body. Loop has no ungoverned confidence, and a percentage beside an
// observation is read as a measurement of how sure the system is.
//
// These are source-level assertions because the subject is what the server path
// does before it writes; the behavioural half lives in the database suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const ACTIONS = code(read('../src/crm/actions.ts'));

/** Every exported server action in the CRM customer surface. */
const MUTATIONS = [
  'addNoteAction',
  'setStatusAction',
  'addTagAction',
  'removeTagAction',
  'setAssignmentAction',
  'updateCustomerFieldsAction',
  'bulkSetStatusAction',
  'bulkAddTagAction',
  'bulkAssignAction',
  'movePipelineAction',
];

function bodyOf(source: string, name: string): string {
  const from = source.indexOf(`export async function ${name}`);
  assert.notEqual(from, -1, `${name} exists`);
  const next = source.indexOf('export async function ', from + 10);
  return source.slice(from, next === -1 ? undefined : next);
}

test('1. every CRM mutation checks a permission before it writes', () => {
  for (const name of MUTATIONS) {
    const body = bodyOf(ACTIONS, name);
    assert.match(
      body,
      /requirePermission\('(customers|pipeline)', 'update'\)/,
      `${name} must name a resource and an action`,
    );
  }
});

test('2. pipeline moves are gated on the pipeline resource, not on customers', () => {
  // The matrix grants these separately, and a person who may not move deals is
  // not the same as one who may not edit a contact.
  for (const name of ['setStatusAction', 'bulkSetStatusAction', 'movePipelineAction']) {
    assert.match(bodyOf(ACTIONS, name), /requirePermission\('pipeline', 'update'\)/, name);
  }
});

test('3. no CRM mutation takes its organization from the form', () => {
  assert.equal(/formData\.get\(['"`]organizationId/.test(ACTIONS), false);
  // It comes from the session context, once, in every action.
  for (const name of MUTATIONS) {
    assert.match(bodyOf(ACTIONS, name), /requireCrmContext\(\)/, name);
  }
});

test('4. every repository call passes the organization through', () => {
  // The data layer resolves the row within the organization, so the call must
  // carry it. A call with a bare id is the shape this PR removed.
  const calls = ACTIONS.match(/crmRepos\.crm\.\w+\([^)]*/g) ?? [];
  assert.ok(calls.length >= 9, 'the customer mutations are all here');
  for (const call of calls) {
    if (/listAssignees|kanbanBoard|listCustomers|listTags|statusCounts|inboxFeed/.test(call)) continue;
    assert.match(call, /\(\s*organizationId/, call);
  }
});

test('5. the five record surfaces that had no check now have one', () => {
  const pages: Array<[string, RegExp]> = [
    ['../src/app/crm/customers/page.tsx', /requirePermission\('customers', 'view'\)/],
    ['../src/app/crm/customers/[id]/page.tsx', /requirePermission\('customers', 'view'\)/],
    ['../src/app/crm/pipeline/page.tsx', /requirePermission\('pipeline', 'view'\)/],
    ['../src/app/crm/inbox/page.tsx', /requirePermission\('customers', 'view'\)/],
    ['../src/app/crm/search/page.tsx', /requirePermission\('customers', 'view'\)/],
  ];
  for (const [path, expected] of pages) {
    assert.match(code(read(path)), expected, path);
  }
});

test('6. the CRM no longer renders a confidence percentage', () => {
  const page = read('../src/app/crm/intelligence/page.tsx');
  assert.equal(/confidence \{Math\.round/.test(page), false);
  assert.equal(/d\.confidence/.test(code(page)), false);

  // And the rule bodies no longer carry a number for it to render.
  const repo = code(read('../../../packages/database/src/repositories/intelligence.repository.ts'));
  assert.equal(/confidence:\s*0\./.test(repo), false, 'no hardcoded confidence literal');
  assert.equal(/confidence/.test(repo), false, 'and no confidence field at all');
});

test('7. no CRM path writes a Headline, a Finding or a Case', () => {
  // CRM records what commercially happened. Deciding what it means is
  // Commercial Intelligence's, and a direct path from a CRM mutation to an
  // intelligence conclusion is the coupling Phase Zero exists to prevent.
  const crmSources = [
    '../src/crm/actions.ts',
    '../src/crm/crm-data.ts',
    '../src/crm/workflow-actions.ts',
  ].map((p) => code(read(p)));
  for (const source of crmSources) {
    for (const forbidden of [/Headline/, /CaseFindingService/, /DecisionEngine/, /recordFinding/]) {
      assert.equal(forbidden.test(source), false, `must not reference ${forbidden}`);
    }
  }
});
