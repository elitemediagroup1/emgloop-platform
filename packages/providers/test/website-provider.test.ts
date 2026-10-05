// WebsiteProvider (2026-09-30): what a website delivery becomes before anything is stored -- the canonical type,
// the minimized payload, and a deterministic, property-namespaced identity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WebsiteProvider, mapWebsiteEventType, websiteEventExternalId } from '../src';

const provider = new WebsiteProvider();
const ctx = { organizationId: '', credentials: {}, config: {} };

test('6/7/8: heartbeat, scroll depth and identify map to their own types -- never web.page_view', () => {
  assert.equal(mapWebsiteEventType('heartbeat'), 'web.heartbeat');
  assert.equal(mapWebsiteEventType('scroll_depth'), 'web.scroll_depth');
  assert.equal(mapWebsiteEventType('identify'), 'web.identify');
  assert.equal(mapWebsiteEventType('page_view'), 'web.page_view');
  assert.equal(mapWebsiteEventType('something_nobody_named'), 'web.other', 'an unknown event is not a page view');
  assert.equal(mapWebsiteEventType(''), 'web.other');
});

test('10/11: a parsed event carries no email or phone -- not in the payload, and not as customer identity', async () => {
  const [ev] = await provider.parseWebhook(ctx, {
    property: 'servicesinmycity',
    events: [{ event: 'phone_click', id: 'e1', email: 'jane@example.com', phone: '5551234567', phone_target: '+15551234567', cta: 'Call now', page: '/p?email=jane@example.com' }],
  });
  assert.ok(ev);
  assert.equal(ev!.customerEmail, undefined);
  assert.equal(ev!.customerPhone, undefined);
  const text = JSON.stringify(ev!.payload);
  assert.doesNotMatch(text, /jane|5551234567|15551234567/);
  assert.equal(ev!.payload['page'], '/p');
  assert.equal(ev!.payload['cta'], 'Call now');
});

test('the browser-claimed organization is never kept', async () => {
  const [ev] = await provider.parseWebhook(ctx, { property: 'servicesinmycity', organization: 'someone-else', events: [{ event: 'page_view', id: 'e1', organization: 'someone-else' }] });
  assert.equal(JSON.stringify(ev!.payload).includes('someone-else'), false);
});

test('12: identity is deterministic and property-namespaced; no receipt-time fallback', async () => {
  const body = { property: 'servicesinmycity', events: [{ event: 'page_view', page: '/a', timestamp: '2026-09-30T10:00:00.000Z', visitorId: 'v1', sessionId: 's1' }] };
  const [a] = await provider.parseWebhook(ctx, body);
  await new Promise((r) => setTimeout(r, 5));
  const [b] = await provider.parseWebhook(ctx, body);
  assert.equal(a!.externalId, b!.externalId, 'the same event redelivered is the same id');
  assert.match(a!.externalId, /^web:servicesinmycity:h:[0-9a-f]{40}$/);
  const [c] = await provider.parseWebhook(ctx, { property: 'servicesinmycity', events: [{ event: 'page_view', page: '/a', timestamp: '2026-09-30T10:00:01.000Z', visitorId: 'v1', sessionId: 's1' }] });
  assert.notEqual(c!.externalId, a!.externalId, 'a different event is a different id');
  const [d] = await provider.parseWebhook(ctx, { property: 'servicesinmycity', events: [{ event: 'page_view', id: 'uuid-1' }] });
  assert.equal(d!.externalId, 'web:servicesinmycity:uuid-1');
  const [e] = await provider.parseWebhook(ctx, { property: 'careinmycity', events: [{ event: 'page_view', id: 'uuid-1' }] });
  assert.equal(e!.externalId, 'web:careinmycity:uuid-1', 'the same sender id under another property is another event');
  assert.equal(websiteEventExternalId('p', 'bad id with spaces', { rawEventType: 'x', occurredRaw: null, minimized: {} }).startsWith('web:p:h:'), true);
});

test('12: the adapter no longer derives identity from the clock (source guard)', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'adapters', 'website.provider.ts'), 'utf8');
  assert.doesNotMatch(src, /Date\.now\(\)/);
  assert.doesNotMatch(src, /customer(Email|Phone)\s*[:,=]/, 'the adapter hands no contact detail on as identity');
});

test('a malformed property claim parses to an empty property (the webhook refuses it by code)', async () => {
  const [ev] = await provider.parseWebhook(ctx, { events: [{ event: 'page_view', property: 'Not A Key!', id: 'x' }] });
  assert.equal(ev!.payload['property'], '');
  assert.equal(ev!.externalId, 'web:unregistered:x');
});

test('page leave and the new clicks map to their own types; the legacy session_end is a page leave', () => {
  assert.equal(mapWebsiteEventType('page_leave'), 'web.page_leave');
  assert.equal(mapWebsiteEventType('session_end'), 'web.page_leave', 'it always fired on pagehide, never at the end of a visit');
  assert.equal(mapWebsiteEventType('link_click'), 'web.link_click');
  assert.equal(mapWebsiteEventType('button_click'), 'web.button_click');
});

test('click fields survive parsing minimized: destination path without query, host only, closed element type', async () => {
  const [ev] = await provider.parseWebhook(ctx, { property: 'servicesinmycity', events: [{ event: 'link_click', id: 'c1', cta: 'Plumbers', elementType: 'link', destination: '/plumbers?email=jane@example.com', destinationHost: 'evil.example/x?y' }] });
  assert.equal(ev!.payload['destination'], '/plumbers');
  assert.equal(ev!.payload['elementType'], 'link');
  assert.equal(ev!.payload['destinationHost'], undefined);
  assert.doesNotMatch(JSON.stringify(ev!.payload), /jane|email=|evil/);
});
