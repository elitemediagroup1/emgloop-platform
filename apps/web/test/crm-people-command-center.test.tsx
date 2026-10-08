// The People command center's web surface (CRM slice 6): guards, thin actions, honest wording,
// responsive table, no client code, no contact value in a form, and the person timeline wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTimeView, deriveCrmOutreach } from '@emgloop/shared';

import { cadenceText, dueText, factTime, lastTouchText, mailFreshnessText, replyText } from '../src/crm/outreach-display';

const SRC = join(__dirname, '..', 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const PAGES = {
  people: 'app/app/crm/people/page.tsx',
  person: 'app/app/crm/people/[partyId]/page.tsx',
  discover: 'app/app/crm/people/discover/page.tsx',
};
const TIME = createTimeView({ timeZone: 'UTC', source: 'preference' }, new Date('2026-10-08T15:00:00Z'));

test('every command-center page guards itself before any read, and none is a client component', () => {
  for (const [name, file] of Object.entries(PAGES)) {
    const src = code(read(file));
    const guard = src.indexOf("await requirePermission('identityResolution', 'view')");
    assert.ok(guard > 0, `${name} guards itself`);
    for (const r of ['readPeopleCommand(', 'readDiscovery(', 'readPersonOutreach(']) {
      const at = src.indexOf(r);
      if (at >= 0) assert.ok(guard < at, `${name}: guard before ${r}`);
    }
    assert.equal(src.includes("'use client'"), false, name);
  }
  assert.equal(read('crm/person-outreach.tsx').includes("'use client'"), false);
});

test('actions are thin: the session is the only source of organization and actor, and discovery forms carry a hash, never an address', () => {
  const actions = code(read('crm/outreach-actions.ts'));
  assert.match(actions, /^'use server';/m);
  assert.equal(/field\(form, '(organizationId|userId|orgId|email|address)'\)/.test(actions), false);
  assert.match(actions, /requireCrmContext\(\)/);
  for (const call of ['outreach.setState(', 'outreach.setNextAction(', 'outreach.recordNote(', 'outreach.retractFact(', 'discovery.add(', 'discovery.dismiss(', 'discovery.restore(']) {
    assert.ok(actions.includes(call), call);
  }
  assert.equal(/auditLog|stateChangeOutbox|prisma\.\w+\.(create|update)/.test(actions), false, 'no second authority in the web layer');
  const discover = code(read(PAGES.discover));
  assert.match(discover, /name="candidate" value=\{c\.correspondentHash\}/);
  assert.equal(/name="(email|address|value)"/.test(discover), false, 'the address is re-read server-side from the viewer’s own mail');
  assert.match(discover, /No company, opportunity, relationship or affiliation is created/);
});


test('Possible New People copy includes inbound-first discovery and does not claim outbound-only eligibility', () => {
  const discover = code(read(PAGES.discover));
  assert.match(discover, /contacted you directly/);
  assert.match(discover, /legitimate inbound-first contacts/);
  assert.equal(discover.includes('Only addresses you wrote to directly are considered'), false);
});

test('the People list keeps the identity-review boundary, stacks on a phone, and never shows an Opportunity stage', () => {
  const people = code(read(PAGES.people));
  assert.match(people, /className="loop-table"/);
  const cells = people.match(/<td[\s>][^]*?>/g) ?? [];
  assert.ok(cells.length >= 8);
  assert.ok(cells.slice(1).every((c) => /data-label=/.test(c)), 'every cell after the first is labelled for the stacked phone layout');
  assert.equal(/stage:\s|opportunity\.stage|Opportunity stage/.test(people), false);
  assert.match(people, /pageCrmPeople\(result\.rows, parsed\.filters, parsed\.page, now\)/, 'filtering and paging are server-side');
  assert.match(people, /summarizeCrmPeople\(result\.rows, now\)/, 'counts trace to rows');
  assert.match(people, /refused=contact/);
});

test('the person page shows outreach only for an established person, and links mail to the viewer’s own thread', () => {
  const person = code(read(PAGES.person));
  assert.match(person, /state === 'ESTABLISHED' \? \(await readPersonOutreach\(record\.partyId\)\)\.result : null/);
  const panel = code(read('crm/person-outreach.tsx'));
  assert.match(panel, /href=\{`\/app\/mail\/\$\{encodeURIComponent\(e\.threadId\)\}`\}/);
  assert.match(panel, /only you see this/);
  assert.match(panel, /not a Relationship, an affiliation or an Opportunity/);
});

test('wording is honest about Gmail: a stale read says so with its time; unavailable never reads as "no reply"', () => {
  const sent = [new Date('2026-10-01T09:00:00Z')];
  const fresh = { state: 'FRESH' as const, observedFrom: null, observedThrough: new Date('2026-10-08T14:00:00Z') };
  const stale = { state: 'STALE' as const, observedFrom: null, observedThrough: new Date('2026-10-02T14:00:00Z') };
  const base = { humanReplies: [], automated: [], uncertain: [], importedLastContact: null, human: null, nextMeetingAt: null, now: TIME.now, timeZone: 'UTC' };
  const o = deriveCrmOutreach({ ...base, mail: fresh, sends: sent });
  assert.match(replyText(o, fresh, TIME), /^No reply observed through /);
  assert.match(replyText(deriveCrmOutreach({ ...base, mail: stale, sends: sent }), stale, TIME), /^No reply observed through .*\(Gmail data stale\)$/, 'the read time and that it is stale');
  assert.equal(replyText(deriveCrmOutreach({ ...base, mail: { state: 'UNAVAILABLE' }, sends: sent }), { state: 'UNAVAILABLE' }, TIME), 'Gmail data unavailable');
  assert.match(mailFreshnessText({ state: 'UNAVAILABLE' }, TIME), /^Gmail data unavailable/);
  assert.match(mailFreshnessText(stale, TIME), /^Gmail data stale/);
  assert.match(dueText(o, TIME), /^Overdue/);
  assert.match(cadenceText(o), /3-day #1/);
  assert.match(lastTouchText(o, TIME), /Gmail$/);
  assert.equal(factTime(null, 'UNKNOWN', TIME), 'Unknown time');
  assert.equal(factTime(new Date('2026-08-01T00:00:00Z'), 'DATE', TIME), '2026-08-01 (date only)');
});
