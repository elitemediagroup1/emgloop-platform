// Website journeys against a REAL Postgres (2026-10-05). OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL.
//
// Proves: admitted events become per-session journeys (page views and session starts included -- they were never
// Interactions), in order, grouped by property + session; a returning browser is recognized; another organization's
// session is not-found; a legacy payload holding a URL query or contact detail shows only minimized attributes; a
// capped scan says it is partial.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { WebsiteProvider, mapWebsiteEventType } from '@emgloop/providers';

import { WebPropertyRepository } from '../src/repositories/web-property.repository';
import { WebsiteJourneyRepository } from '../src/repositories/website-journey.repository';
import { admitWebsiteDelivery } from '../src/services/website/website-ingress';
import { IngestionService } from '../src/services/ingestion.service';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;
const DAY = 864e5;

test('website journeys against Postgres', { skip }, async (t) => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  t.after(() => prisma.$disconnect());
  const properties = new WebPropertyRepository(prisma);
  const journeys = new WebsiteJourneyRepository(prisma);
  const provider = new WebsiteProvider();
  const now = new Date();
  const at = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000).toISOString();

  async function org(label: string) {
    const id = `org_jrn_${label}_${randomUUID().slice(0, 8)}`;
    await prisma.organization.create({ data: { id, name: `JRN ${label}`, slug: id.toLowerCase().replace(/_/g, '-') } });
    return id;
  }
  async function liveProperty(organizationId: string) {
    const key = `jrn-${randomUUID().slice(0, 8)}`;
    await properties.register(organizationId, { key, primaryDomain: `${key}.example` });
    await properties.transitionLifecycle(organizationId, key, 'LIVE', now);
    await properties.setIngestion(organizationId, key, 'ENABLED');
    return key;
  }
  async function send(key: string, events: Record<string, unknown>[]) {
    const parsed = await provider.parseWebhook({ organizationId: '', credentials: {}, config: {} }, { property: key, events });
    const admission = await admitWebsiteDelivery(properties, { tier: 'SIGNED', enforceDomain: true, events: parsed });
    for (const b of admission.batches) {
      await new IngestionService(prisma).ingest({ observationSource: 'WEBHOOK', organizationId: b.organizationId, provider: 'website', mapEventType: mapWebsiteEventType, events: b.events });
    }
  }
  const id = () => randomUUID();

  const A = await org('a');
  const B = await org('b');
  const site = await liveProperty(A);
  const other = await liveProperty(B);
  const visitor = `v-${id()}`;
  const s1 = `s-${id()}`;
  const s2 = `s-${id()}`;
  // Visit 1 (two days ago), visit 2 (today) from the same browser; plus another organization's visit.
  await send(site, [
    { event: 'session_start', id: id(), timestamp: at(2 * 24 * 60), visitorId: visitor, sessionId: s1, page: '/', referrer: 'https://www.google.com/search?q=plumber' },
    { event: 'page_view', id: id(), timestamp: at(2 * 24 * 60), visitorId: visitor, sessionId: s1, page: '/', referrer: 'https://www.google.com/search?q=plumber' },
  ]);
  await send(site, [
    { event: 'session_start', id: id(), timestamp: at(30), visitorId: visitor, sessionId: s2, page: '/?utm_campaign=secret', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'Spring Sale' },
    { event: 'page_view', id: id(), timestamp: at(30), visitorId: visitor, sessionId: s2, page: '/?utm_campaign=secret', utm_source: 'google', utm_medium: 'cpc', email: 'jane@example.com' },
    { event: 'scroll_depth', id: id(), timestamp: at(29), visitorId: visitor, sessionId: s2, page: '/', depth: 75 },
    { event: 'heartbeat', id: id(), timestamp: at(28), visitorId: visitor, sessionId: s2, page: '/' },
    { event: 'search_performed', id: id(), timestamp: at(27), visitorId: visitor, sessionId: s2, page: '/', query: 'burst pipe near me' },
    { event: 'zip_search', id: id(), timestamp: at(26), visitorId: visitor, sessionId: s2, page: '/', query: '10001' },
    { event: 'page_view', id: id(), timestamp: at(25), visitorId: visitor, sessionId: s2, page: '/plumbers' },
    { event: 'cta_click', id: id(), timestamp: at(24), visitorId: visitor, sessionId: s2, page: '/plumbers', cta: 'Get quotes' },
    { event: 'form_submitted', id: id(), timestamp: at(22), visitorId: visitor, sessionId: s2, page: '/plumbers', form: 'quote', phone: '5551234567' },
  ]);
  await send(other, [{ event: 'page_view', id: id(), timestamp: at(10), visitorId: `v-${id()}`, sessionId: `s-${id()}`, page: '/secret' }]);

  await t.test('recent sessions: page views and session starts are in the journey; grouped per session; newest first; returning recognized', async () => {
    const list = await journeys.recentSessions(A, { since: new Date(now.getTime() - 7 * DAY), now });
    assert.equal(list.complete, true);
    const mine = list.sessions.filter((s) => s.propertyKey === site);
    assert.deepEqual(mine.map((s) => s.sessionId), [s2, s1], 'newest activity first');
    const today = mine[0]!;
    assert.equal(today.visitor, 'RETURNING');
    assert.equal(mine[1]!.visitor, 'NEW');
    assert.equal(today.counts.pageViews, 2);
    assert.equal(today.counts.searches, 2);
    assert.equal(today.counts.ctaClicks, 1);
    assert.equal(today.counts.formSubmits, 1);
    assert.deepEqual(today.traffic, { kind: 'CAMPAIGN', source: 'google', medium: 'cpc' });
    assert.deepEqual(mine[1]!.traffic, { kind: 'REFERRAL', referrerHost: 'www.google.com' });
    assert.equal(today.landingPage, '/');
    assert.equal(today.exitPage, '/plumbers');
    assert.equal(list.sessions.some((s) => s.propertyKey === other), false, "another organization's visits never appear");
  });

  await t.test('one session: chronological steps, scroll per page, the browser\'s visits -- nothing the minimizer dropped', async () => {
    const d = (await journeys.session(A, site, s2, now))!;
    assert.equal(d.visitor, 'RETURNING');
    assert.deepEqual(d.journey.steps.map((s) => s.eventType), ['web.session_start', 'web.page_view', 'web.search', 'web.search_zip', 'web.page_view', 'web.cta_click', 'web.form_submit']);
    assert.equal(d.journey.steps.find((s) => s.eventType === 'web.search_zip')!.detail, '10001');
    assert.equal(d.journey.steps.find((s) => s.eventType === 'web.search')!.detail, null, 'free-text search is never shown (never stored)');
    assert.deepEqual(d.journey.pages.map((p) => [p.path, p.maxScroll]), [['/', 75], ['/plumbers', null]]);
    assert.deepEqual(d.visitorSessions.map((v) => v.sessionId), [s2, s1]);
    const text = JSON.stringify(d);
    assert.doesNotMatch(text, /Spring Sale|utm_campaign|secret|jane@|5551234567|burst pipe|\?q=/);
  });

  await t.test('tenancy: another organization\'s session is not-found; malformed input is not-found', async () => {
    const theirs = await journeys.recentSessions(B, { since: new Date(now.getTime() - 7 * DAY), now });
    assert.equal(theirs.sessions.length, 1);
    assert.equal(await journeys.session(B, site, s2, now), null);
    assert.equal(await journeys.session(A, theirs.sessions[0]!.propertyKey, theirs.sessions[0]!.sessionId, now), null);
    assert.equal(await journeys.session(A, 'Bad Key', s2, now), null);
    assert.equal(await journeys.session(A, site, "s'; drop", now), null);
  });

  await t.test('a legacy payload with a URL query or contact detail contributes only minimized attributes', async () => {
    const legacySession = `s-${id()}`;
    await prisma.integrationEvent.create({ data: { organizationId: A, provider: 'website', externalId: `legacy-${id()}`, eventType: 'web.page_view', occurredAt: new Date(now.getTime() - 5 * 60_000), payload: { property: site, sessionId: legacySession, visitorId: 'v-legacy', page: '/thanks?email=jane@example.com', url: 'https://x/?q=1', email: 'jane@example.com', event: 'page_view' } } });
    const d = (await journeys.session(A, site, legacySession, now))!;
    assert.equal(d.journey.landingPage, '/thanks');
    assert.doesNotMatch(JSON.stringify(d), /jane@|\?q=|email=/);
  });

  await t.test('a multi-page visit through ingestion: page leaves (new and legacy) fold into time on page; clicks are steps', async () => {
    const s3 = `s-${id()}`;
    const v3 = `v-${id()}`;
    await send(site, [
      { event: 'session_start', id: id(), timestamp: at(20), visitorId: v3, sessionId: s3, page: '/' },
      { event: 'page_view', id: id(), timestamp: at(20), visitorId: v3, sessionId: s3, page: '/' },
      { event: 'link_click', id: id(), timestamp: at(19), visitorId: v3, sessionId: s3, page: '/', cta: 'Plumbers', elementType: 'link', destination: '/plumbers?email=jane@example.com' },
      { event: 'page_leave', id: id(), timestamp: at(19), visitorId: v3, sessionId: s3, page: '/' },
      { event: 'page_view', id: id(), timestamp: at(18.9), visitorId: v3, sessionId: s3, page: '/plumbers' },
      { event: 'button_click', id: id(), timestamp: at(17), visitorId: v3, sessionId: s3, page: '/plumbers', cta: 'Compare', elementType: 'button' },
      { event: 'session_end', id: id(), timestamp: at(16), visitorId: v3, sessionId: s3, page: '/plumbers' },
      { event: 'page_view', id: id(), timestamp: at(5), visitorId: v3, sessionId: s3, page: '/' },
    ]);
    const d = (await journeys.session(A, site, s3, now))!;
    assert.deepEqual(d.journey.steps.map((s) => s.eventType), ['web.session_start', 'web.page_view', 'web.link_click', 'web.page_view', 'web.button_click', 'web.page_view']);
    assert.equal(d.journey.steps.find((s) => s.eventType === 'web.link_click')!.detail, 'Plumbers → /plumbers');
    assert.deepEqual(d.journey.path, ['/', '/plumbers', '/']);
    assert.equal(d.journey.exitPage, '/');
    assert.equal(d.journey.pages.find((p) => p.path === '/plumbers')!.timeOnPageMs, Math.round(2.9 * 60_000));
    const stored = await prisma.integrationEvent.findMany({ where: { organizationId: A, provider: 'website', eventType: { in: ['web.page_leave', 'web.session_end'] } }, select: { eventType: true } });
    assert.ok(stored.length >= 2 && stored.every((r) => r.eventType === 'web.page_leave'), 'the legacy session_end is stored as a page leave');
    assert.doesNotMatch(JSON.stringify(d), /jane|email=/);
  });

  await t.test('a capped scan keeps the newest sessions and says it is partial', async () => {
    const capped = await new WebsiteJourneyRepository(prisma, 3).recentSessions(A, { since: new Date(now.getTime() - 7 * DAY), now });
    assert.equal(capped.complete, false);
    assert.equal(capped.scannedEvents, 3);
  });
});
