// Governed website evidence against a REAL Postgres (2026-09-30). OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL,
// migrated through 20261009000000_website_evidence_foundation.
//
// Proves: tenancy comes only from a registered property (an unregistered property, a foreign origin, a claimed
// organization or another organization's property key selects nothing); the number of properties is whatever is
// registered; heartbeat / scroll / identify are stored as themselves and never counted as page views; no email or
// phone is persisted; redelivery dedupes without a clock-derived id; reads are exact past the old 5,000-row
// ceiling; organization A never reads organization B's website evidence; aggregate windows keep null apart from
// zero and PRELIMINARY apart from FINAL; a sealed organization credential does not open for another organization;
// and the raw telemetry purge cannot touch a WEB_LEAD.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { EMPTY_SOURCE_WINDOW_QUALITY, type WebsiteSourceWindow } from '@emgloop/shared';
import { WebsiteProvider, mapWebsiteEventType } from '@emgloop/providers';

import { WebPropertyRepository } from '../src/repositories/web-property.repository';
import { admitWebsiteDelivery } from '../src/services/website/website-ingress';
import { IngestionService } from '../src/services/ingestion.service';
import { WebsiteAnalyticsRepository } from '../src/repositories/website-analytics.repository';
import { SourceMetricWindowRepository } from '../src/repositories/source-metric-window.repository';
import { OrganizationConnectionRepository } from '../src/repositories/organization-connection.repository';
import { OrganizationCredentialSealer, OrganizationCredentialUnopenable } from '../src/services/connections/organization-credential-sealer';
import { WebsiteTelemetryRetentionRepository } from '../src/repositories/website-telemetry-retention.repository';
import { IntakeEligibilityRepository } from '../src/repositories/intake-eligibility.repository';
import { WebsiteEvidenceStateRepository } from '../src/repositories/intelligence/website-evidence-state.repository';
import { websiteCoveragePort } from '../src/services/intelligence-fabric/website-coverage';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;

const provider = new WebsiteProvider();
const DAY = 864e5;

async function org(prisma: PrismaClient, label: string): Promise<string> {
  const id = `org_web_${label}_${randomUUID().slice(0, 8)}`;
  await prisma.organization.create({ data: { id, name: `WEB ${label}`, slug: id.toLowerCase().replace(/_/g, '-') } });
  return id;
}

function key(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}`;
}

async function register(repo: WebPropertyRepository, organizationId: string, k: string, domains = ['example.com']) {
  const r = await repo.register(organizationId, { key: k, allowedDomains: domains });
  assert.ok(r.outcome === 'REGISTERED' || r.outcome === 'UNCHANGED', `registered ${k}: ${JSON.stringify(r)}`);
}

async function parse(body: Record<string, unknown>) {
  return provider.parseWebhook({ organizationId: '', credentials: {}, config: {} }, body);
}

/** Admit and ingest a delivery the way the webhook does; returns the admission. */
async function deliver(prisma: PrismaClient, input: { tier: 'BROWSER' | 'SIGNED'; ingestKey?: string; originHost?: string; enforceDomain?: boolean; body: Record<string, unknown> }) {
  const events = await parse(input.body);
  const admission = await admitWebsiteDelivery(new WebPropertyRepository(prisma), {
    tier: input.tier,
    ingestKey: input.ingestKey,
    originHost: input.originHost ?? '',
    enforceDomain: input.enforceDomain ?? true,
    events,
  });
  const service = new IngestionService(prisma);
  for (const b of admission.batches) {
    await service.ingest({ observationSource: 'WEBHOOK', organizationId: b.organizationId, provider: 'website', mapEventType: mapWebsiteEventType, events: b.events });
  }
  return admission;
}

/** The Interactions website ingestion wrote (intent-bearing events only). */
async function websiteRows(prisma: PrismaClient, organizationId: string) {
  return prisma.interaction.findMany({ where: { organizationId, provider: 'website' }, select: { metadata: true, payload: true, customerId: true } });
}

test('website evidence against Postgres', { skip }, async (t) => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const properties = new WebPropertyRepository(prisma);
  t.after(() => prisma.$disconnect());

  const A = await org(prisma, 'a');
  const B = await org(prisma, 'b');
  const kA = key('site-a');
  const kB = key('site-b');
  await register(properties, A, kA, ['a-site.example']);
  await register(properties, B, kB, ['b-site.example']);

  await t.test('4: an unregistered property is refused PROPERTY_UNREGISTERED and nothing is written anywhere', async () => {
    const before = await prisma.integrationEvent.count({ where: { provider: 'website' } });
    const browser = await deliver(prisma, { tier: 'BROWSER', ingestKey: `pk_emg_${key('nobody')}`, originHost: 'a-site.example', body: { events: [{ event: 'page_view', id: 'u1' }] } });
    assert.equal(browser.refusal, 'PROPERTY_UNREGISTERED');
    assert.equal(browser.batches.length, 0);
    const signed = await deliver(prisma, { tier: 'SIGNED', body: { property: key('nobody'), events: [{ event: 'page_view', id: 'u2' }] } });
    assert.deepEqual(signed.rejected, [{ index: 0, code: 'PROPERTY_UNREGISTERED' }]);
    const missing = await deliver(prisma, { tier: 'SIGNED', body: { events: [{ event: 'page_view', id: 'u3' }] } });
    assert.deepEqual(missing.rejected, [{ index: 0, code: 'PROPERTY_MISSING' }]);
    assert.equal(await prisma.integrationEvent.count({ where: { provider: 'website' } }), before, 'no default organization received anything');
  });

  await t.test('3: a browser-supplied domain or organization cannot select an organization', async () => {
    const foreign = await deliver(prisma, { tier: 'BROWSER', ingestKey: `pk_emg_${kA}`, originHost: 'attacker.example', body: { events: [{ event: 'page_view', id: 'd1' }] } });
    assert.equal(foreign.refusal, 'DOMAIN_NOT_ALLOWED');
    assert.equal(foreign.refusedProperty?.organizationId, A, 'the refusal is attributable to the property owner, and only diagnostics use it');
    const noOrigin = await deliver(prisma, { tier: 'BROWSER', ingestKey: `pk_emg_${kA}`, originHost: '', body: { events: [{ event: 'page_view', id: 'd2' }] } });
    assert.equal(noOrigin.refusal, 'MISSING_ORIGIN');
    // A request naming organization B (and B's domain as the origin) with A's key lands in A or nowhere.
    const claimsB = await deliver(prisma, { tier: 'BROWSER', ingestKey: `pk_emg_${kA}`, originHost: 'b-site.example', body: { organization: B, events: [{ event: 'page_view', id: 'd3', organization: B }] } });
    assert.equal(claimsB.refusal, 'DOMAIN_NOT_ALLOWED');
    const ok = await deliver(prisma, { tier: 'BROWSER', ingestKey: `pk_emg_${kA}`, originHost: 'www.a-site.example', body: { organization: B, events: [{ event: 'page_view', id: 'd4', organization: B, page: '/x' }] } });
    assert.equal(ok.refusal, null);
    assert.deepEqual(ok.batches.map((b) => b.organizationId), [A]);
    assert.equal(await prisma.integrationEvent.count({ where: { organizationId: B, provider: 'website' } }), 0);
  });

  await t.test("1: organization A's site cannot ingest into organization B's property", async () => {
    const r = await deliver(prisma, { tier: 'BROWSER', ingestKey: `pk_emg_${kA}`, originHost: 'a-site.example', body: { events: [{ event: 'page_view', id: 'x1', property: kB }, { event: 'page_view', id: 'x2' }] } });
    assert.deepEqual(r.rejected, [{ index: 0, code: 'PROPERTY_MISMATCH' }]);
    assert.deepEqual(r.batches.map((b) => [b.organizationId, b.events.length]), [[A, 1]]);
    assert.equal(await prisma.integrationEvent.count({ where: { organizationId: B, provider: 'website' } }), 0, "nothing reached B's evidence");
    // The ingestion fence: a row another organization holds under the same key is never taken over.
    const [ev] = await parse({ property: kB, events: [{ event: 'page_view', id: 'shared-1' }] });
    await new IngestionService(prisma).ingest({ observationSource: 'WEBHOOK', organizationId: B, provider: 'website', mapEventType: mapWebsiteEventType, events: [ev!] });
    await prisma.integrationEvent.updateMany({ where: { provider: 'website', externalId: ev!.externalId }, data: { status: 'FAILED' } });
    const res = await new IngestionService(prisma).ingest({ observationSource: 'WEBHOOK', organizationId: A, provider: 'website', mapEventType: mapWebsiteEventType, events: [ev!] });
    assert.equal(res[0]!.status, 'failed');
    assert.equal((await prisma.integrationEvent.findFirst({ where: { provider: 'website', externalId: ev!.externalId } }))!.organizationId, B);
    assert.equal(await prisma.integrationEvent.count({ where: { organizationId: A, provider: 'website', externalId: ev!.externalId } }), 0);
  });

  await t.test('5: the number of properties is whatever is registered -- a new one works with no code change', async () => {
    const C = await org(prisma, 'c');
    const extra = [key('p1'), key('p2'), key('p3')];
    for (const k of extra) await register(properties, C, k, ['c-site.example']);
    const r = await deliver(prisma, { tier: 'SIGNED', body: { events: extra.map((k, i) => ({ event: 'page_view', id: `n${i}`, property: k })) } });
    assert.deepEqual(r.rejected, []);
    assert.equal(r.batches.length, extra.length);
    assert.ok(r.batches.every((b) => b.organizationId === C));
    assert.equal((await properties.listForOrganization(C)).length, extra.length);
    await properties.setStatus(C, extra[0]!, 'DISABLED');
    const d = await deliver(prisma, { tier: 'SIGNED', body: { events: [{ event: 'page_view', id: 'n9', property: extra[0] }] } });
    assert.deepEqual(d.rejected, [{ index: 0, code: 'PROPERTY_DISABLED' }]);
  });

  await t.test('a key registered to one organization is never moved by another registration', async () => {
    const r = await properties.register(B, { key: kA, allowedDomains: ['b-site.example'] });
    assert.deepEqual(r, { outcome: 'REFUSED', problems: ['KEY_REGISTERED_ELSEWHERE'] });
    assert.equal((await properties.resolveForIngest(kA))!.organizationId, A);
    assert.equal(await properties.findForOrganization(B, kA), null, "another organization's property is not-found");
    // One external property -> one Loop property -> one organization (the confused-deputy guard).
    const ga4 = String(Date.now()).slice(-9);
    assert.equal((await properties.register(A, { key: kA, allowedDomains: ['a-site.example'], ga4PropertyId: ga4 })).outcome, 'UPDATED');
    assert.deepEqual(await properties.register(B, { key: kB, allowedDomains: ['b-site.example'], ga4PropertyId: ga4 }), { outcome: 'REFUSED', problems: ['GA4_PROPERTY_BOUND_ELSEWHERE'] });
    assert.deepEqual(await properties.previewRegistration(B, { key: kB, allowedDomains: ['b-site.example'], ga4PropertyId: ga4 }), { outcome: 'REFUSED', problems: ['GA4_PROPERTY_BOUND_ELSEWHERE'] });
    assert.equal((await properties.findForOrganization(B, kB))!.ga4PropertyId, null);
  });

  await t.test('6/7/8/10/11/12: telemetry stored as itself, no contact detail persisted, redelivery dedupes', async () => {
    const D = await org(prisma, 'd');
    const kD = key('site-d');
    await register(properties, D, kD, ['d-site.example']);
    const t0 = '2026-09-30T10:00:00.000Z';
    const body = {
      property: kD,
      events: [
        { event: 'page_view', id: 'e1', page: '/plumbers?zip=10001', timestamp: t0, email: 'jane@example.com', phone: '5551234567', visitorId: 'v1', sessionId: 's1' },
        { event: 'heartbeat', id: 'e2', visible: true, timestamp: t0 },
        { event: 'scroll_depth', id: 'e3', depth: 50, timestamp: t0 },
        { event: 'identify', id: 'e4', email: 'jane@example.com', phone: '5551234567', timestamp: t0 },
        { event: 'phone_click', id: 'e5', phone_target: '+15551234567', cta: 'Call (555) 123-4567', timestamp: t0 },
        { event: 'search_performed', timestamp: t0, query: 'jane@example.com burst pipe' },
      ],
    };
    await deliver(prisma, { tier: 'SIGNED', body });
    await deliver(prisma, { tier: 'SIGNED', body }); // redelivery
    const events = await prisma.integrationEvent.findMany({ where: { organizationId: D, provider: 'website' }, select: { eventType: true, externalId: true, payload: true } });
    assert.equal(events.length, 6, 'a redelivery dedupes -- including the event without a sender id');
    assert.deepEqual(events.map((e) => e.eventType).sort(), ['web.heartbeat', 'web.identify', 'web.page_view', 'web.phone_click', 'web.scroll_depth', 'web.search']);
    const rows = await websiteRows(prisma, D);
    assert.equal(rows.length, 2, 'only intent-bearing events become Interactions (phone click, search)');
    const stored = JSON.stringify(rows) + JSON.stringify(events);
    assert.doesNotMatch(stored, /jane|5551234567|123-4567|15551234567|zip=10001|burst/);
    assert.ok(rows.every((r) => r.customerId === null), 'website telemetry attaches no Person');
    assert.ok(events.every((e) => e.externalId!.startsWith(`web:${kD}:`)));
    const analytics = await new WebsiteAnalyticsRepository(prisma).getWebsiteAnalytics(D, new Date(Date.parse(t0) - DAY), new Date(Date.parse(t0) + DAY));
    assert.equal(analytics.totals.pageViews, 1, 'heartbeat, scroll and identify are not page views');
    assert.equal(analytics.totals.events, 6);
    assert.equal(analytics.topLandingPages[0]!.label, '/plumbers');
    assert.equal(await prisma.signal.count({ where: { organizationId: D, key: 'web_preference' } }), 3, 'telemetry derives no signals (the page view, phone click and search do)');
  });

  await t.test('legacy rows: a heartbeat stored as web.page_view before the fix is not counted, and its PII is never shown', async () => {
    const E = await org(prisma, 'e');
    const at = new Date('2026-09-01T12:00:00Z');
    await prisma.integrationEvent.createMany({ data: [
      { organizationId: E, provider: 'website', externalId: `legacy-${E}-1`, eventType: 'web.page_view', occurredAt: at, payload: { event: 'heartbeat', page: '/p?email=jane@example.com', email: 'jane@example.com' } },
      { organizationId: E, provider: 'website', externalId: `legacy-${E}-2`, eventType: 'web.page_view', occurredAt: at, payload: { event: 'page_view', page: '/p?email=jane@example.com', cta: 'Call 555 123 4567' } },
    ] });
    const a = await new WebsiteAnalyticsRepository(prisma).getWebsiteAnalytics(E, new Date(at.getTime() - DAY), new Date(at.getTime() + DAY));
    assert.equal(a.totals.pageViews, 1);
    assert.equal(a.totals.events, 2);
    assert.deepEqual(a.topLandingPages, [{ label: '/p', count: 1 }]);
    assert.doesNotMatch(JSON.stringify(a), /jane|555/);
  });

  await t.test('13: reads are exact beyond the old 5,000-row ceiling, and a bounded scan says it is partial', async () => {
    const F = await org(prisma, 'f');
    const start = new Date('2026-08-01T00:00:00Z');
    const rows = Array.from({ length: 5_300 }, (_, i) => ({
      organizationId: F, provider: 'website', externalId: `bulk-${F}-${i}`,
      occurredAt: new Date(start.getTime() + i * 1000),
      // The sessions and form submissions arrive AFTER row 5,000 -- exactly what `take: 5000` dropped.
      eventType: i < 5_100 ? 'web.page_view' : i < 5_200 ? 'web.session_start' : 'web.form_submit',
      payload: i < 5_100 ? { page: '/p' } : {},
    }));
    await prisma.integrationEvent.createMany({ data: rows });
    const end = new Date(start.getTime() + 6_000 * 1000);
    const a = await new WebsiteAnalyticsRepository(prisma).getWebsiteAnalytics(F, start, end);
    assert.equal(a.totals.events, 5_300);
    assert.equal(a.totals.sessions, 100);
    assert.equal(a.totals.formSubmits, 100);
    assert.equal(a.totals.pageViews, 5_100);
    assert.equal(a.rankingsComplete, true);
    assert.deepEqual(a.topLandingPages, [{ label: '/p', count: 5_100 }]);
    const bounded = await new WebsiteAnalyticsRepository(prisma, 1_000).getWebsiteAnalytics(F, start, end);
    assert.equal(bounded.totals.sessions, 100, 'totals are never capped');
    assert.equal(bounded.totals.pageViews, 5_100);
    assert.equal(bounded.rankingsComplete, false, 'a capped scan says so');
    assert.equal(bounded.scannedEvents, 1_000);
  });

  await t.test('2: organization A never reads organization B website evidence', async () => {
    const G = await org(prisma, 'g');
    const H = await org(prisma, 'h');
    const kG = key('site-g');
    const kH = key('site-h');
    await register(properties, G, kG, ['g.example']);
    await register(properties, H, kH, ['h.example']);
    const t0 = '2026-09-29T10:00:00.000Z';
    await deliver(prisma, { tier: 'SIGNED', body: { events: [{ event: 'page_view', id: 'g1', property: kG, timestamp: t0 }, { event: 'page_view', id: 'h1', property: kH, timestamp: t0 }, { event: 'page_view', id: 'h2', property: kH, timestamp: t0 }] } });
    const range = [new Date(Date.parse(t0) - DAY), new Date(Date.parse(t0) + DAY)] as const;
    assert.equal((await new WebsiteAnalyticsRepository(prisma).getWebsiteAnalytics(G, ...range)).totals.events, 1);
    assert.equal((await new WebsiteAnalyticsRepository(prisma).getWebsiteAnalytics(H, ...range)).totals.events, 2);
    const windows = new SourceMetricWindowRepository(prisma);
    const propH = (await properties.findForOrganization(H, kH))!;
    const w: WebsiteSourceWindow = { sourceId: 'GOOGLE_ANALYTICS', subjectRef: `web_property:${propH.id}`, dimension: 'TOTAL', dimensionValue: '', granularity: 'DAY', windowStart: new Date('2026-09-28T00:00:00Z'), windowEnd: new Date('2026-09-29T00:00:00Z'), finality: 'FINAL', metrics: { sessions: 5 }, quality: EMPTY_SOURCE_WINDOW_QUALITY };
    assert.equal((await windows.upsert(H, propH.id, w, new Date())).outcome, 'CREATED');
    assert.deepEqual(await windows.upsert(G, propH.id, w, new Date()), { outcome: 'REFUSED', problems: ['PROPERTY_NOT_IN_ORGANIZATION'] }, "G cannot attach a window to H's property");
    assert.equal((await windows.windows(G, 'GOOGLE_ANALYTICS', new Date(0), new Date('2027-01-01'))).length, 0);
    assert.equal((await windows.windows(H, 'GOOGLE_ANALYTICS', new Date(0), new Date('2027-01-01'))).length, 1);
    const stateG = await new WebsiteEvidenceStateRepository(prisma).read(G, range[0], range[1]);
    assert.equal(stateG.properties.total, 1);
    assert.equal(stateG.events.total, 1);
    assert.equal(stateG.sources.find((s) => s.sourceId === 'GOOGLE_ANALYTICS')!.newestWindowEnd, null);
  });

  await t.test('14/15: a stored window keeps null apart from zero, PRELIMINARY apart from FINAL, and a late PRELIMINARY never undoes FINAL', async () => {
    const I = await org(prisma, 'i');
    const windows = new SourceMetricWindowRepository(prisma);
    const base: WebsiteSourceWindow = { sourceId: 'GOOGLE_SEARCH_CONSOLE', subjectRef: 'site:1', dimension: 'TOTAL', dimensionValue: '', granularity: 'DAY', windowStart: new Date('2026-09-27T00:00:00Z'), windowEnd: new Date('2026-09-28T00:00:00Z'), finality: 'PRELIMINARY', metrics: { clicks: 0, impressions: null }, quality: { ...EMPTY_SOURCE_WINDOW_QUALITY, truncated: true } };
    await windows.upsert(I, null, base, new Date());
    let [row] = await windows.windows(I, 'GOOGLE_SEARCH_CONSOLE', new Date(0), new Date('2027-01-01'));
    assert.equal(row!.metrics['clicks'], 0);
    assert.equal(row!.metrics['impressions'], null);
    assert.equal(row!.finality, 'PRELIMINARY');
    assert.equal(row!.quality['truncated'], true);
    assert.equal((await windows.upsert(I, null, base, new Date())).outcome, 'UNCHANGED');
    assert.equal((await windows.upsert(I, null, { ...base, finality: 'FINAL', metrics: { clicks: 3, impressions: 40 } }, new Date())).outcome, 'UPDATED');
    assert.equal((await windows.upsert(I, null, { ...base, metrics: { clicks: 1, impressions: null } }, new Date())).outcome, 'UNCHANGED');
    [row] = await windows.windows(I, 'GOOGLE_SEARCH_CONSOLE', new Date(0), new Date('2027-01-01'));
    assert.equal(row!.finality, 'FINAL');
    assert.equal(row!.metrics['clicks'], 3);
    const refused = await windows.upsert(I, null, { ...base, dimension: 'QUERY', dimensionValue: 'burst pipe' }, new Date());
    assert.equal(refused.outcome, 'REFUSED');
    assert.equal(await prisma.sourceMetricWindow.count({ where: { organizationId: I } }), 1);
  });

  await t.test('21: a sealed organization credential cannot cross tenants', async () => {
    const J = await org(prisma, 'j');
    const K = await org(prisma, 'k');
    const sealer = new OrganizationCredentialSealer(new Uint8Array(32).fill(7));
    const conns = new OrganizationConnectionRepository(prisma);
    const clarity = { provider: 'microsoft_clarity', category: 'ANALYTICS' as const };
    const sealed = sealer.seal({ organizationId: J, provider: 'microsoft_clarity', credentialKind: 'API_TOKEN' }, 'token-for-j');
    await conns.storeCredential(J, clarity, { ...sealed, credentialKind: 'API_TOKEN' }, null);
    assert.equal(await conns.sealedCredential(K, clarity), null, 'K has no credential and cannot read J\'s');
    const own = (await conns.sealedCredential(J, clarity))!;
    assert.equal(sealer.open({ organizationId: J, provider: 'microsoft_clarity', credentialKind: 'API_TOKEN' }, own), 'token-for-j');
    // The bytes copied onto K's own connection still do not open as K.
    await conns.storeCredential(K, clarity, own, null);
    const copied = (await conns.sealedCredential(K, clarity))!;
    assert.throws(() => sealer.open({ organizationId: K, provider: 'microsoft_clarity', credentialKind: 'API_TOKEN' }, copied), OrganizationCredentialUnopenable);
    assert.throws(() => sealer.open({ organizationId: J, provider: 'bing_webmaster', credentialKind: 'API_TOKEN' }, own), OrganizationCredentialUnopenable);
    assert.throws(() => sealer.open({ organizationId: J, provider: 'microsoft_clarity', credentialKind: 'OAUTH_REFRESH_TOKEN' }, own), OrganizationCredentialUnopenable);
    assert.throws(() => new OrganizationCredentialSealer(new Uint8Array(32).fill(8)).open({ organizationId: J, provider: 'microsoft_clarity', credentialKind: 'API_TOKEN' }, own), OrganizationCredentialUnopenable);
    await conns.revoke(J, clarity, new Date());
    assert.equal(await conns.sealedCredential(J, clarity), null);
    assert.equal((await prisma.providerConnection.findFirst({ where: { organizationId: J, provider: 'microsoft_clarity' } }))!.secretSealed, null, 'revocation removes the bytes');
  });

  await t.test('coverage: declared external sources are NOT_CONNECTED with no connection, and a stored credential alone is not a connection', async () => {
    const L = await org(prisma, 'l');
    const now = new Date();
    assert.deepEqual([...(await websiteCoveragePort(prisma).unconnectedSources(L, now))].sort(), ['Bing Webmaster Tools', 'Google Analytics 4', 'Google Search Console', 'Microsoft Clarity']);
    const state = await new WebsiteEvidenceStateRepository(prisma).read(L, new Date(now.getTime() - DAY), now);
    for (const id of ['GOOGLE_ANALYTICS', 'GOOGLE_SEARCH_CONSOLE', 'BING_WEBMASTER', 'MICROSOFT_CLARITY']) {
      assert.equal(state.sources.find((s) => s.sourceId === id)!.connection, 'NOT_CONNECTED', id);
    }
    const conns = new OrganizationConnectionRepository(prisma);
    const sealed = new OrganizationCredentialSealer(new Uint8Array(32).fill(1)).seal({ organizationId: L, provider: 'microsoft_clarity', credentialKind: 'API_TOKEN' }, 't');
    await conns.storeCredential(L, { provider: 'microsoft_clarity', category: 'ANALYTICS' }, { ...sealed, credentialKind: 'API_TOKEN' }, null);
    assert.ok((await websiteCoveragePort(prisma).unconnectedSources(L, now)).includes('Microsoft Clarity'), 'a credential that was never used to read is not a connection');
    await conns.recordAttempt(L, { provider: 'microsoft_clarity', category: 'ANALYTICS' }, { succeeded: true, at: now });
    assert.equal((await websiteCoveragePort(prisma).unconnectedSources(L, now)).includes('Microsoft Clarity'), false);
  });

  await t.test('22: the raw telemetry purge cannot destroy a WEB_LEAD -- the lead and its submission time survive', async () => {
    const M = await org(prisma, 'm');
    const old = new Date(Date.now() - 200 * DAY);
    const lead = await prisma.customer.create({ data: { organizationId: M, firstName: 'Lead', metadata: { createdFrom: 'website' }, createdAt: new Date(Date.now() - 150 * DAY) } });
    await prisma.interaction.create({ data: { organizationId: M, customerId: lead.id, channel: 'OTHER', direction: 'INBOUND', kind: 'FORM_SUBMISSION', provider: 'website', occurredAt: old, metadata: { eventType: 'web.form_submit' } } });
    await prisma.interaction.createMany({ data: [0, 1, 2].map(() => ({ organizationId: M, channel: 'OTHER' as const, direction: 'INBOUND' as const, provider: 'website', occurredAt: old, metadata: { eventType: 'web.page_view' } })) });
    const recent = await prisma.interaction.create({ data: { organizationId: M, channel: 'OTHER', direction: 'INBOUND', provider: 'website', occurredAt: new Date(), metadata: { eventType: 'web.page_view' } } });
    const intake = new IntakeEligibilityRepository(prisma);
    const before = (await intake.read(M, new Date())).records.find((r) => r.id === lead.id)!;
    assert.equal(before.basis, 'WEB_LEAD');
    assert.equal(before.enteredAt.getTime(), old.getTime());

    const purged = await new WebsiteTelemetryRetentionRepository(prisma).purgeBefore(new Date(Date.now() - 90 * DAY));
    assert.ok(purged.interactions >= 3);

    const after = (await intake.read(M, new Date())).records.find((r) => r.id === lead.id);
    assert.ok(after, 'the WEB_LEAD survives');
    assert.equal(after!.basis, 'WEB_LEAD');
    assert.equal(after!.enteredAt.getTime(), old.getTime(), 'its entry time (the attached submission) survives');
    assert.equal(await prisma.interaction.count({ where: { organizationId: M, customerId: lead.id } }), 1);
    assert.equal(await prisma.interaction.count({ where: { organizationId: M, customerId: null, occurredAt: { lt: new Date(Date.now() - 90 * DAY) } } }), 0);
    assert.ok(await prisma.interaction.findUnique({ where: { id: recent.id } }), 'recent telemetry is kept');
  });

  await t.test('25: the diagnostic state carries counts and codes only -- no key, domain, path, visitor or contact', async () => {
    const state = await new WebsiteEvidenceStateRepository(prisma).read(A, new Date(Date.now() - 400 * DAY), new Date());
    const text = JSON.stringify(state);
    assert.doesNotMatch(text, new RegExp(kA));
    assert.doesNotMatch(text, /a-site\.example|\/x|v1|s1|@|pk_emg_/);
    assert.equal(state.properties.total, 1);
  });
});
