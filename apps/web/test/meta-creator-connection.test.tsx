import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { readMetaEnvironment } from '../src/meta/meta-environment';
import PrivacyPage from '../src/app/(legal)/privacy/page';
const configured = { META_APP_ID: '12345678', META_APP_SECRET: 'a'.repeat(32), LOOP_META_TOKEN_KEY: Buffer.alloc(32, 1).toString('base64') };
test('Meta is unavailable until all server-side credentials are configured', () => {
  assert.equal(readMetaEnvironment({}), null);
  assert.equal(readMetaEnvironment({ META_APP_ID: configured.META_APP_ID }), null);
  assert.equal(readMetaEnvironment({ ...configured, LOOP_META_TOKEN_KEY: 'wrong-key' }), null);
  assert.equal(readMetaEnvironment({ ...configured, META_GRAPH_VERSION: 'https://attacker.test' }), null);
  const env = readMetaEnvironment(configured);
  assert.ok(env);
  assert.equal(env.config.redirectUri, 'https://app.emgloop.com/api/integrations/meta/callback');
});
test('callback and connect derive authority from the bound creator, never a caller-selected profile or tenant', () => {
  for (const name of ['connect', 'callback']) {
    const source = readFileSync(new URL(`../src/app/api/integrations/meta/${name}/route.ts`, import.meta.url), 'utf8');
    assert.match(source, /getSessionBinding/);
    assert.match(source, /creatorSeatOf\(bound.session\)/);
    assert.match(source, /creatorProfileId: seat.profileId/);
    assert.doesNotMatch(source, /params\.get\(['"](?:organizationId|userId|creatorProfileId|returnTo)/);
  }
});
test('Meta deletion routes delegate to a signature-verified boundary before any erasure', () => {
  const boundary = readFileSync(new URL('../src/meta/meta-deletion.ts', import.meta.url), 'utf8');
  assert.ok(boundary.indexOf('verifyMetaSignedRequest(signed') < boundary.indexOf('eraseVerifiedMetaUser(userId'));
  assert.match(boundary, /if \(!userId\) return json\(\{ ok: false \}, 401\)/);
});

test('Meta privacy disclosure names only requested scopes and explains storage and withdrawal', () => {
  const html = renderToStaticMarkup(<PrivacyPage />);
  for (const permission of ['pages_show_list', 'pages_read_engagement', 'read_insights', 'instagram_basic', 'instagram_manage_insights']) assert.ok(html.includes(permission));
  assert.match(html, /encrypted authorization tokens/);
  assert.match(html, /signed data-deletion callback/);
  assert.match(html, /Meta may update the underlying insights less frequently/);
});
