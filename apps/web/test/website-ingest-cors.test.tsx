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
  it('the preflight allows the exact method and headers the tracker sends', () => {
    const res = websiteIngestPreflight();
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /\bPOST\b/);
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(/\s*,\s*/);
    // Every header the tracker sets must be allowed, or the browser never sends the POST.
    assert.match(SDK, /'Content-Type': 'application\/json', 'X-EMG-Ingest-Key'/);
    for (const h of ['content-type', 'x-emg-ingest-key']) assert.ok(allowed.includes(h), h);
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
