// What the web surfaces say about activity that belongs to no Person.
//
// Ingestion no longer creates or matches People, so most calls and website
// activity carry no Person, and the People count stops counting every caller and
// visitor. Three things had to change with that, and each is pinned here:
//
//   - A call or visit with no Person is labelled as unidentified, not as an
//     unknown customer or a blank.
//   - The People count is labelled as what it is (People added), and nothing
//     reads it as conversion: the Brain no longer compares it across windows,
//     and no correlation rule reasons from it.
//   - The seeded call workflows, which could only ever act on a Customer, are
//     gone from the live organization bootstrap.
//
// Source-level, because these are labels and definitions spread across server
// pages, a client leaf and the Brain's metric wiring.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

describe('Activity with no Person is labelled as unidentified', () => {
  it('Live Calls names the column Person and says Unidentified caller when there is none', () => {
    const feed = code(read('apps/web/src/app/crm/live/LiveFeed.tsx'));
    assert.match(feed, /<th>Person<\/th>/);
    assert.doesNotMatch(feed, /<th>Customer<\/th>/);
    assert.match(feed, /'Unidentified caller'/);
  });

  it('a live website session with no Person says Unidentified visitor', () => {
    assert.match(code(read('apps/web/src/app/crm/live/LiveFeed.tsx')), /Unidentified visitor/);
  });

  it('the Brain rail never renders an empty label for a call with no Person and no caller ID', () => {
    assert.match(
      code(read('apps/web/src/app/app/admin/brain/page.tsx')),
      /c\.customerName \|\| c\.caller \|\| 'Unidentified caller'/,
    );
  });
});

describe('The People count is labelled as what it is, and is not read as conversion', () => {
  it('the Command Center says People added, not new', () => {
    const page = code(read('apps/web/src/app/crm/page.tsx'));
    assert.match(page, /People Added This Week/);
    assert.match(page, /added this week/);
    assert.doesNotMatch(page, /New This Week|No new this week/);
  });

  it('Analytics says People Added, not New Customers', () => {
    const page = code(read('apps/web/src/app/crm/analytics/page.tsx'));
    assert.match(page, />People Added</);
    assert.doesNotMatch(page, /New Customers/);
  });

  it('the Brain measures People added without comparing it to the prior window', () => {
    const data = code(read('apps/web/src/app/app/admin/_executive/executive-brain-data.ts'));
    const line = data.split('\n').find((l) => l.includes("metricId: 'crm.new_customers'"));
    assert.ok(line, 'the metric is still reported');
    assert.match(line!, /label: 'People added'/);
    assert.doesNotMatch(line!, /trackChange:\s*true/, 'no period comparison');
    assert.doesNotMatch(line!, /prior:/, 'no prior window to compare with');
    assert.match(line!, /not leads or conversions/, 'the provenance says what the count is not');
  });

  it('no correlation rule reasons from People added', () => {
    assert.doesNotMatch(
      code(read('packages/intelligence/src/executive/correlation.ts')),
      /crm\.new_customers|sales-bottleneck/,
    );
  });
});

describe('The live organization seeds no customer-step call workflows', () => {
  it('ensureLiveOrganization creates no workflow', () => {
    const src = code(read('apps/web/src/crm/live-org.ts'));
    assert.doesNotMatch(src, /createWorkflow|ensureWorkflow|integration\.call\./);
  });
});
