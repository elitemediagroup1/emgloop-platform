// CRM slice 4: the organization-wide staff Opportunities surface.
//
// The authority behaviour (PD-F-11 VIEW per role, tenancy, projection, privacy, pagination,
// bounded queries) is proven against Postgres in packages/database/test/crm-opportunity-read.postgres.test.ts.
// This proves the web side holds the same lines:
//   - both pages guard themselves with the permission their nav item states, before any read;
//   - the nav entry states that authority and nothing else;
//   - no role strings decide access in the pages, nothing is a client component, no AI widget;
//   - the list reads no contact point; the record asks only the Contact Point authority;
//   - importer directory statuses are never stages;
//   - the wording helpers keep unknown unknown, name every BRAND and contact, and refuse contact
//     values as search text.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOOP_NAV } from '../src/workspaces/config';
import {
  GAP_LABELS,
  PRIMARY_CONTACT_WORDING,
  amountText,
  categoryText,
  opportunitiesListHref,
  opportunityHref,
  ownerText,
  parseOpportunityFilters,
  partyRefDisplay,
  partyRefsText,
} from '../src/crm/opportunity-display';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const LIST = 'app/app/crm/opportunities/page.tsx';
const RECORD = 'app/app/crm/opportunities/[opportunityId]/page.tsx';

describe('Opportunities pages', () => {
  it('guard themselves with opportunities:view before any read, and stay server components', () => {
    for (const [file, readCall] of [[LIST, 'readOpportunities('], [RECORD, 'readOpportunity(']] as const) {
      const src = code(read(file));
      const guard = src.indexOf("await requirePermission('opportunities', 'view')");
      assert.ok(guard > 0, `${file} guards itself`);
      assert.ok(guard < src.indexOf(readCall), `${file}: guard before the read`);
      assert.equal(src.includes("'use client'"), false, file);
    }
    assert.ok(existsSync(join(SRC, 'app/app/crm/opportunities/loading.tsx')), 'the list has a loading state');
    assert.match(code(read(RECORD)), /if \(read\.outcome === 'NOT_FOUND'\) notFound\(\);/, 'a foreign or missing id is not found');
    assert.match(code(read(RECORD)), /<ReadFailed what="this opportunity" \/>/);
  });

  it('the nav entry states the PD-F-11 authority and sits in the CRM group', () => {
    const crm = LOOP_NAV.nav.find((g) => g.label === 'CRM')!;
    const item = crm.items.find((i) => i.href === '/app/crm/opportunities');
    assert.ok(item);
    assert.deepEqual(item!.requires, { resource: 'opportunities', action: 'view' });
    assert.equal(item!.workspace, undefined, 'any workspace whose role holds the permission');
    assert.equal(Boolean(item!.folded) || Boolean(item!.soon), false);
  });

  it('no role string decides what a viewer may see; no AI; no importer status', () => {
    for (const file of [LIST, RECORD, 'crm/opportunity-display.ts']) {
      const src = code(read(file));
      assert.equal(/'(OWNER|MANAGER|EMPLOYEE|READ_ONLY|AI_EMPLOYEE|CREATOR)'/.test(src), false, `${file} names no role`);
      assert.equal(/brainWork|BrainWorkState|readAiControlFloor|@emgloop\/brain|ai-runtime|\bmodel\b/i.test(src), false, `${file} has no AI widget`);
      assert.equal(/Not due|Historical|Other hold|Human reply|Excluded|Pending draft/.test(src), false, `${file} maps no directory status`);
      assert.equal(/mailto:|tel:|sms:/.test(src), false, file);
    }
    // The one workspace check is the Person page's existing rule for the admin-only Creator Hub link.
    assert.match(code(read(RECORD)), /resolveWorkspaceRole\(session\) === 'ADMIN'/);
  });

  it('the list reads no contact point; the record asks only the Contact Point authority, per contact', () => {
    const list = code(read(LIST));
    assert.equal(/readContactPoints|ContactPoint|crmContactPoint/.test(list), false);
    const record = code(read(RECORD));
    assert.match(record, /readContactPoints\(/);
    assert.equal(/crmContactPoint|revealValues|prisma/.test(record), false, 'no direct read, no reimplemented masking');
    assert.match(record, /<ContactPointList read=\{points\}/);
    assert.match(code(read('app/app/crm/people/[partyId]/page.tsx')), /<ContactPointList read=\{contactPoints\}/, 'one rendering for Person and Opportunity');
  });

  it('writes nothing: no server action, no form that posts (the filter form is a GET to the list)', () => {
    for (const file of [LIST, RECORD]) {
      const src = code(read(file));
      assert.equal(/'use server'|formAction|-actions'/.test(src), false, `${file} imports or declares no server action`);
      for (const form of src.match(/<form\b[^>]*>/g) ?? []) {
        assert.match(form, /method="get" action=\{OPPORTUNITIES_HREF\}/, `${file}: the only form is the GET filter`);
      }
    }
  });
});

describe('Opportunity wording', () => {
  it('a Party reference is worded from what the authority said, never guessed', () => {
    assert.deepEqual(partyRefDisplay({ state: 'ESTABLISHED', partyId: 'p1', partyType: 'COMPANY', archived: false, name: 'Acme' }), {
      text: 'Acme',
      named: true,
      note: null,
      openPartyId: 'p1',
    });
    assert.equal(partyRefDisplay({ state: 'ESTABLISHED', partyId: 'p1', partyType: 'COMPANY', archived: false, name: null }).text, 'A company (name not shown)');
    assert.equal(partyRefDisplay({ state: 'NOT_ESTABLISHED', partyId: 'p1', partyType: 'PERSON', archived: true, name: 'Pat' }).note, 'Not established · Archived');
    const merged = partyRefDisplay({ state: 'SUPERSEDED', partyId: 'old', canonicalPartyId: 'new', partyType: 'PERSON', name: 'Sam' });
    assert.deepEqual([merged.text, merged.openPartyId], ['Sam', 'new']);
    assert.deepEqual(partyRefDisplay({ state: 'UNAVAILABLE', partyId: 'x', name: null }), {
      text: 'Unavailable record',
      named: false,
      note: 'This reference cannot be followed in this workspace.',
      openPartyId: null,
    });
  });

  it('several brands are all named; none is the absence of one; an absent owner is Unassigned', () => {
    const ref = (name: string) => ({ state: 'ESTABLISHED', partyId: name, partyType: 'COMPANY', archived: false, name }) as const;
    assert.equal(partyRefsText([ref('Acme'), ref('Zen')], 'No brand recorded'), 'Acme, Zen');
    assert.equal(partyRefsText([], 'No brand recorded'), 'No brand recorded');
    assert.equal(ownerText(null), 'Unassigned');
    assert.equal(ownerText({ state: 'MEMBER', userId: 'u', displayName: null }), 'A workspace member');
    assert.equal(ownerText({ state: 'UNAVAILABLE', userId: 'u', displayName: null }), 'Not a member of this workspace');
    assert.deepEqual(Object.values(GAP_LABELS), ['No owner', 'No brand', 'No primary contact']);
    assert.equal(PRIMARY_CONTACT_WORDING, 'Primary contact for this Opportunity');
  });

  it('category is the governed value, a stage is the organization\'s own label, an amount never invents a currency', () => {
    assert.equal(categoryText('CLOSED_WON'), 'Closed – won');
    assert.equal(categoryText('OPEN'), 'Open');
    assert.equal(amountText(null, 'USD'), null);
    assert.equal(amountText(125000, 'USD'), 'USD 1250.00');
    assert.equal(amountText(125000, null), '1250.00 (currency not recorded)');
  });

  it('filters: unknown values dropped, contact values refused, no organization in a URL', () => {
    const ok = parseOpportunityFilters({ q: '  Acme ', owner: 'ME', category: 'BOGUS', brand: 'MISSING', contact: 'maybe', stage: 'Pitching' });
    assert.ok(ok.ok);
    assert.deepEqual(ok.filters, { q: 'Acme', owner: 'ME', category: null, stage: 'Pitching', creatorPartyId: null, brand: 'MISSING', primaryContact: null });
    for (const q of ['pat@brand.com', '+1 (415) 555-0100', '4155550100']) {
      const refused = parseOpportunityFilters({ q, owner: 'NONE' });
      assert.equal(refused.ok, false, q);
      assert.equal(JSON.stringify(refused).includes(q), false, 'the refused text is not carried on');
      assert.equal(opportunitiesListHref(refused.params).includes('415'), false);
    }
    assert.equal(parseOpportunityFilters({ q: 'Launch 2026-10-01' }).ok, true, 'a date is not a phone number');
    assert.equal(parseOpportunityFilters({ q: 'x'.repeat(500) }).ok && parseOpportunityFilters({ q: 'x'.repeat(500) }).params.q?.length, 100);
    const href = opportunitiesListHref({ q: 'Acme', owner: 'ME', organizationId: 'org_1' } as never, 'cur');
    assert.equal(href, '/app/crm/opportunities?q=Acme&owner=ME&after=cur');
    assert.equal(opportunityHref('o/1'), '/app/crm/opportunities/o%2F1');
  });
});
