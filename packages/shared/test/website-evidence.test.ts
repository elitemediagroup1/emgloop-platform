// Governed website evidence (2026-09-30): the pure contract -- source identity vs stream, stream-based situation
// independence, property identity, telemetry minimization, event classes, the external aggregate evidence contract,
// organization connection state and the retention switch. Test numbers refer to the foundation PR's required list.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_SOURCE_WINDOW_QUALITY,
  INTELLIGENCE_SOURCE_REGISTRY,
  SITUATION_MIN_SOURCES,
  WEB_PROPERTY_COMMISSION_BATCH_MAX,
  WEBSITE_COLLECTION_MIN_PAGE_VIEWS,
  websiteCollectionVerdict,
  websiteEventAgeBucket,
  WEB_PROPERTY_LIFECYCLES,
  WEB_PROPERTY_LIFECYCLE_TRANSITIONS,
  parseWebPropertyKeyList,
  webPropertyLiveCommission,
  WEBSITE_EVIDENCE_RETENTION,
  WEBSITE_SOURCE_CONNECTIONS,
  WEBSITE_SOURCE_CONTRACT,
  clusterSituationSignals,
  intelligenceSourceStream,
  intelligenceStreamsOf,
  isWebPropertyKey,
  minimizeWebsiteEvent,
  normalizePagePath,
  normalizeWebDomain,
  organizationConnectionState,
  sourceMetricValue,
  webPropertyKeyFromIngestKey,
  websiteEventClass,
  websiteSourceStream,
  websiteSourceWindowProblems,
  websiteTelemetryRetentionEnabled,
  webPropertyAdmissionRefusal,
  webPropertyAdmissionState,
  webPropertyAdmitsTelemetry,
  webPropertyIngestionChange,
  webPropertyLifecycleTransition,
  websiteCoverageVerdict,
  webSiteBindingHost,
  type IntelligenceSignal,
  type SituationSignalInput,
  type WebsiteSourceWindow,
} from '../src';

// --- Source identity and stream (tests 16, 17, 19, 20) ---------------------------------------------------

test('16: GA4, Clarity and first-party website events are three sources of ONE stream', () => {
  assert.equal(intelligenceSourceStream('WEBSITE_EVENTS'), 'SITE_VISITS');
  assert.equal(intelligenceSourceStream('GOOGLE_ANALYTICS'), 'SITE_VISITS');
  assert.equal(intelligenceSourceStream('MICROSOFT_CLARITY'), 'SITE_VISITS');
  assert.deepEqual(intelligenceStreamsOf(['WEBSITE_EVENTS', 'GOOGLE_ANALYTICS']), ['SITE_VISITS']);
  assert.deepEqual(intelligenceStreamsOf(['WEBSITE_EVENTS', 'MICROSOFT_CLARITY']), ['SITE_VISITS']);
  assert.deepEqual(intelligenceStreamsOf(['GOOGLE_ANALYTICS', 'MICROSOFT_CLARITY']), ['SITE_VISITS']);
  assert.deepEqual(intelligenceStreamsOf(['WEBSITE_EVENTS', 'GOOGLE_ANALYTICS', 'MICROSOFT_CLARITY']), ['SITE_VISITS']);
});

test('17: Search Console and Bing Webmaster are distinct streams, and distinct from site visits', () => {
  assert.equal(intelligenceSourceStream('GOOGLE_SEARCH_CONSOLE'), 'SEARCH_GOOGLE');
  assert.equal(intelligenceSourceStream('BING_WEBMASTER'), 'SEARCH_BING');
  assert.deepEqual(intelligenceStreamsOf(['GOOGLE_SEARCH_CONSOLE', 'BING_WEBMASTER']), ['SEARCH_BING', 'SEARCH_GOOGLE']);
  assert.equal(intelligenceStreamsOf(['GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS']).length, 2);
});

test('19: an unregistered or missing source contributes no stream (fail closed)', () => {
  assert.equal(intelligenceSourceStream('SEARCH_CONSOLE_FUTURE'), null);
  assert.equal(intelligenceSourceStream(''), null);
  assert.deepEqual(intelligenceStreamsOf(['NOT_A_SOURCE', 'ALSO_NOT']), []);
  assert.deepEqual(intelligenceStreamsOf([]), []);
});

test('20: source identity is its own fact -- every registered source has an id, a stream, and the four new ones are organization connections', () => {
  for (const s of INTELLIGENCE_SOURCE_REGISTRY) {
    assert.ok(s.sourceId && s.stream, `${s.sourceId} names its stream`);
  }
  for (const id of ['GOOGLE_ANALYTICS', 'GOOGLE_SEARCH_CONSOLE', 'BING_WEBMASTER', 'MICROSOFT_CLARITY']) {
    const s = INTELLIGENCE_SOURCE_REGISTRY.find((x) => x.sourceId === id)!;
    assert.equal(s.basis, 'ORGANIZATION_CONNECTION');
    assert.deepEqual([...s.domains], ['WEBSITE']);
    assert.ok(WEBSITE_SOURCE_CONNECTIONS[id], `${id} has a connection home`);
    assert.ok(WEBSITE_SOURCE_CONTRACT[id], `${id} has an evidence contract`);
  }
  assert.equal(INTELLIGENCE_SOURCE_REGISTRY.some((s) => /ADS/.test(s.sourceId)), false, 'no advertising source is registered');
});

test('LOOP_INTAKE is its own stream: intake is never globally assigned to site visits', () => {
  assert.equal(intelligenceSourceStream('LOOP_INTAKE'), 'INTAKE_RECORDS');
});

// --- Situation independence over streams (tests 16, 17, 18, 19, 20 in the clusterer) ----------------------

const NOW = Date.parse('2026-09-30T12:00:00Z');
function sig(key: string, entity: string): IntelligenceSignal {
  return { key, kind: 'RISK', knowledge: 'MEASURED', statement: `${key}.`, evidenceRefs: [`x:${key}`], severity: 'MEDIUM', entities: [entity] } as IntelligenceSignal;
}
function input(domain: string, key: string, sources: string[] | undefined, entity = 'campaign:c1'): SituationSignalInput {
  return { ref: `digest:${domain}/${key}`, domain, signal: sig(key, entity), at: NOW, sources };
}
function cluster(a: SituationSignalInput, b: SituationSignalInput) {
  const [c] = clusterSituationSignals([a, b], []);
  assert.ok(c, 'the two signals connect through their shared entity');
  return c!;
}

test('situations: first-party + GA4 is ONE stream -- not independent', () => {
  const c = cluster(input('WEBSITE', 'a', ['WEBSITE_EVENTS']), input('PIPELINE', 'b', ['GOOGLE_ANALYTICS']));
  assert.deepEqual(c.sources, ['GOOGLE_ANALYTICS', 'WEBSITE_EVENTS'], 'both source identities stay visible');
  assert.deepEqual(c.streams, ['SITE_VISITS']);
  assert.equal(c.sourceIndependent, false);
});

test('situations: first-party + Clarity, and GA4 + Clarity, are not independent', () => {
  assert.equal(cluster(input('WEBSITE', 'a', ['WEBSITE_EVENTS']), input('PIPELINE', 'b', ['MICROSOFT_CLARITY'])).sourceIndependent, false);
  assert.equal(cluster(input('WEBSITE', 'a', ['GOOGLE_ANALYTICS']), input('PIPELINE', 'b', ['MICROSOFT_CLARITY'])).sourceIndependent, false);
});

test('situations: Search Console + Bing ARE independent streams', () => {
  const c = cluster(input('WEBSITE', 'a', ['GOOGLE_SEARCH_CONSOLE']), input('PIPELINE', 'b', ['BING_WEBMASTER']));
  assert.deepEqual(c.streams, ['SEARCH_BING', 'SEARCH_GOOGLE']);
  assert.equal(c.sourceIndependent, true);
  assert.equal(SITUATION_MIN_SOURCES, 2);
});

test('18: CallGrid + Campaigns (one CALLGRID source) keep their behavior -- not independent; CallGrid + website events are', () => {
  const same = cluster(input('CALLGRID', 'a', ['CALLGRID']), input('CAMPAIGNS', 'b', ['CALLGRID']));
  assert.deepEqual(same.sources, ['CALLGRID']);
  assert.deepEqual(same.streams, ['CALLS']);
  assert.equal(same.sourceIndependent, false);
  assert.equal(cluster(input('CALLGRID', 'a', ['CALLGRID']), input('WEBSITE', 'b', ['WEBSITE_EVENTS'])).sourceIndependent, true);
});

test('19: missing or unregistered lineage contributes nothing, but the unregistered id stays visible', () => {
  const unknown = cluster(input('CALLGRID', 'a', ['CALLGRID']), input('WEBSITE', 'b', ['SEARCH_CONSOLE_FUTURE']));
  assert.deepEqual(unknown.sources, ['CALLGRID', 'SEARCH_CONSOLE_FUTURE']);
  assert.deepEqual(unknown.streams, ['CALLS']);
  assert.equal(unknown.sourceIndependent, false);
  const missing = cluster(input('CALLGRID', 'a', ['CALLGRID']), input('WEBSITE', 'b', undefined));
  assert.equal(missing.sourceIndependent, false);
});

test('situations: no artificial link -- two website sources naming DIFFERENT entities do not connect', () => {
  assert.equal(clusterSituationSignals([input('WEBSITE', 'a', ['WEBSITE_EVENTS'], 'page:1'), input('PIPELINE', 'b', ['BING_WEBMASTER'], 'page:2')], []).length, 0);
});

// --- Property identity (tests 3, 4, 5 -- pure halves) -----------------------------------------------------

test('property keys and ingest keys: shape only; a malformed key names no property', () => {
  assert.equal(isWebPropertyKey('servicesinmycity'), true);
  assert.equal(isWebPropertyKey('Services'), false);
  assert.equal(isWebPropertyKey('a'.repeat(64)), false);
  assert.equal(webPropertyKeyFromIngestKey('pk_emg_careinmycity'), 'careinmycity');
  assert.equal(webPropertyKeyFromIngestKey('PK_EMG_careinmycity'), 'careinmycity');
  assert.equal(webPropertyKeyFromIngestKey('pk_live_careinmycity'), null);
  assert.equal(webPropertyKeyFromIngestKey('pk_emg_../x'), null);
  assert.equal(webPropertyKeyFromIngestKey(''), null);
});

test('allowed domains are plain hostnames; anything else is refused, not repaired', () => {
  assert.equal(normalizeWebDomain('Example.COM'), 'example.com');
  assert.equal(normalizeWebDomain('https://example.com'), null);
  assert.equal(normalizeWebDomain('example.com/path'), null);
  assert.equal(normalizeWebDomain('*.example.com'), null);
  assert.equal(normalizeWebDomain('localhost'), null);
});

// --- Telemetry minimization (tests 9, 10, 11) --------------------------------------------------------------

test('9: query strings and fragments never become page identity', () => {
  assert.equal(normalizePagePath('/plumbers?zip=10001&utm_campaign=spring'), '/plumbers');
  assert.equal(normalizePagePath('https://www.example.com/Plumbers/?q=leak#top'), '/plumbers');
  assert.equal(normalizePagePath('/a//b/'), '/a/b');
  assert.equal(normalizePagePath('/'), '/');
  assert.equal(normalizePagePath('https://example.com'), '/');
  assert.equal(normalizePagePath('/thanks/jane@example.com'), null, 'a path carrying an email is not kept');
  assert.equal(normalizePagePath('not-a-path'), null);
  const a = minimizeWebsiteEvent({ page: '/plumbers?gclid=abc' }, 'p');
  const b = minimizeWebsiteEvent({ page: '/plumbers?gclid=xyz' }, 'p');
  assert.equal(a.page, b.page);
});

test('10 + 11: email and phone never survive minimization -- not as fields, targets, labels or search text', () => {
  const raw = {
    property: 'servicesinmycity',
    organization: 'some-other-org',
    email: 'jane@example.com',
    phone: '+1 (555) 123-4567',
    phone_target: '+15551234567',
    email_target: 'jane@example.com',
    cta: 'Call (555) 123-4567',
    title: 'Contact jane@example.com',
    query: 'jane@example.com leak',
    url: 'https://example.com/p?email=jane@example.com',
    page: '/p?email=jane@example.com',
    referrer: 'https://mail.example.com/inbox?from=jane@example.com',
    campaign: 'Spring Promo Jane',
    screen: '1920x1080',
    file: 'https://example.com/private.pdf',
    target: 'https://other.example/path',
    visitorId: 'v_123',
    sessionId: 's_456',
    unknownKey: 'anything',
  };
  const m = minimizeWebsiteEvent(raw, 'servicesinmycity');
  const text = JSON.stringify(m);
  assert.doesNotMatch(text, /jane|example\.com\/|555|123-4567|15551234567|Spring|1920|private|other\.example|some-other-org|anything/);
  assert.deepEqual(Object.keys(m).sort(), ['page', 'property', 'referrerHost', 'sessionId', 'visitorId']);
  assert.equal(m.page, '/p');
  assert.equal(m.referrerHost, 'mail.example.com');
});

test('a ZIP-code search keeps the ZIP; a free-text search keeps nothing', () => {
  assert.equal(minimizeWebsiteEvent({ query: '10001' }, 'p').zip, '10001');
  assert.equal(minimizeWebsiteEvent({ query: 'water heater repair near me' }, 'p').zip, undefined);
  assert.equal(JSON.stringify(minimizeWebsiteEvent({ query: 'water heater repair near me' }, 'p')).includes('water'), false);
});

// --- Event classes (tests 6, 7, 8 -- pure halves) ----------------------------------------------------------

test('6/7/8: heartbeat, scroll depth and identify are TELEMETRY, not page views; unknown is OTHER', () => {
  assert.equal(websiteEventClass('web.page_view'), 'PAGE_VIEW');
  assert.equal(websiteEventClass('web.heartbeat'), 'TELEMETRY');
  assert.equal(websiteEventClass('web.scroll_depth'), 'TELEMETRY');
  assert.equal(websiteEventClass('web.identify'), 'TELEMETRY');
  assert.equal(websiteEventClass('web.other'), 'OTHER');
  assert.equal(websiteEventClass('web.something_new'), 'OTHER');
  assert.equal(websiteEventClass('web.form_submit'), 'INTENT');
});

// --- The external evidence contract (tests 14, 15) ---------------------------------------------------------

function window(over: Partial<WebsiteSourceWindow> = {}): WebsiteSourceWindow {
  return {
    sourceId: 'GOOGLE_ANALYTICS',
    subjectRef: 'web_property:wp1',
    dimension: 'TOTAL',
    dimensionValue: '',
    granularity: 'DAY',
    windowStart: new Date('2026-09-28T00:00:00Z'),
    windowEnd: new Date('2026-09-29T00:00:00Z'),
    finality: 'PRELIMINARY',
    metrics: { sessions: 12, keyEvents: null },
    quality: EMPTY_SOURCE_WINDOW_QUALITY,
    ...over,
  };
}

test('14: null stays distinct from zero -- in the contract and when read back', () => {
  assert.deepEqual(websiteSourceWindowProblems(window({ metrics: { sessions: 0, keyEvents: null } })), []);
  assert.equal(sourceMetricValue({ sessions: 0, keyEvents: null }, 'sessions'), 0);
  assert.equal(sourceMetricValue({ sessions: 0, keyEvents: null }, 'keyEvents'), null);
  assert.equal(sourceMetricValue({ sessions: 0 }, 'totalUsers'), null, 'absent is unknown, not zero');
  assert.deepEqual(websiteSourceWindowProblems(window({ metrics: { sessions: -1 } })), ['METRIC_VALUE_INVALID']);
  assert.deepEqual(websiteSourceWindowProblems(window({ metrics: { sessions: Number.NaN } })), ['METRIC_VALUE_INVALID']);
});

test('15: PRELIMINARY is its own finality, and an unknown finality is refused', () => {
  assert.deepEqual(websiteSourceWindowProblems(window({ finality: 'PRELIMINARY' })), []);
  assert.deepEqual(websiteSourceWindowProblems(window({ finality: 'FINAL' })), []);
  assert.deepEqual(websiteSourceWindowProblems(window({ finality: 'PARTIAL' as never })), ['FINALITY_UNKNOWN']);
});

test('the contract refuses search query text, campaign names and un-minimized values', () => {
  assert.ok(websiteSourceWindowProblems(window({ sourceId: 'GOOGLE_SEARCH_CONSOLE', dimension: 'QUERY', dimensionValue: 'plumber near me', metrics: { clicks: 1 } })).includes('DIMENSION_FORBIDDEN'));
  assert.ok(websiteSourceWindowProblems(window({ dimension: 'CAMPAIGN_NAME', dimensionValue: 'Spring', metrics: { sessions: 1 } })).includes('DIMENSION_FORBIDDEN'));
  assert.ok(websiteSourceWindowProblems(window({ dimension: 'PAGE_PATH', dimensionValue: '/p?q=x' })).includes('DIMENSION_VALUE_NOT_MINIMIZED'));
  assert.ok(websiteSourceWindowProblems(window({ metrics: { rawResponse: 1 } })).includes('METRIC_NOT_IN_CONTRACT'));
  assert.deepEqual(websiteSourceWindowProblems(window({ sourceId: 'WEBSITE_EVENTS' })), ['SOURCE_NOT_A_WEBSITE_SOURCE']);
  assert.deepEqual(websiteSourceWindowProblems(window({ sourceId: 'GOOGLE_ADS' })), ['SOURCE_NOT_A_WEBSITE_SOURCE']);
  assert.ok(websiteSourceWindowProblems(window({ windowEnd: new Date('2026-09-28T00:00:00Z') })).includes('WINDOW_ORDER'));
  assert.ok(websiteSourceWindowProblems(window({ quality: { ...EMPTY_SOURCE_WINDOW_QUALITY, sampledPercent: 140 } })).includes('QUALITY_SAMPLED_RANGE'));
  for (const c of Object.values(WEBSITE_SOURCE_CONTRACT)) {
    assert.equal(c.dimensions.some((d) => /QUERY|CAMPAIGN|KEYWORD/.test(d)), false);
  }
  assert.equal(websiteSourceStream('GOOGLE_ANALYTICS'), 'SITE_VISITS');
  assert.equal(websiteSourceStream('CALLGRID'), null);
});

// --- Connection state: declared is not connected ------------------------------------------------------------

test('a declared source with no connection is NOT_CONNECTED; CONNECTED needs a successful read', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const base = { status: 'CONNECTED', revokedAt: null, lastAttemptAt: null, lastSucceededAt: null, lastFailureClass: null, backoffUntil: null };
  assert.equal(organizationConnectionState(null, now), 'NOT_CONNECTED');
  assert.equal(organizationConnectionState({ ...base, status: 'PENDING' }, now), 'NOT_CONNECTED');
  assert.equal(organizationConnectionState(base, now), 'NOT_CONNECTED', 'marked connected but never read: not evidence of anything');
  assert.equal(organizationConnectionState({ ...base, lastSucceededAt: now, lastAttemptAt: now }, now), 'CONNECTED');
  assert.equal(organizationConnectionState({ ...base, lastSucceededAt: new Date(0), lastAttemptAt: now, lastFailureClass: 'AUTH_REVOKED' }, now), 'FAILING');
  assert.equal(organizationConnectionState({ ...base, backoffUntil: new Date(now.getTime() + 1000) }, now), 'BACKING_OFF');
  assert.equal(organizationConnectionState({ ...base, revokedAt: now }, now), 'REVOKED');
});

// --- Retention (test 22 -- the policy half) -----------------------------------------------------------------

test('22: raw website telemetry retention is defined, 90 days, and DISABLED unless explicitly switched on', () => {
  const raw = WEBSITE_EVIDENCE_RETENTION.find((r) => r.category === 'WEBSITE_RAW_TELEMETRY')!;
  assert.equal(raw.days, 90);
  assert.equal(raw.active, 'DISABLED_UNTIL_ENABLED');
  assert.match(raw.rows, /customerId IS NULL/);
  assert.equal(websiteTelemetryRetentionEnabled(undefined), false);
  assert.equal(websiteTelemetryRetentionEnabled(''), false);
  assert.equal(websiteTelemetryRetentionEnabled('true'), false);
  assert.equal(websiteTelemetryRetentionEnabled('1'), false);
  assert.equal(websiteTelemetryRetentionEnabled('on'), true);
  assert.equal(WEBSITE_EVIDENCE_RETENTION.find((r) => r.category === 'WEBSITE_SOURCE_AGGREGATES')!.active, 'ACTIVE');
});

// --- Property lifecycle and ingestion authority (2026-09-30) ------------------------------------------------

test('only LIVE + ENABLED admits telemetry; every other combination is refused with its own code', () => {
  for (const lifecycle of WEB_PROPERTY_LIFECYCLES) {
    for (const ingestion of ['ENABLED', 'DISABLED']) {
      const admits = webPropertyAdmitsTelemetry({ lifecycle, ingestion });
      assert.equal(admits, lifecycle === 'LIVE' && ingestion === 'ENABLED', `${lifecycle}/${ingestion}`);
      assert.equal(webPropertyAdmissionRefusal({ lifecycle, ingestion }), admits ? null : lifecycle === 'LIVE' ? 'INGESTION_DISABLED' : 'PROPERTY_NOT_LIVE');
    }
  }
  assert.equal(webPropertyAdmitsTelemetry({ lifecycle: 'ACTIVE', ingestion: 'ENABLED' }), false, 'an unknown stored value never admits');
});

test('the lifecycle state machine: governed transitions only; leaving LIVE disables ingestion; entering LIVE enables nothing', () => {
  assert.deepEqual(webPropertyLifecycleTransition({ lifecycle: 'OWNED', ingestion: 'DISABLED' }, 'LIVE'), { ok: true, lifecycle: 'LIVE', ingestion: 'DISABLED' });
  assert.deepEqual(webPropertyLifecycleTransition({ lifecycle: 'LIVE', ingestion: 'ENABLED' }, 'PAUSED'), { ok: true, lifecycle: 'PAUSED', ingestion: 'DISABLED' });
  assert.deepEqual(webPropertyLifecycleTransition({ lifecycle: 'PAUSED', ingestion: 'DISABLED' }, 'LIVE'), { ok: true, lifecycle: 'LIVE', ingestion: 'DISABLED' });
  assert.deepEqual(webPropertyLifecycleTransition({ lifecycle: 'LIVE', ingestion: 'ENABLED' }, 'OWNED'), { ok: false, code: 'LIFECYCLE_TRANSITION_REFUSED' });
  assert.deepEqual(webPropertyLifecycleTransition({ lifecycle: 'OWNED', ingestion: 'DISABLED' }, 'PAUSED'), { ok: false, code: 'LIFECYCLE_TRANSITION_REFUSED' });
  assert.deepEqual(webPropertyLifecycleTransition({ lifecycle: 'OWNED', ingestion: 'DISABLED' }, 'OWNED'), { ok: false, code: 'LIFECYCLE_UNCHANGED' });
  for (const [from, tos] of Object.entries(WEB_PROPERTY_LIFECYCLE_TRANSITIONS)) {
    for (const to of tos) {
      const r = webPropertyLifecycleTransition({ lifecycle: from as never, ingestion: 'ENABLED' }, to);
      assert.ok(r.ok);
      assert.equal(r.ok && r.ingestion === 'ENABLED', to === 'LIVE', `${from} -> ${to}: ingestion survives only into LIVE`);
    }
  }
  assert.deepEqual(webPropertyIngestionChange('BUILDING', 'ENABLED'), { ok: false, code: 'INGESTION_REQUIRES_LIVE' });
  assert.deepEqual(webPropertyIngestionChange('LIVE', 'ENABLED'), { ok: true });
  assert.deepEqual(webPropertyIngestionChange('OWNED', 'DISABLED'), { ok: true });
});

test('diagnostic admission states distinguish known-not-live, live ingesting, live disabled and unregistered', () => {
  assert.equal(webPropertyAdmissionState(null), 'UNREGISTERED');
  assert.equal(webPropertyAdmissionState({ lifecycle: 'OWNED', ingestion: 'DISABLED' }), 'KNOWN_NOT_LIVE');
  assert.equal(webPropertyAdmissionState({ lifecycle: 'BUILDING', ingestion: 'DISABLED' }), 'KNOWN_NOT_LIVE');
  assert.equal(webPropertyAdmissionState({ lifecycle: 'LIVE', ingestion: 'ENABLED' }), 'LIVE_INGESTING');
  assert.equal(webPropertyAdmissionState({ lifecycle: 'LIVE', ingestion: 'DISABLED' }), 'LIVE_INGESTION_DISABLED');
});

test('coverage: with no LIVE property nothing is a gap; with one, an unconnected source is', () => {
  const base = { liveIngestingProperties: 0, hasRecentEvidence: false, connection: 'NOT_CONNECTED' as const };
  assert.equal(websiteCoverageVerdict({ ...base, firstParty: false, liveProperties: 0 }), 'NOT_APPLICABLE', 'OWNED / BUILDING only: no false NOT_CONNECTED gap');
  assert.equal(websiteCoverageVerdict({ ...base, firstParty: true, liveProperties: 0 }), 'NOT_APPLICABLE');
  assert.equal(websiteCoverageVerdict({ ...base, firstParty: true, liveProperties: 1 }), 'NOT_APPLICABLE', 'LIVE but ingestion disabled: first-party is not expected');
  assert.equal(websiteCoverageVerdict({ ...base, firstParty: false, liveProperties: 1 }), 'GAP_NOT_CONNECTED');
  assert.equal(websiteCoverageVerdict({ ...base, firstParty: false, liveProperties: 1, connection: 'CONNECTED' }), 'COVERED');
  assert.equal(websiteCoverageVerdict({ ...base, firstParty: true, liveProperties: 1, liveIngestingProperties: 1 }), 'GAP_NO_EVENTS');
  assert.equal(websiteCoverageVerdict({ ...base, firstParty: true, liveProperties: 1, liveIngestingProperties: 1, hasRecentEvidence: true }), 'COVERED');
});

test('Search Console / Bing binding hosts: a Domain property and a URL-prefix property name the same host', () => {
  assert.equal(webSiteBindingHost('sc-domain:servicesinmycity.com'), 'servicesinmycity.com');
  assert.equal(webSiteBindingHost('https://www.servicesinmycity.com/'), 'www.servicesinmycity.com');
  assert.equal(webSiteBindingHost('not a site'), null);
});

// --- commission-live-sites (2026-09-30) ----------------------------------------------------------------------

test('property-key lists are parsed strictly: whitespace trimmed; empty, malformed, duplicate or too many refuses the whole list', () => {
  assert.deepEqual(parseWebPropertyKeyList(' consumersupporthelp , careinmycity,petsinmycity '), { ok: true, keys: ['consumersupporthelp', 'careinmycity', 'petsinmycity'] });
  assert.deepEqual(parseWebPropertyKeyList(''), { ok: false, refusals: [{ position: 0, key: null, code: 'EMPTY_LIST' }] });
  assert.deepEqual(parseWebPropertyKeyList('  '), { ok: false, refusals: [{ position: 0, key: null, code: 'EMPTY_LIST' }] });
  assert.deepEqual(parseWebPropertyKeyList('a,,b'), { ok: false, refusals: [{ position: 2, key: null, code: 'EMPTY_KEY' }] });
  assert.deepEqual(parseWebPropertyKeyList('a,b,'), { ok: false, refusals: [{ position: 3, key: null, code: 'EMPTY_KEY' }] });
  assert.deepEqual(parseWebPropertyKeyList('a, Bad Key!'), { ok: false, refusals: [{ position: 2, key: null, code: 'KEY_SHAPE' }] }, 'a malformed entry is never echoed');
  assert.deepEqual(parseWebPropertyKeyList('a,b, a'), { ok: false, refusals: [{ position: 3, key: 'a', code: 'DUPLICATE_KEY' }] });
  assert.equal(WEB_PROPERTY_COMMISSION_BATCH_MAX, 25);
  const max = Array.from({ length: 25 }, (_, i) => `site-${i}`).join(',');
  assert.equal(parseWebPropertyKeyList(max).ok, true);
  assert.deepEqual(parseWebPropertyKeyList(`${max},site-25`), { ok: false, refusals: [{ position: 0, key: null, code: 'TOO_MANY_KEYS' }] });
});

test('the live commission plan uses the governed state machine: RETIRED cannot become LIVE; LIVE + ENABLED needs nothing', () => {
  assert.deepEqual(webPropertyLiveCommission({ lifecycle: 'OWNED', ingestion: 'DISABLED' }), { ok: true, lifecycleChange: true, ingestionChange: true });
  assert.deepEqual(webPropertyLiveCommission({ lifecycle: 'BUILDING', ingestion: 'DISABLED' }), { ok: true, lifecycleChange: true, ingestionChange: true });
  assert.deepEqual(webPropertyLiveCommission({ lifecycle: 'PAUSED', ingestion: 'DISABLED' }), { ok: true, lifecycleChange: true, ingestionChange: true });
  assert.deepEqual(webPropertyLiveCommission({ lifecycle: 'LIVE', ingestion: 'DISABLED' }), { ok: true, lifecycleChange: false, ingestionChange: true });
  assert.deepEqual(webPropertyLiveCommission({ lifecycle: 'LIVE', ingestion: 'ENABLED' }), { ok: true, lifecycleChange: false, ingestionChange: false });
  assert.deepEqual(webPropertyLiveCommission({ lifecycle: 'RETIRED', ingestion: 'DISABLED' }), { ok: false, code: 'LIFECYCLE_TRANSITION_REFUSED' });
  assert.deepEqual(webPropertyLiveCommission({ lifecycle: 'ACTIVE', ingestion: 'ENABLED' }), { ok: false, code: 'STATE_UNRECOGNIZED' });
});

// --- Collection health (2026-10-05) ----------------------------------------------------------------------------


test('collection verdict: a LIVE + ENABLED property with no events is NO_EVENTS, never healthy', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  const h = (n: number) => new Date(now.getTime() - n * 3_600_000);
  const live = { lifecycle: 'LIVE', ingestion: 'ENABLED', now };
  assert.equal(websiteCollectionVerdict({ ...live, events: 0, pageViews: 0, newestAt: null }), 'NO_EVENTS');
  assert.equal(websiteCollectionVerdict({ ...live, events: 1, pageViews: 0, newestAt: h(1) }), 'SPARSE', 'one stray event is not a flowing tracker');
  assert.equal(websiteCollectionVerdict({ ...live, events: 500, pageViews: 200, newestAt: h(72) }), 'SPARSE', 'gone quiet for 3 days');
  assert.equal(websiteCollectionVerdict({ ...live, events: 500, pageViews: WEBSITE_COLLECTION_MIN_PAGE_VIEWS, newestAt: h(2) }), 'FLOWING');
  assert.equal(websiteCollectionVerdict({ ...live, ingestion: 'DISABLED', events: 0, pageViews: 0, newestAt: null }), 'NOT_APPLICABLE');
  assert.equal(websiteCollectionVerdict({ ...live, lifecycle: 'OWNED', ingestion: 'DISABLED', events: 0, pageViews: 0, newestAt: null }), 'NOT_APPLICABLE');
  assert.equal(websiteEventAgeBucket(null, now), 'NEVER');
  assert.equal(websiteEventAgeBucket(h(0.5), now), 'LT_1H');
  assert.equal(websiteEventAgeBucket(h(30), now), 'LT_48H');
  assert.equal(websiteEventAgeBucket(h(24 * 20), now), 'GT_14D');
});

test('minimization is idempotent: a stored, minimized event read back through the minimizer keeps every attribute', () => {
  const raw = { page: '/a?x=1', title: 'A', referrer: 'https://www.google.com/search?q=x', utm_source: 'google', utm_medium: 'cpc', sessionId: 's1', visitorId: 'v1', cta: 'Go', form: 'quote', category: 'plumbing', city: 'Austin', query: '10001', depth: 50 };
  const once = minimizeWebsiteEvent(raw, 'site');
  assert.equal(once.referrerHost, 'www.google.com');
  assert.deepEqual(minimizeWebsiteEvent(once as Record<string, unknown>, 'site'), once);
  assert.equal(minimizeWebsiteEvent({ referrerHost: 'https://evil.example/?q=1' }, 'site').referrerHost, undefined, 'a stored value must still be a plain host');
});

test('click fields are minimized: a closed element type, a destination PATH (no query), a destination HOST', () => {
  const m = minimizeWebsiteEvent({ elementType: 'link', destination: 'https://servicesinmycity.com/plumbers?email=a@b.com#x', destinationHost: 'Partner.Example', cta: 'Plumbers' }, 'site');
  assert.equal(m.elementType, 'link');
  assert.equal(m.destination, '/plumbers');
  assert.equal(m.destinationHost, 'partner.example');
  assert.equal(minimizeWebsiteEvent({ elementType: '<div onclick>' }, 'site').elementType, undefined, 'outside the vocabulary: dropped');
  assert.equal(minimizeWebsiteEvent({ destinationHost: 'https://x.example/?q=1' }, 'site').destinationHost, undefined, 'a URL is not a host');
  assert.equal(minimizeWebsiteEvent({ destination: '/thanks/jane@example.com' }, 'site').destination, undefined);
  assert.equal(minimizeWebsiteEvent({ cta: 'Call (512) 555-0147' }, 'site').cta, undefined, 'a label that is a phone number is dropped');
  assert.equal(websiteEventClass('web.page_leave'), 'TELEMETRY');
  assert.equal(websiteEventClass('web.session_end'), 'TELEMETRY', 'the legacy name is a page leave too');
  assert.equal(websiteEventClass('web.link_click'), 'ENGAGEMENT');
  assert.equal(websiteEventClass('web.button_click'), 'ENGAGEMENT');
});
