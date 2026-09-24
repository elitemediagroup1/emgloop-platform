// The TikTok Login Kit connection on the web tier, and the public legal pages it requires.
//
// WHAT THESE PROVE
//   - The deployment environment is read in ONE server-only module, off until fully and
//     validly configured; the redirect URI is the canonical origin plus the one callback.
//   - No client component can reach the environment, the runtime or the actions, and no
//     TikTok variable is ever NEXT_PUBLIC.
//   - The routes take the organization, person and session from the signed session only,
//     refuse a cross-site start and a non-creator session, answer with no-store and
//     no-referrer, and never log or echo a secret.
//   - The Profile page reads on visit through the seat, and the row shows each state honestly:
//     a plain connect link (never a router link), counts only as read, a disconnect form.
//   - /terms and /privacy render without a session, read nothing, link each other and the
//     contact, and say only what the code does; the sign-in page links both.
//
// NO VALUE HERE IS A REAL CREDENTIAL. Keys are generated for the test and discarded.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTimeView, resolveDisplayTimeZone, TIKTOK_CALLBACK_PATH, TIKTOK_CONNECT_OUTCOMES, TIKTOK_SCOPES, type TikTokScope } from '@emgloop/shared';
import type { TikTokStatus } from '@emgloop/database';

import { TIKTOK_ENVIRONMENT, readTikTokEnvironment, tiktokRedirectUri } from '../src/tiktok/tiktok-environment';
import { tiktokReturnPath } from '../src/tiktok/tiktok-runtime';
import { TIKTOK_CONNECT_ROUTE, TIKTOK_OUTCOME_MESSAGES, TikTokConnectionRow, readTikTokEntry, tiktokOutcomeParam } from '../src/app/app/creator/_parts/tiktok-connection';
import TermsPage from '../src/app/(legal)/terms/page';
import PrivacyPage from '../src/app/(legal)/privacy/page';
import { LEGAL_CONTACT_EMAIL, LEGAL_LAST_UPDATED, LEGAL_LAST_UPDATED_TEXT, LEGAL_PATHS } from '../src/app/_legal/legal-document';

const WEB = resolve(__dirname, '..');
const SRC = join(WEB, 'src');
const REPO = resolve(WEB, '..', '..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (['node_modules', '.next', 'dist', 'test'].includes(f)) return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

const KEY = randomBytes(32);
const configured = (over: Record<string, string | undefined> = {}) => ({
  [TIKTOK_ENVIRONMENT.clientKey]: 'awtestclientkey123',
  [TIKTOK_ENVIRONMENT.clientSecret]: 'not-a-real-secret-value',
  [TIKTOK_ENVIRONMENT.tokenKey]: KEY.toString('base64'),
  ...over,
});

describe('the deployment environment', () => {
  it('names exactly three variables, none public', () => {
    assert.deepEqual({ ...TIKTOK_ENVIRONMENT }, { clientKey: 'TIKTOK_CLIENT_KEY', clientSecret: 'TIKTOK_CLIENT_SECRET', tokenKey: 'LOOP_TIKTOK_TOKEN_KEY' });
    for (const name of Object.values(TIKTOK_ENVIRONMENT)) assert.doesNotMatch(name, /^NEXT_PUBLIC_/);
  });

  it('is off with nothing set, and refused whole when partial or malformed', () => {
    assert.deepEqual(readTikTokEnvironment({}, 'https://app.emgloop.com'), { state: 'NOT_CONFIGURED' });
    assert.deepEqual(readTikTokEnvironment({ [TIKTOK_ENVIRONMENT.clientKey]: '  ' }, 'https://app.emgloop.com'), { state: 'NOT_CONFIGURED' });
    const invalid = [
      { [TIKTOK_ENVIRONMENT.clientKey]: 'awtestclientkey123' },
      configured({ [TIKTOK_ENVIRONMENT.tokenKey]: undefined }),
      configured({ [TIKTOK_ENVIRONMENT.clientKey]: 'has a space' }),
      configured({ [TIKTOK_ENVIRONMENT.clientSecret]: 'has a space in it' }),
      configured({ [TIKTOK_ENVIRONMENT.tokenKey]: randomBytes(31).toString('base64') }),
      configured({ [TIKTOK_ENVIRONMENT.tokenKey]: randomBytes(33).toString('base64') }),
      configured({ [TIKTOK_ENVIRONMENT.tokenKey]: 'not base64 at all!' }),
    ];
    for (const source of invalid) assert.deepEqual(readTikTokEnvironment(source, 'https://app.emgloop.com'), { state: 'INVALID' });
    assert.deepEqual(readTikTokEnvironment(configured(), 'http://app.emgloop.com'), { state: 'INVALID' }, 'no plain http outside localhost');
  });

  it('when complete, redirects to the canonical origin plus the one callback path -- absolute, https, no query, no fragment', () => {
    const env = readTikTokEnvironment(configured(), 'https://app.emgloop.com/');
    assert.equal(env.state, 'CONFIGURED');
    if (env.state !== 'CONFIGURED') return;
    assert.equal(env.redirectUri, 'https://app.emgloop.com/api/integrations/tiktok/callback');
    assert.equal(env.clientKey, 'awtestclientkey123');
    assert.deepEqual(Buffer.from(env.tokenKey), KEY);
    assert.equal(TIKTOK_CALLBACK_PATH, '/api/integrations/tiktok/callback');
    assert.equal(tiktokRedirectUri('http://localhost:3000'), 'http://localhost:3000/api/integrations/tiktok/callback', 'a separate development client');
    for (const origin of ['http://example.com', 'https://app.emgloop.com/sub', 'https://user:pw@app.emgloop.com', 'not a url', 'https://app.emgloop.com/?x=1']) {
      assert.equal(tiktokRedirectUri(origin), null, origin);
    }
    assert.ok(existsSync(join(SRC, 'app', 'api', 'integrations', 'tiktok', 'callback', 'route.ts')), 'the callback route exists at that path');
  });
});

describe('the browser cannot reach a TikTok secret', () => {
  const ENV_MODULE = join(SRC, 'tiktok', 'tiktok-environment.ts');
  const RUNTIME = join(SRC, 'tiktok', 'tiktok-runtime.ts');
  const ACTIONS = join(SRC, 'tiktok', 'actions.ts');

  it('one module reads the three names, anywhere in the product, the packages or the operations runners', () => {
    const files = [
      ...walk(SRC),
      ...walk(join(REPO, 'packages')).filter((f) => !f.includes(`${join('packages', 'database', 'prisma')}`)),
      ...walk(join(REPO, 'scripts')),
    ].filter((f) => !/\.test\.tsx?$/.test(f));
    const readers = files.filter((f) => Object.values(TIKTOK_ENVIRONMENT).some((name) => code(readFileSync(f, 'utf8')).includes(name)));
    assert.deepEqual(readers.map((f) => relative(REPO, f)), [relative(REPO, ENV_MODULE)]);
    const callers = files.filter((f) => f.startsWith(SRC) && /readTikTokEnvironment\(/.test(code(readFileSync(f, 'utf8'))));
    assert.deepEqual(callers.map((f) => relative(REPO, f)).sort(), [relative(REPO, ENV_MODULE), relative(REPO, RUNTIME)].sort());
    const offenders = files.filter((f) => /NEXT_PUBLIC_[A-Z_]*TIKTOK/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, []);
  });

  it('the environment and runtime modules declare server-only first', () => {
    for (const file of [ENV_MODULE, RUNTIME]) {
      const src = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '').trimStart();
      assert.match(src, /^import 'server-only';/, relative(WEB, file));
    }
  });

  it('no client component reaches the environment, the runtime or the actions module; the row is a server component with plain anchors', () => {
    const resolveImport = (from: string, spec: string): string | null => {
      let base: string | null = null;
      if (spec.startsWith('.')) base = resolve(dirname(from), spec);
      else if (spec.startsWith('@/')) base = join(SRC, spec.slice(2));
      else if (spec.startsWith('@emgloop/')) {
        const [, pkg, ...rest] = spec.split('/');
        const dir = join(REPO, 'packages', pkg!);
        base = rest.length ? join(dir, ...rest) : join(dir, 'src', 'index');
      }
      if (!base) return null;
      for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
        if (existsSync(c) && statSync(c).isFile()) return c;
      }
      return null;
    };
    const importsOf = (file: string) =>
      [...readFileSync(file, 'utf8').matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g)]
        .map((m) => m[1] ?? m[2])
        .filter((s): s is string => Boolean(s))
        .map((s) => resolveImport(file, s))
        .filter((f): f is string => Boolean(f));
    const clients = walk(SRC).filter((f) => /^\s*['"]use client['"]/.test(readFileSync(f, 'utf8')));
    assert.ok(clients.length >= 5);
    for (const entry of clients) {
      const seen = new Set<string>();
      const stack = [entry];
      while (stack.length) {
        const file = stack.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        for (const forbidden of [ENV_MODULE, RUNTIME, ACTIONS]) assert.notEqual(file, forbidden, `${relative(WEB, entry)} reaches ${relative(WEB, forbidden)}`);
        if (file !== entry && /^\s*['"]use server['"]/.test(readFileSync(file, 'utf8'))) continue;
        stack.push(...importsOf(file));
      }
    }
    const row = read('app/app/creator/_parts/tiktok-connection.tsx');
    assert.doesNotMatch(row, /^\s*['"]use client['"]/m);
    assert.doesNotMatch(row, /from 'next\/link'/, 'a prefetch must never start a consent attempt');
    assert.doesNotMatch(row, /console\./);
  });
});

describe('the routes', () => {
  const connect = code(read('app/api/integrations/tiktok/connect/route.ts'));
  const callback = code(read('app/api/integrations/tiktok/callback/route.ts'));

  it('take the organization, person and session from the signed session only', () => {
    for (const [name, src] of [['connect', connect], ['callback', callback]] as const) {
      assert.match(src, /const bound = await getSessionBinding\(\);/, name);
      assert.match(src, /organizationId: bound\.session\.organizationId,\s*userId: bound\.session\.userId,/, name);
      assert.match(src, /sessionId: bound\.sessionId,/, name);
      assert.doesNotMatch(src, /searchParams\.get\('(organizationId|organization|org|userId|user|sessionId|redirect|next|return|profile|creator)'\)/, name);
      assert.doesNotMatch(src, /console\./, `${name} logs nothing`);
      assert.match(src, /'cache-control': 'no-store', 'referrer-policy': 'no-referrer'/, name);
      assert.doesNotMatch(src, /(?:err|error)\.message|JSON\.stringify\(err/, `${name} never echoes an error`);
      assert.match(src, /status: 303/, name);
    }
    assert.match(connect, /request\.headers\.get\('sec-fetch-site'\) === 'cross-site'/, 'a cross-site start is refused');
    assert.match(connect, /resolveWorkspaceRole\(bound\.session\) !== 'CREATOR'/, 'only a creator session may start');
    assert.doesNotMatch(connect, /searchParams/, 'the connect route reads no query: one thing to ask for, one page to return to');
    assert.match(callback, /state: url\.searchParams\.get\('state'\),\s*code: url\.searchParams\.get\('code'\),\s*error: url\.searchParams\.get\('error'\),/);
  });

  it('return the creator to their Profile with a closed outcome code', () => {
    assert.equal(tiktokReturnPath('CONNECTED'), '/app/creator/profile?tiktok=CONNECTED');
    assert.equal(tiktokReturnPath('DISCONNECTED_UNCONFIRMED'), '/app/creator/profile?tiktok=DISCONNECTED_UNCONFIRMED');
    assert.equal(tiktokOutcomeParam('CONNECTED'), 'CONNECTED');
    assert.equal(tiktokOutcomeParam('<script>'), null);
    assert.equal(tiktokOutcomeParam(['CONNECTED', 'FAILED']), null);
    assert.equal(tiktokOutcomeParam(undefined), null);
    assert.equal(TIKTOK_CONNECT_ROUTE, '/api/integrations/tiktok/connect');
  });

  it('the action and the page act on the seat, never on anything the request names; the read happens before the profile is loaded', () => {
    const actions = code(read('tiktok/actions.ts'));
    assert.match(actions, /^\s*'use server';/);
    assert.match(actions, /const seat = await requireCreator\(\);/);
    assert.doesNotMatch(actions, /formData\.get\(/);
    const page = code(read('app/app/creator/profile/page.tsx'));
    assert.match(page, /await requireWorkspace\('CREATOR'\);\s*const seat = await requireCreator\(\);/);
    const readAt = page.indexOf('tiktok().readOnVisit(principal)');
    const loadedAt = page.indexOf('domain.creator.profileById(');
    assert.ok(readAt > 0 && loadedAt > readAt, 'the visit read precedes the profile load, so the page shows what it returned');
    assert.match(page, /<TikTokConnectionRow status=\{tiktokStatus\.value\}/);
    assert.match(page, /readSocial\(profile\?\.socialAccounts\)\.filter\(\(s\) => s\.platform !== 'TIKTOK'\)/, 'TikTok is shown once, from its connection');
  });
});

// --- The row ---------------------------------------------------------------------------------

const NOW = new Date('2026-09-24T12:00:00Z');
const time = createTimeView(resolveDisplayTimeZone({ device: 'UTC' }), NOW);
const ALL: readonly TikTokScope[] = TIKTOK_SCOPES;

function status(over: Partial<TikTokStatus> = {}): TikTokStatus {
  return { permitted: true, configured: true, state: 'NOT_CONNECTED', connection: null, ...over };
}
function live(state: 'CONNECTED' | 'PARTIAL' | 'EXPIRED', granted: readonly TikTokScope[] = ALL): TikTokStatus {
  return status({
    state,
    connection: {
      status: state === 'EXPIRED' ? 'EXPIRED' : 'CONNECTED',
      handle: 'konareyes',
      grantedScopes: granted,
      missingScopes: ALL.filter((s) => !granted.includes(s)),
      connectedAt: new Date('2026-09-24T10:00:00Z'),
      lastReadAt: new Date('2026-09-24T11:50:00Z'),
      lastFailureClass: null,
      expiredAt: state === 'EXPIRED' ? NOW : null,
      revokedAt: null,
      revocationUnconfirmed: false,
    },
  });
}
const ENTRY = readTikTokEntry({
  platform: 'TIKTOK',
  state: 'CONNECTED',
  handle: '@konareyes',
  profileUrl: 'https://www.tiktok.com/@konareyes',
  readAt: '2026-09-24T11:50:00.000Z',
  stats: { followers: 18412, following: 120, likes: 250000, videos: 88 },
  recentVideos: [
    { id: 'v1', title: 'Unboxing', shareUrl: 'https://www.tiktok.com/@konareyes/video/v1', createdAt: '2026-09-20T10:00:00.000Z', viewCount: 12000, likeCount: 800 },
    { id: 'v2', title: null, shareUrl: 'javascript:alert(1)', createdAt: 'not a date', viewCount: 'many' },
  ],
});
const render = (props: Parameters<typeof TikTokConnectionRow>[0]) => renderToStaticMarkup(<TikTokConnectionRow {...props} />);

describe('the row', () => {
  it('reads the stored entry defensively: handles without @, only https links, numbers only', () => {
    assert.ok(ENTRY);
    assert.equal(ENTRY!.handle, 'konareyes');
    assert.equal(ENTRY!.profileUrl, 'https://www.tiktok.com/@konareyes');
    assert.deepEqual(ENTRY!.stats, { followers: 18412, following: 120, likes: 250000, videos: 88 });
    assert.equal(ENTRY!.recentVideos.length, 2);
    assert.equal(ENTRY!.recentVideos[1]!.shareUrl, null, 'a non-https link is dropped');
    assert.equal(ENTRY!.recentVideos[1]!.createdAt, null);
    assert.equal(ENTRY!.recentVideos[1]!.viewCount, null);
    assert.equal(readTikTokEntry(null), null);
    assert.equal(readTikTokEntry('x'), null);
  });

  it('not connected: a plain connect link, what each scope lets Loop read, and the privacy link', () => {
    const html = render({ status: status(), entry: null, outcome: null, readProblem: null, time });
    assert.match(html, /data-tiktok-state="NOT_CONNECTED"/);
    assert.ok(html.includes('<a class="loop-btn loop-btn--primary" href="/api/integrations/tiktok/connect" rel="nofollow">Connect TikTok</a>'), html);
    for (const scope of ['Basic account info', 'Public profile', 'Account counts', 'Public video list']) assert.match(html, new RegExp(scope));
    assert.match(html, /never posts to TikTok and never reads private videos/);
    assert.match(html, /href="\/privacy"/);
    assert.doesNotMatch(html, /Disconnect TikTok|Followers/);
    // A seeded entry is said to be demo data until a real connection replaces it.
    const seeded = render({ status: status(), entry: readTikTokEntry({ platform: 'TIKTOK', state: 'SEEDED_DEMO', handle: 'demo' }), outcome: null, readProblem: null, time });
    assert.match(seeded, /@demo · listed by EMG as demo data/);
  });

  it('not configured or not permitted: honest blocks and nothing to click', () => {
    const off = render({ status: status({ configured: false, state: 'NOT_CONFIGURED' }), entry: null, outcome: null, readProblem: null, time });
    assert.match(off, /data-tiktok-state="NOT_CONFIGURED"/);
    assert.match(off, /aria-disabled="true"/);
    assert.match(off, /not set up on this deployment/);
    assert.doesNotMatch(off, /href="\/api\/integrations\/tiktok\/connect"/);
    const denied = render({ status: { permitted: false }, entry: null, outcome: null, readProblem: null, time });
    assert.match(denied, /data-state="denied"/);
    assert.doesNotMatch(denied, /api\/integrations\/tiktok/);
  });

  it('connected: the counts and videos exactly as read, when they were read, the profile link, and a disconnect form -- no connect link', () => {
    const html = render({ status: live('CONNECTED'), entry: ENTRY, outcome: 'CONNECTED', readProblem: null, time });
    assert.match(html, /data-tiktok-state="CONNECTED"/);
    assert.match(html, /data-tiktok-outcome="CONNECTED"/);
    assert.match(html, /<a href="https:\/\/www\.tiktok\.com\/@konareyes" rel="noreferrer noopener">@konareyes<\/a>/);
    assert.match(html, /<dt>Followers<\/dt><dd>18\.4K<\/dd>/);
    assert.match(html, /<dt>Videos<\/dt><dd>88<\/dd>/);
    assert.ok(html.includes(`<dt>Last read</dt><dd>${time.relative(new Date('2026-09-24T11:50:00Z'))}</dd>`), html);
    assert.match(html, /Recent public videos, as listed/);
    assert.match(html, /<a href="https:\/\/www\.tiktok\.com\/@konareyes\/video\/v1" rel="noreferrer noopener">Unboxing<\/a>/);
    assert.match(html, /12K views · 800 likes/);
    assert.match(html, /Untitled video/);
    assert.doesNotMatch(html, /javascript:/);
    assert.match(html, /<button class="loop-btn" type="submit">Disconnect TikTok<\/button>/);
    assert.doesNotMatch(html, /href="\/api\/integrations\/tiktok\/connect"/, 'nothing left to connect');
    assert.doesNotMatch(html, /Connecting lets Loop read/);
  });

  it('connected before any read: counts are "not read yet", never zero', () => {
    const html = render({ status: live('CONNECTED'), entry: readTikTokEntry({ platform: 'TIKTOK', state: 'CONNECTED', handle: 'konareyes' }), outcome: null, readProblem: null, time });
    assert.equal((html.match(/Not read yet/g) ?? []).length, 5, 'four counts and the read time');
    assert.doesNotMatch(html, /<dd>0<\/dd>/);
    assert.match(html, /Videos appear here after the first read/);
  });

  it('partly connected: names the access not allowed, offers the rest, and marks the counts it cannot read as not allowed', () => {
    const html = render({ status: live('PARTIAL', ['user.info.basic', 'user.info.profile']), entry: ENTRY, outcome: 'PARTIAL', readProblem: null, time });
    assert.match(html, /data-tiktok-state="PARTIAL"/);
    assert.match(html, /Loop cannot read: Account counts, Public video list/);
    assert.ok(html.includes('<a class="loop-btn loop-btn--primary" href="/api/integrations/tiktok/connect" rel="nofollow">Allow the rest</a>'));
    assert.doesNotMatch(html, /Recent public videos/, 'no video list without the scope');
    assert.match(html, /Disconnect TikTok/);
  });

  it('reconnect required: says TikTok no longer accepts the access, offers reconnect, shows no counts', () => {
    const html = render({ status: live('EXPIRED'), entry: ENTRY, outcome: null, readProblem: null, time });
    assert.match(html, /data-tiktok-state="EXPIRED"/);
    assert.match(html, /Reconnect required/);
    assert.match(html, /TikTok no longer accepts Loop’s access/);
    assert.ok(html.includes('<a class="loop-btn loop-btn--primary" href="/api/integrations/tiktok/connect" rel="nofollow">Reconnect TikTok</a>'));
    assert.doesNotMatch(html, /Followers|Disconnect TikTok/);
  });

  it('a read that failed this visit is said, and the shown counts are dated as the last completed read', () => {
    const html = render({ status: live('CONNECTED'), entry: ENTRY, outcome: null, readProblem: 'UNAVAILABLE', time });
    assert.match(html, /Loop could not read your TikTok account just now/);
    assert.ok(html.includes(`from the last completed read, ${time.relative(new Date('2026-09-24T11:50:00Z'))}`), html);
    const forbidden = render({ status: live('CONNECTED'), entry: ENTRY, outcome: null, readProblem: 'INSUFFICIENT_SCOPE', time });
    assert.match(forbidden, /TikTok refused a read/);
    const crashed = render({ status: live('CONNECTED'), entry: null, outcome: null, readProblem: 'READ_FAILED', time });
    assert.match(crashed, /Nothing has been read yet\. Loop tries again on your next visit\./);
  });

  it('every outcome has plain words and none of them carries a secret or TikTok’s text', () => {
    for (const outcome of TIKTOK_CONNECT_OUTCOMES) {
      const message = TIKTOK_OUTCOME_MESSAGES[outcome];
      assert.ok(message.title && message.body, outcome);
      assert.doesNotMatch(`${message.title} ${message.body}`, /token|invalid_grant|access_denied|secret|tiktokapis|open_id/i, outcome);
      const html = render({ status: status(), entry: null, outcome, readProblem: null, time });
      assert.match(html, new RegExp(`data-tiktok-outcome="${outcome}"`));
    }
  });
});

// --- The public legal pages ----------------------------------------------------------------

describe('the public legal pages', () => {
  const terms = renderToStaticMarkup(<TermsPage />);
  const privacy = renderToStaticMarkup(<PrivacyPage />);

  it('are public: outside the middleware matcher, in the reviewed public-page set, and import no session, data or environment', () => {
    const middleware = code(read('middleware.ts'));
    assert.match(middleware, /matcher: \['\/crm\/:path\*', '\/app\/:path\*'\]/);
    assert.deepEqual({ ...LEGAL_PATHS }, { terms: '/terms', privacy: '/privacy' });
    for (const p of ['app/(legal)/terms/page.tsx', 'app/(legal)/privacy/page.tsx', 'app/_legal/legal-document.tsx', 'app/(legal)/layout.tsx']) {
      const src = read(p);
      assert.doesNotMatch(src, /@emgloop\/database|\.\.\/auth\/|\/auth\/|process\.env|prisma|repositories|getSession|cookies\(|headers\(/, p);
    }
    const layout = code(read('app/(legal)/layout.tsx'));
    assert.match(layout, /import '\.\.\/loop-os\.css';/);
    assert.doesNotMatch(layout, /WorkspaceShell|requireWorkspace/);
    assert.equal(existsSync(join(SRC, 'app', 'terms')), false, 'the pages live in the route group, at the root URLs');
  });

  it('carry the operator, the date, the contact and each other’s link, in a footer on both', () => {
    assert.equal(LEGAL_LAST_UPDATED, '2026-09-24');
    for (const [name, html] of [['terms', terms], ['privacy', privacy]] as const) {
      assert.match(html, /Elite Media Group/, name);
      assert.ok(html.includes(`Last updated ${LEGAL_LAST_UPDATED_TEXT}.`), name);
      assert.ok(html.includes(`href="mailto:${LEGAL_CONTACT_EMAIL}"`), name);
      assert.match(html, /<footer class="loop-legal__foot" aria-label="Legal">/, name);
      assert.match(html, /href="\/terms">Terms of Service<\/a>/, name);
      assert.match(html, /href="\/privacy">Privacy Policy<\/a>/, name);
      assert.doesNotMatch(html, /\[CONTACT ADDRESS/, name);
    }
    assert.match(terms, /<h1 class="loop-title">Terms of Service<\/h1>/);
    assert.match(privacy, /<h1 class="loop-title">Privacy Policy<\/h1>/);
  });

  it('the privacy policy states exactly what the code does with a TikTok account, and no more', () => {
    for (const scope of TIKTOK_SCOPES) assert.match(privacy, new RegExp(scope.replace(/\./g, '\\.')), scope);
    assert.match(privacy, /up to ten of your most recent public videos/);
    assert.match(privacy, /more than fifteen minutes old/);
    assert.match(privacy, /does not read your account in the background/);
    assert.match(privacy, /AES-256-GCM/);
    assert.match(privacy, /replaced on every refresh/);
    assert.match(privacy, /never posts to TikTok/);
    assert.match(privacy, /does not ask for and does not receive your avatar, your bio, your email address/);
    assert.match(privacy, /Security and permissions → Apps and services/);
    assert.match(privacy, /Disconnect TikTok/);
    assert.match(privacy, /emgloop_session/);
    assert.doesNotMatch(privacy, /post on your behalf|publish|upload to TikTok|direct messages/i, 'no capability Loop does not have');
  });

  it('the terms cover the Creator Hub, connections, permitted use, third-party platforms, disconnecting, availability, termination and disclaimers', () => {
    for (const heading of ['The Creator Hub', 'Connecting a third-party account', 'Permitted use', 'Disconnecting and deleting', 'Availability and changes', 'Ending your access', 'Disclaimers and limitation of liability', 'Contact']) {
      assert.match(terms, new RegExp(`<h2>\\d+\\. ${heading}</h2>`), heading);
    }
    assert.match(terms, /TikTok is an independent service/);
    assert.match(terms, /Loop never posts to a connected account/);
  });

  it('the sign-in page links both documents in a visible footer after Need access, and the layout classes declare no colour', () => {
    const login = read('app/crm/login/page.tsx');
    const needAccess = login.indexOf('loop-auth__needaccess');
    const footer = login.indexOf('loop-auth__footer');
    assert.ok(needAccess > 0 && footer > needAccess);
    assert.match(login, /<Link href="\/terms">Terms of Service<\/Link>/);
    assert.match(login, /<Link href="\/privacy">Privacy Policy<\/Link>/);
    assert.match(login, /EMG Loop is operated by Elite Media Group\./);
    const css = read('app/loop-os.css');
    const start = css.indexOf('/* ===================== PUBLIC LEGAL PAGES =====================');
    const end = css.indexOf('/* ===================== CREATOR HUB =====================');
    assert.ok(start > 0 && end > start);
    const section = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(section), false, 'no colour literal');
    assert.equal(/--[a-z0-9-]+\s*:/.test(section), false, 'no token declared');
    const sprint7 = read('app/crm/sprint7.css');
    const footerCss = sprint7.slice(sprint7.indexOf('.crm .loop-auth__footer {'), sprint7.indexOf('.crm .loop-auth__footer-operator'));
    assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(footerCss), false, 'the login footer draws only with tokens');
  });
});
