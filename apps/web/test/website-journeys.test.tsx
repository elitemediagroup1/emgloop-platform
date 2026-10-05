// Live Websites -> Website Visitors (2026-10-05): journeys, not a flat feed of Interactions.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { actionSummary, trafficLabel } from '../src/app/crm/live/websites/journey-format';

const SRC = join(__dirname, '..', 'src');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

describe('Website Visitors pages', () => {
  for (const page of ['app/crm/live/websites/page.tsx', 'app/crm/live/websites/session/page.tsx']) {
    it(`${page}: a guarded server page that reads through repositories in the session's organization`, () => {
      const src = read(page);
      assert.doesNotMatch(src, /^'use client'/m, 'server-rendered');
      assert.match(src, /await requirePermission\('intelligence', 'view'\)/);
      assert.match(src, /session\.organizationId/, 'the organization comes from the signed session');
      assert.doesNotMatch(src, /\bprisma\b/, 'no direct Prisma');
      assert.match(src, /viewerTime\(\)/, "times are the reader's");
      assert.match(src, /crmRepos\.websiteJourneys\./);
      assert.doesNotMatch(src, /searchParams\??\.(organization|org)/, 'no organization from the request');
    });
  }

  it('the old Interaction feed is retired: no /api/live/websites, no websites variant, no hard-coded property list', () => {
    assert.equal(existsSync(join(SRC, 'app/api/live/websites/route.ts')), false);
    const feed = read('app/crm/live/LiveFeed.tsx');
    assert.doesNotMatch(feed, /'websites'|renderWebsites|PropertyOption/);
    assert.doesNotMatch(read('app/crm/live/websites/page.tsx'), /EMG_PROPERTIES|LiveFeed/);
    assert.match(read('app/crm/live/websites/page.tsx'), /crmRepos\.webProperties\.listForOrganization/, 'properties come from the registry');
  });

  it('the journey never shows what the minimizer drops', () => {
    const src = read('app/crm/live/websites/session/page.tsx') + read('app/crm/live/websites/page.tsx');
    assert.doesNotMatch(src, /\.campaign\b|\.query\b|\.email\b|\.phone\b|\.url\b/);
  });

  it('display helpers: traffic and a glanceable action summary', () => {
    assert.equal(trafficLabel({ kind: 'CAMPAIGN', source: 'google', medium: 'cpc' }), 'google / cpc');
    assert.equal(trafficLabel({ kind: 'REFERRAL', referrerHost: 'www.bing.com' }), 'www.bing.com');
    assert.equal(trafficLabel({ kind: 'DIRECT' }), 'Direct');
    const zero = { pageViews: 3, ctaClicks: 0, phoneClicks: 0, emailClicks: 0, outboundClicks: 0, downloads: 0, searches: 0, formStarts: 0, formSubmits: 0, appointmentRequests: 0, chat: 0, planner: 0 };
    assert.equal(actionSummary(zero), 'Browsing only');
    assert.equal(actionSummary({ ...zero, searches: 2, formSubmits: 1, phoneClicks: 1 }), '2 searches · form submitted · phone click');
  });
});
