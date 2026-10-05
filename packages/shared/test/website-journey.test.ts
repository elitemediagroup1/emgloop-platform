// Website journeys (2026-10-05): one anonymous visit, in order, from minimized first-party events.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LOOP_EVENT_TYPES, anonymousRef, buildJourneySession, formatJourneyDuration, websiteEventLabel, type JourneyEvent } from '../src';

const T0 = Date.parse('2026-10-05T14:00:00Z');
const ev = (sec: number, eventType: string, attributes: Record<string, string | number> = {}): JourneyEvent => ({ at: new Date(T0 + sec * 1000), eventType, attributes });

test('a visit, in order: landing page, steps with the time since the previous one, page transitions, exit', () => {
  const j = buildJourneySession([
    // deliberately out of order
    ev(95, 'web.page_view', { page: '/plumbers', title: 'Plumbers', referrerHost: 'servicesinmycity.com' }),
    ev(0, 'web.page_view', { page: '/', title: 'Home', referrerHost: 'www.google.com' }),
    ev(0, 'web.session_start', { page: '/', referrerHost: 'www.google.com' }),
    ev(30, 'web.heartbeat', { page: '/' }),
    ev(40, 'web.scroll_depth', { page: '/', depth: 50 }),
    ev(45, 'web.scroll_depth', { page: '/', depth: 25 }),
    ev(60, 'web.search_zip', { page: '/', zip: '10001' }),
    ev(94, 'web.session_end', { page: '/' }),
    ev(120, 'web.cta_click', { page: '/plumbers', cta: 'Get quotes' }),
    ev(150, 'web.form_start', { page: '/plumbers', form: 'quote' }),
    ev(210, 'web.form_submit', { page: '/plumbers', form: 'quote' }),
    ev(215, 'web.phone_click', { page: '/plumbers', cta: 'Call now' }),
  ])!;
  assert.equal(j.landingPage, '/');
  assert.equal(j.exitPage, '/plumbers');
  assert.deepEqual(j.path, ['/', '/plumbers']);
  assert.equal(j.durationMs, 215_000);
  assert.equal(j.eventCount, 12);
  assert.equal(j.startObserved, true);
  assert.deepEqual(j.traffic, { kind: 'REFERRAL', referrerHost: 'www.google.com' });
  assert.deepEqual(j.pages.map((p) => [p.path, p.views, p.maxScroll, p.timeOnPageMs]), [['/', 1, 50, 94_000], ['/plumbers', 1, null, null]]);
  // The legacy session_end (a page leave) is folded into the page's time -- never a step, never the visit's end.
  assert.deepEqual(j.steps.map((s) => s.eventType), ['web.session_start', 'web.page_view', 'web.search_zip', 'web.page_view', 'web.cta_click', 'web.form_start', 'web.form_submit', 'web.phone_click']);
  // heartbeat and scroll milestones are folded, never steps
  assert.equal(j.steps.some((s) => s.eventType === 'web.heartbeat' || s.eventType === 'web.scroll_depth'), false);
  const search = j.steps.find((s) => s.eventType === 'web.search_zip')!;
  assert.equal(search.detail, '10001');
  assert.equal(search.label, 'Searched by ZIP code');
  const cta = j.steps.find((s) => s.eventType === 'web.cta_click')!;
  assert.equal(cta.detail, 'Get quotes');
  assert.equal(cta.sincePreviousMs, 25_000, 'time since the previous step (the page view at +95s)');
  assert.equal(j.steps[0]!.sincePreviousMs, null);
  assert.deepEqual(
    { pageViews: j.counts.pageViews, searches: j.counts.searches, ctaClicks: j.counts.ctaClicks, formStarts: j.counts.formStarts, formSubmits: j.counts.formSubmits, phoneClicks: j.counts.phoneClicks },
    { pageViews: 2, searches: 1, ctaClicks: 1, formStarts: 1, formSubmits: 1, phoneClicks: 1 },
  );
});

test('traffic: utm source/medium is a campaign, a referring host a referral, neither is direct', () => {
  assert.deepEqual(buildJourneySession([ev(0, 'web.page_view', { page: '/', source: 'google', medium: 'cpc' })])!.traffic, { kind: 'CAMPAIGN', source: 'google', medium: 'cpc' });
  assert.deepEqual(buildJourneySession([ev(0, 'web.page_view', { page: '/' })])!.traffic, { kind: 'DIRECT' });
  assert.equal(buildJourneySession([]), null);
});

test('a session whose start was not observed says so; a mid-session read has no landing guess beyond its first page', () => {
  const j = buildJourneySession([ev(0, 'web.cta_click', { page: '/a', cta: 'Go' }), ev(5, 'web.page_view', { page: '/b' })])!;
  assert.equal(j.startObserved, false);
  assert.equal(j.landingPage, '/b');
});

test('every canonical web event type has a human-readable label', () => {
  for (const t of LOOP_EVENT_TYPES.filter((x) => x.startsWith('web.') && x !== 'web.other')) {
    assert.notEqual(websiteEventLabel(t), 'Other website activity', t);
  }
  assert.equal(websiteEventLabel('web.something_new'), 'Other website activity');
});

test('display helpers: durations read naturally; an anonymous ref is short and never the whole id', () => {
  assert.equal(formatJourneyDuration(12_400), '12s');
  assert.equal(formatJourneyDuration(245_000), '4m 05s');
  assert.equal(formatJourneyDuration(3_720_000), '1h 02m');
  const id = '6f1c2a9e-1b2c-4d3e-8f90-0a1b2c3da3f9';
  assert.equal(anonymousRef(id), 'a3f9');
  assert.ok(!anonymousRef(id).includes('6f1c'));
});

test('a multi-page visit: page_leave closes each page (time on page), is never a step, and never ends the visit', () => {
  const j = buildJourneySession([
    ev(0, 'web.session_start', { page: '/' }),
    ev(0, 'web.page_view', { page: '/' }),
    ev(40, 'web.link_click', { page: '/', cta: 'Plumbers in Austin', elementType: 'link', destination: '/plumbers/austin-tx' }),
    ev(41, 'web.page_leave', { page: '/' }),
    ev(42, 'web.page_view', { page: '/plumbers/austin-tx' }),
    ev(100, 'web.button_click', { page: '/plumbers/austin-tx', cta: 'Compare', elementType: 'button' }),
    ev(130, 'web.external_link', { page: '/plumbers/austin-tx', cta: 'See the deal', elementType: 'outbound', destinationHost: 'partner.example' }),
    ev(131, 'web.page_leave', { page: '/plumbers/austin-tx' }),
    ev(900, 'web.page_view', { page: '/' }),
    ev(960, 'web.download', { page: '/', cta: 'Guide', elementType: 'download', destination: '/files/guide.pdf' }),
  ])!;
  assert.deepEqual(j.steps.map((s) => s.eventType), ['web.session_start', 'web.page_view', 'web.link_click', 'web.page_view', 'web.button_click', 'web.external_link', 'web.page_view', 'web.download']);
  assert.equal(j.steps.some((s) => s.eventType === 'web.page_leave'), false);
  assert.deepEqual(j.path, ['/', '/plumbers/austin-tx', '/']);
  assert.equal(j.exitPage, '/', 'the visit ended on the last page it viewed');
  assert.equal(j.lastAt.getTime() - j.startedAt.getTime(), 960_000, 'the visit runs to its last event, past both page leaves');
  assert.deepEqual(j.pages.map((p) => [p.path, p.views, p.timeOnPageMs]), [['/', 2, 41_000], ['/plumbers/austin-tx', 1, 89_000]]);
  const link = j.steps.find((s) => s.eventType === 'web.link_click')!;
  assert.equal(link.label, 'Clicked a link');
  assert.equal(link.detail, 'Plumbers in Austin → /plumbers/austin-tx');
  const next = j.steps[j.steps.indexOf(link) + 1]!;
  assert.equal(next.eventType, 'web.page_view');
  assert.equal(next.page, '/plumbers/austin-tx', 'the internal link is followed by the page it named');
  assert.equal(j.steps.find((s) => s.eventType === 'web.external_link')!.detail, 'See the deal → partner.example');
  assert.equal(j.steps.find((s) => s.eventType === 'web.download')!.detail, 'Guide → /files/guide.pdf');
  assert.deepEqual([j.counts.linkClicks, j.counts.buttonClicks, j.counts.outboundClicks, j.counts.downloads], [1, 1, 1, 1]);
});
