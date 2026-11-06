import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProductHome, CreatorHubOverview, TikTokOverview } from '../src/app/_public/product-site';
import { loginPathFor } from '../src/auth/landing';
import { readFileSync } from 'node:fs';

describe('Public product website', () => {
  it('every page renders public policy and sign-in links without a session or creator record', () => {
    for (const View of [ProductHome, CreatorHubOverview, TikTokOverview]) {
      const html = renderToStaticMarkup(<View />);
      assert.match(html, /href="\/privacy"/);
      assert.match(html, /href="\/terms"/);
      assert.match(html, /href="\/crm\/login/);
      assert.match(html, /href="#product-main"/);
      assert.equal((html.match(/<main\b/g) ?? []).length, 1);
      assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
      assert.doesNotMatch(html, /trevon|bassforecast|creator-media|password.*value=|access_token|client_secret/i);
    }
  });
  it('a requested private destination survives in the sign-in CTA; external destinations never do', () => {
    const html = renderToStaticMarkup(<ProductHome signInHref={loginPathFor('/app/creator/profile')} />);
    assert.match(html, /href="\/crm\/login\?next=%2Fapp%2Fcreator%2Fprofile"/);
    const unsafe = renderToStaticMarkup(<ProductHome signInHref={loginPathFor('https://evil.example')} />);
    assert.doesNotMatch(unsafe, /evil\.example/);
  });
  it('labels the layout illustration and distinguishes pending access from active TikTok production capability', () => {
    assert.match(renderToStaticMarkup(<ProductHome />), /Product layout illustration\. No live creator data\./);
    const tiktok = renderToStaticMarkup(<TikTokOverview />);
    for (const scope of ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list']) assert.ok(tiktok.includes(scope));
    assert.match(tiktok, /Production connection pending TikTok approval/);
    assert.match(tiktok, /developer sandbox/);
    assert.match(tiktok, /Disconnect/);
    assert.match(tiktok, /does not post to TikTok/);
    assert.doesNotMatch(tiktok, /href="\/api\/integrations\/tiktok\/connect/);
  });
  it('public presentation and detail routes have no private data or environment dependencies', () => {
    for (const path of ['../src/app/_public/product-site.tsx', '../src/app/(public)/creator-hub/page.tsx', '../src/app/(public)/integrations/tiktok/page.tsx']) {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /@emgloop\/database|requireCreator|getSession|process\.env|fetch\(|prisma\./);
    }
  });
});
