// The website webhook's browser tier is cross-origin (2026-10-05). Production answered the tracker's CORS preflight
// with a bare 204 and no Access-Control-Allow-* headers, so browsers blocked every tracker POST before sending it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WEBSITE_INGEST_CORS_HEADERS, websiteIngestPreflight, withWebsiteIngestCors } from '../src/app/api/webhooks/website/website-cors';

const ROUTE = readFileSync(join(__dirname, '..', 'src', 'app', 'api', 'webhooks', 'website', 'route.ts'), 'utf8');
const SDK = readFileSync(join(__dirname, '..', 'public', 'sdk', 'emg-loop.js'), 'utf8');

describe('website ingest CORS', () => {
  it('the preflight allows what a pre-1.1.0 tracker sends (JSON + X-EMG-Ingest-Key), for copies still cached in browsers', () => {
    const res = websiteIngestPreflight();
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /\bPOST\b/);
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(/\s*,\s*/);
    for (const h of ['content-type', 'x-emg-ingest-key']) assert.ok(allowed.includes(h), h);
  });

  it('the v1.1.0 tracker sends CORS-SIMPLE requests: text/plain, no custom header, the ingest key in the body', () => {
    // A simple request needs no preflight, so page-hide beacons and keepalive fetches survive navigation.
    assert.match(SDK, /var CONTENT_TYPE = 'text\/plain;charset=UTF-8';/);
    assert.match(SDK, /headers: \{ 'Content-Type': CONTENT_TYPE \}/);
    assert.doesNotMatch(SDK, /X-EMG-Ingest-Key|application\/json/);
    assert.match(SDK, /ingestKey: config\.ingestKey, events:/);
    // The route reads the key from the body when there is no header, and parses the body text whatever its type.
    assert.match(ROUTE, /const fromBody = payload\['ingestKey'\] \?\? payload\['ingest_key'\];/);
    assert.match(ROUTE, /const rawBody = await req\.text\(\);/);
  });

  it('CORS never involves credentials: `*` is only valid because the tracker omits them', () => {
    assert.equal(WEBSITE_INGEST_CORS_HEADERS['Access-Control-Allow-Credentials'], undefined);
    assert.match(SDK, /credentials: 'omit'/);
  });

  it('every POST reply carries the headers, so fetch does not reject a stored event and retry it', () => {
    const res = withWebsiteIngestCors(new Response('{}', { status: 422 }));
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(ROUTE, /export function OPTIONS\(\): Response \{\s*return websiteIngestPreflight\(\);/);
    assert.match(ROUTE, /export async function POST\(req: Request\): Promise<Response> \{\s*return withWebsiteIngestCors\(await receive\(req\)\);/);
  });

  it('CORS is not the authority: admission still decides, and the Origin is still checked in production', () => {
    assert.match(ROUTE, /admitWebsiteDelivery\(/);
    assert.match(ROUTE, /enforceDomain: isProd/);
  });
});
