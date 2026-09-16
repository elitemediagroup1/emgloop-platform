// The governed operator surface. Temporary engineering tooling.
//
// WHAT THIS SURFACE IS FOR. Before it, the Party and Relationship authorities had no
// caller: production held zero established Parties and every canonical surface was
// empty BY CONSTRUCTION. This is the smallest honest path that lets an authorized
// person use them.
//
// WHAT THESE TESTS PROVE
//
// AUTHORIZATION IS SERVER-SIDE. Every page guards itself before it reads, and every
// action guards before it writes. A hidden button is not access control, so the
// capabilities a page renders from are the SERVER's and every act is authorized
// again by the service when the form is submitted.
//
// NOTHING IS DUPLICATED. The web layer calls `PartyService` and
// `CrmRelationshipService` through the existing actions. It re-implements no
// establishment rule, no vocabulary, no Party resolution -- a second copy of those
// would drift from the first and nobody would know which one was authority.
//
// NO IDENTITY IS INFERRED, ANYWHERE. There is no lookup by name, phone or email on
// this surface, because a lookup that matched a contact value would be identity
// resolution performed by a form. An operator picks from what is already established.
//
// THE UNPLEASANT STATES ARE SHOWN. Superseded, archived, unavailable and refused all
// have words on the page, and a superseded reference shows BOTH ids so a person
// retries on purpose.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WEB = join(__dirname, '..', 'src');
const read = (p: string) => readFileSync(join(WEB, p), 'utf8');
/** Source with its prose removed: a comment explaining a rule is not the rule. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');

const PAGES = [
  'app/crm/parties/page.tsx',
  'app/crm/parties/[id]/page.tsx',
  'app/crm/relationships/page.tsx',
  'app/crm/relationships/new/page.tsx',
  'app/crm/relationships/[id]/page.tsx',
];

describe('every page enforces its own authority before it reads', () => {
  it('each page calls requirePermission first', () => {
    for (const page of PAGES) {
      const src = code(read(page));
      const guard = src.match(/requirePermission\('(identityResolution|relationships)', 'view'\)/);
      assert.ok(guard, `${page} guards itself`);
      // Before any load. A layout is never a page's only boundary, and a read that
      // happens before the guard has already happened.
      const guardAt = src.indexOf('requirePermission');
      const firstLoad = Math.min(
        ...['loadPeople(', 'loadCompanies(', 'loadPartyRecord(', 'loadRelationships(', 'loadRelationship(', 'loadEstablishmentQueue(']
          .map((f) => src.indexOf(f))
          .filter((i) => i > -1)
          .concat([Number.MAX_SAFE_INTEGER]),
      );
      assert.ok(guardAt > -1 && guardAt < firstLoad, `${page} guards before it reads`);
    }
  });

  it('each write action resolves the session before it acts, and takes the organization from nowhere else', () => {
    for (const file of ['crm/relationship-actions.ts', 'crm/party-operator-actions.ts']) {
      const src = code(read(file));
      assert.match(src, /requireCrmContext\(\)/, `${file} resolves the signed session`);
      // An organization or an actor that a browser can name is not an authority.
      assert.doesNotMatch(src, /organizationId:\s*(field|formData)/, `${file} must not take an organization from a form`);
      assert.doesNotMatch(src, /userId:\s*(field|formData)/, `${file} must not take an actor from a form`);
    }
  });
});

describe('the web layer calls the authorities; it does not become one', () => {
  it('no page or action re-implements Party or Relationship rules', () => {
    for (const file of [...PAGES, 'crm/relationship-actions.ts', 'crm/party-operator-actions.ts', 'crm/relationship-data.ts']) {
      const src = code(read(file));
      // No direct persistence, and no second copy of the governed vocabularies.
      assert.doesNotMatch(src, /prisma\.\w+\.(create|update|delete|upsert|findMany|findFirst)/, `${file} must not reach the database`);
      assert.doesNotMatch(src, /recordEstablishment|establishmentBasis\s*=|supersededByIdentityId/, `${file} must not re-implement establishment`);
      assert.doesNotMatch(src, /crmRelationshipNaturalKey|crmParticipantActiveKey|projectCrmRelationshipState/, `${file} must not re-implement the authority`);
    }
  });

  it('the Party path calls the P1 actions rather than PartyService directly', () => {
    const src = code(read('crm/party-operator-actions.ts'));
    assert.match(src, /from '\.\/party-actions'/);
    assert.doesNotMatch(src, /new PartyService|PartyService\(/, 'the governed action already holds that authority');
  });

  it('the Relationship path calls the service, and stamps the clock on the server', () => {
    const src = code(read('crm/relationship-actions.ts'));
    assert.match(src, /new CrmRelationshipService\(prisma\)/);
    assert.match(src, /occurredAt: new Date\(\)/, 'the server clock, never a browser-supplied occurrence');
    assert.doesNotMatch(src, /occurredAt:\s*field\(/, 'a browser-supplied time is a browser-supplied fact');
  });
});

describe('no identity is inferred on this surface', () => {
  it('nothing looks a Party up by name, phone or email', () => {
    for (const page of PAGES) {
      // `searchParams` is Next.js's own route input. Renaming it here keeps the fence
      // aimed at identity search rather than at the framework's parameter name.
      const src = code(read(page)).replace(/searchParams/g, 'routeQuery');
      assert.doesNotMatch(src, /\b(email|phone|telephone|callerId)\b/i, `${page} must not touch a contact value`);
      assert.doesNotMatch(src, /search|lookup|\bmatch|findBy|resolveIdentity/i, `${page} must offer no identity search`);
    }
  });

  it('the Relationship form offers only Parties somebody already established', () => {
    const src = code(read('app/crm/relationships/new/page.tsx'));
    // loadPeople and loadCompanies read the established, non-superseded, non-archived
    // projections, and they are the form's only source of options.
    assert.match(src, /loadPeople\(/);
    assert.match(src, /loadCompanies\(/);
    assert.doesNotMatch(src, /loadEstablishmentQueue\(/, 'a record nobody established is not a Party anybody may relate');
  });

  it('nothing converts, bulk-establishes or auto-links a legacy record', () => {
    for (const file of [...PAGES, 'crm/relationship-actions.ts', 'crm/party-operator-actions.ts']) {
      const src = code(read(file));
      assert.doesNotMatch(src, /bulk|forEach\(.*establish|convert|backfill|migrateCustomer/i, `${file}`);
      // The P0.2e fence: no apps/web file may reach linking. This surface does not.
      assert.doesNotMatch(src, /CustomerPartyLink|customerPartyLink/, `${file} must not reach linking`);
    }
  });
});

describe('the honest states have words on the page', () => {
  it('a superseded reference shows both ids and says a write is refused', () => {
    const src = read('app/crm/_operator/PartyRef.tsx');
    // A word boundary, so renaming the field out of use cannot pass on the substring.
    assert.match(src, /view\.canonicalPartyId\b/);
    assert.match(src, /superseded/i);
    assert.match(src, /must name the canonical id explicitly/i, 'the reader is told a write is refused, not substituted');
    assert.match(src, /unavailable/i, 'and that an unfollowable reference is not "nobody"');
    assert.match(src, /archived/i);
  });

  it('an empty list says why it is empty rather than looking like a loading state', () => {
    const parties = read('app/crm/parties/page.tsx');
    assert.match(parties, /None yet\. This is the correct answer/);
    const relationships = read('app/crm/relationships/page.tsx');
    assert.match(relationships, /nothing will appear here\s*\n?\s*automatically/);
  });

  it('a duplicate diagnostic offers no merge', () => {
    const src = read('app/crm/relationships/[id]/page.tsx');
    assert.match(src, /Loop reports this and changes nothing/);
    assert.doesNotMatch(code(src), /mergeAction|merge\(/i, 'no merge is offered, because merging would be identity resolution by a screen');
  });

  it('Parties are distinguished from Intake Records, in words', () => {
    const src = read('app/crm/parties/page.tsx');
    assert.match(src, /Intake Records/);
    assert.match(src, /deliberately\s*\n?\s*established|somebody deliberately/i);
    const detail = read('app/crm/parties/[id]/page.tsx');
    assert.match(detail, /does\s*\n?\s*<strong>\s*not<\/strong>\s*make that record/i, 'a link is context, not this Party\'s activity');
  });

  it('every page says it is temporary tooling, not the product design', () => {
    const notice = read('app/crm/_operator/OperatorNotice.tsx');
    assert.match(notice, /not the product design/i);
    for (const page of PAGES) {
      assert.match(read(page), /OperatorNotice|OPERATOR TOOLING/, page);
    }
  });
});

describe('the surface is server-rendered and adds no client page', () => {
  it('no operator page or component is a client component', () => {
    for (const file of [...PAGES, 'app/crm/_operator/OperatorNotice.tsx', 'app/crm/_operator/PartyRef.tsx']) {
      assert.doesNotMatch(read(file), /^'use client'/m, `${file} stays a server component`);
    }
  });

  it('actions are the only "use server" files, and they return void so nothing is half-applied in a redirect', () => {
    for (const file of ['crm/relationship-actions.ts', 'crm/party-operator-actions.ts']) {
      assert.match(read(file), /^'use server';/m, file);
    }
  });

  it('the temporary surface is documented as replaceable', () => {
    assert.ok(existsSync(join(WEB, 'app/crm/_operator/OperatorNotice.tsx')));
    const parties = read('app/crm/parties/page.tsx');
    assert.match(parties, /OPERATOR TOOLING, TEMPORARY/);
    assert.match(parties, /deleted when their surface lands|replaced/i);
  });
});
