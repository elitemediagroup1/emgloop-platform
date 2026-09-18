// The Google Workspace connection on the web tier.
//
// WHAT THESE PROVE
//   - The deployment environment is read in ONE server-only module, off until fully and
//     validly configured; the redirect URI is the canonical origin plus the one callback.
//   - No client component can reach the environment, the runtime, the sealer or the OAuth
//     client, and no Google variable is ever NEXT_PUBLIC.
//   - The routes take the organization, person and session from the signed session only,
//     answer with no-store and no-referrer, and never log or echo a secret.
//   - Onboarding follows invitation acceptance through the landing authority; Connections is
//     guarded like every other page; the panel shows each capability's state honestly and
//     offers one capability per consent.
//
// NO VALUE HERE IS A REAL CREDENTIAL. Keys are generated for the test and discarded.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTimeView, resolveDisplayTimeZone, GOOGLE_CONNECT_OUTCOMES, type GoogleCapabilityState } from '@emgloop/shared';
import type { GoogleWorkspaceStatus } from '@emgloop/database';

import { GOOGLE_CALLBACK_PATH, GOOGLE_ENVIRONMENT, googleRedirectUri, readGoogleEnvironment } from '../src/google/google-environment';
import { googleReturnPath } from '../src/google/google-runtime';
import { CONNECTIONS_PATH, ONBOARDING_GOOGLE_PATH, postInvitationDestination, safeNextPath } from '../src/auth/landing';
import { GOOGLE_OUTCOME_MESSAGES, GoogleWorkspacePanel } from '../src/app/app/_google/google-workspace-panel';
import { googleOutcomeParam, googleReconnectParam } from '../src/app/app/_google/search-params';

const WEB = resolve(__dirname, '..');
const SRC = join(WEB, 'src');
const REPO = resolve(WEB, '..', '..');
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (['node_modules', '.next', 'dist', 'test'].includes(f)) return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

const CLIENT_ID = '123456789012-abcdef.apps.googleusercontent.com';
const KEY = randomBytes(32);
const configured = (over: Record<string, string | undefined> = {}) => ({
  [GOOGLE_ENVIRONMENT.clientId]: CLIENT_ID,
  [GOOGLE_ENVIRONMENT.clientSecret]: 'GOCSPX-not-a-real-secret',
  [GOOGLE_ENVIRONMENT.tokenKey]: KEY.toString('base64'),
  ...over,
});

describe('the deployment environment', () => {
  it('names exactly three variables, none public', () => {
    assert.deepEqual({ ...GOOGLE_ENVIRONMENT }, {
      clientId: 'GOOGLE_OAUTH_CLIENT_ID',
      clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET',
      tokenKey: 'LOOP_GOOGLE_TOKEN_KEY',
    });
    for (const name of Object.values(GOOGLE_ENVIRONMENT)) assert.doesNotMatch(name, /^NEXT_PUBLIC_/);
  });

  it('is off with nothing set, and refused whole when partial or malformed', () => {
    assert.deepEqual(readGoogleEnvironment({}, 'https://app.emgloop.com'), { state: 'NOT_CONFIGURED' });
    assert.deepEqual(readGoogleEnvironment({ [GOOGLE_ENVIRONMENT.clientId]: '  ' }, 'https://app.emgloop.com'), { state: 'NOT_CONFIGURED' });
    const invalid = [
      { [GOOGLE_ENVIRONMENT.clientId]: CLIENT_ID },
      configured({ [GOOGLE_ENVIRONMENT.tokenKey]: undefined }),
      configured({ [GOOGLE_ENVIRONMENT.clientId]: 'not-a-google-client' }),
      configured({ [GOOGLE_ENVIRONMENT.clientSecret]: 'has a space in it' }),
      configured({ [GOOGLE_ENVIRONMENT.tokenKey]: randomBytes(31).toString('base64') }),
      configured({ [GOOGLE_ENVIRONMENT.tokenKey]: randomBytes(33).toString('base64') }),
      configured({ [GOOGLE_ENVIRONMENT.tokenKey]: 'not base64 at all!' }),
    ];
    for (const source of invalid) assert.deepEqual(readGoogleEnvironment(source, 'https://app.emgloop.com'), { state: 'INVALID' });
    assert.deepEqual(readGoogleEnvironment(configured(), 'http://app.emgloop.com'), { state: 'INVALID' }, 'no plain http outside localhost');
  });

  it('when complete, redirects to the canonical origin plus the one callback path', () => {
    const env = readGoogleEnvironment(configured(), 'https://app.emgloop.com/');
    assert.equal(env.state, 'CONFIGURED');
    if (env.state !== 'CONFIGURED') return;
    assert.equal(env.redirectUri, 'https://app.emgloop.com/api/integrations/google/callback');
    assert.equal(env.clientId, CLIENT_ID);
    assert.deepEqual(Buffer.from(env.tokenKey), KEY);
    assert.equal(readGoogleEnvironment(configured({ [GOOGLE_ENVIRONMENT.tokenKey]: KEY.toString('base64url') }), 'https://app.emgloop.com').state, 'CONFIGURED');
    assert.equal(GOOGLE_CALLBACK_PATH, '/api/integrations/google/callback');
    assert.equal(googleRedirectUri('http://localhost:3000'), 'http://localhost:3000/api/integrations/google/callback', 'a separate development client');
    for (const origin of ['http://example.com', 'https://app.emgloop.com/sub', 'https://user:pw@app.emgloop.com', 'ftp://app.emgloop.com', 'not a url', 'https://app.emgloop.com/?x=1']) {
      assert.equal(googleRedirectUri(origin), null, origin);
    }
  });
});

describe('the browser cannot reach a Google secret', () => {
  const ENV_MODULE = join(SRC, 'google', 'google-environment.ts');
  const SHARED_ENV_MODULE = join(REPO, 'packages', 'shared', 'src', 'google-environment.ts');
  const RUNTIME = join(SRC, 'google', 'google-runtime.ts');
  const SEALER = join(REPO, 'packages', 'database', 'src', 'services', 'google', 'google-token-sealer.ts');

  it('one module reads the three names, anywhere in the product, the packages or the operations runners', () => {
    // ONE, since DL-5: the pure reader in @emgloop/shared owns the names and the validation, and
    // every runtime that holds this configuration -- this app's server-only edge, and the
    // scheduled Calendar cycle -- passes it their own environment rather than naming a variable.
    // A laxer second reader is how a wrong token key reaches the sealer, and a wrong key marks
    // every employee's connection expired on its way past.
    const files = [
      ...walk(SRC),
      ...walk(join(REPO, 'packages')).filter((f) => !f.includes(`${join('packages', 'database', 'prisma')}`)),
      ...walk(join(REPO, 'scripts')),
    ].filter((f) => !/\.test\.tsx?$/.test(f));
    const readers = files.filter((f) => Object.values(GOOGLE_ENVIRONMENT).some((name) => code(readFileSync(f, 'utf8')).includes(name)));
    assert.deepEqual(readers.map((f) => relative(REPO, f)), [relative(REPO, SHARED_ENV_MODULE)]);
    // And this app still reaches it through its one server-only edge: nothing else in the web
    // source calls the shared reader directly.
    const callers = files.filter((f) => f.startsWith(SRC) && /readGoogleEnvironment(From)?\(/.test(code(readFileSync(f, 'utf8'))));
    assert.deepEqual(
      callers.map((f) => relative(REPO, f)).sort(),
      [
        relative(REPO, ENV_MODULE),
        relative(REPO, RUNTIME),
        relative(REPO, join(SRC, 'daily-loop', 'calendar-runtime.ts')),
        relative(REPO, join(SRC, 'daily-loop', 'mail.ts')),
        relative(REPO, join(SRC, 'daily-loop', 'mail-send-runtime.ts')),
        relative(REPO, join(SRC, 'daily-loop', 'mail-runtime.ts')),
      ].sort(),
    );
    const offenders = files.filter((f) => /NEXT_PUBLIC_[A-Z_]*GOOGLE/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, []);
  });

  it('the environment and runtime modules declare server-only first', () => {
    for (const file of [ENV_MODULE, RUNTIME]) {
      const src = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '').trimStart();
      assert.match(src, /^import 'server-only';/, relative(WEB, file));
    }
  });

  it('no client component reaches the environment, the runtime, the sealer or the actions module', () => {
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
        for (const forbidden of [ENV_MODULE, RUNTIME]) assert.notEqual(file, forbidden, `${relative(WEB, entry)} reaches ${relative(WEB, forbidden)}`);
        if (file !== entry && /^\s*['"]use server['"]/.test(readFileSync(file, 'utf8'))) continue;
        stack.push(...importsOf(file));
      }
    }
    // The panel is a server component: no client directive, no router links that could prefetch a consent attempt.
    const panel = read('app/app/_google/google-workspace-panel.tsx');
    assert.doesNotMatch(panel, /^\s*['"]use client['"]/);
    assert.doesNotMatch(panel, /from 'next\/link'/);
    assert.ok(existsSync(SEALER));
  });
});

describe('the routes', () => {
  const connect = code(read('app/api/integrations/google/connect/route.ts'));
  const callback = code(read('app/api/integrations/google/callback/route.ts'));

  it('take the organization, person and session from the signed session only', () => {
    for (const [name, src] of [['connect', connect], ['callback', callback]] as const) {
      assert.match(src, /const bound = await getSessionBinding\(\);/, name);
      assert.match(src, /organizationId: bound\.session\.organizationId,\s*userId: bound\.session\.userId,/, name);
      assert.match(src, /sessionId: bound\.sessionId,/, name);
      assert.doesNotMatch(src, /searchParams\.get\('(organizationId|organization|org|userId|user|sessionId|redirect|next)'\)/, name);
      assert.doesNotMatch(src, /console\./, `${name} logs nothing`);
      assert.match(src, /'cache-control': 'no-store', 'referrer-policy': 'no-referrer'/, name);
      assert.doesNotMatch(src, /(?:err|error)\.message|JSON\.stringify\(err/, `${name} never echoes an error`);
    }
    assert.match(connect, /searchParams\.getAll\('capability'\)/);
    assert.match(connect, /request\.headers\.get\('sec-fetch-site'\) === 'cross-site'/, 'a cross-site start is refused');
    assert.doesNotMatch(callback, /searchParams\.get\('return'\)/, 'the return page comes from the stored attempt, never the callback');
    assert.match(callback, /state: url\.searchParams\.get\('state'\),\s*code: url\.searchParams\.get\('code'\),\s*error: url\.searchParams\.get\('error'\),/);
  });

  it('return the person to where they started, with a closed outcome code', () => {
    assert.equal(googleReturnPath('ONBOARDING', 'CONNECTED'), '/app/onboarding/google?google=CONNECTED');
    assert.equal(googleReturnPath('CONNECTIONS', 'DISCONNECTED', { reconnect: 'calendar,drive' }), '/app/connections?google=DISCONNECTED&reconnect=calendar%2Cdrive');
    assert.equal(googleOutcomeParam({ google: 'CONNECTED' }), 'CONNECTED');
    assert.equal(googleOutcomeParam({ google: '<script>' }), null);
    assert.equal(googleOutcomeParam({ google: ['CONNECTED', 'FAILED'] }), null);
    assert.deepEqual(googleReconnectParam({ reconnect: 'drive,calendar' }), ['calendar', 'drive']);
    assert.deepEqual(googleReconnectParam({ reconnect: 'drive,contacts' }), []);
    assert.deepEqual(googleReconnectParam(undefined), []);
  });
});

describe('onboarding and connections', () => {
  it('an accepted invitation lands on the Google onboarding step, through the landing authority', () => {
    assert.equal(postInvitationDestination(), ONBOARDING_GOOGLE_PATH);
    assert.equal(ONBOARDING_GOOGLE_PATH, '/app/onboarding/google');
    assert.equal(CONNECTIONS_PATH, '/app/connections');
    const actions = code(read('auth/actions.ts'));
    const accept = actions.slice(actions.indexOf('export async function acceptInviteAction'));
    assert.match(accept, /redirect\(postInvitationDestination\(\)\);\s*\}\s*$/);
    assert.equal(safeNextPath(ONBOARDING_GOOGLE_PATH), ONBOARDING_GOOGLE_PATH, 'survives sign-in like any application page');
    assert.equal(safeNextPath(`${CONNECTIONS_PATH}?google=STATE_INVALID`), `${CONNECTIONS_PATH}?google=STATE_INVALID`);
  });

  it('each page guards itself; onboarding lets a role without a Google connection straight through', () => {
    const connections = code(read('app/app/connections/page.tsx'));
    assert.match(connections, /const session = await requirePermission\('googleWorkspace', 'view'\);/);
    assert.match(connections, /<WorkspaceShell session=\{session\}>/);
    const onboarding = code(read('app/app/onboarding/google/page.tsx'));
    assert.match(onboarding, /const session = await requireWorkspaceSession\(ONBOARDING_GOOGLE_PATH\);/);
    assert.match(onboarding, /if \(!status\.permitted\) redirect\(LOOP_HOME\);/);
    for (const src of [connections, onboarding]) {
      assert.match(src, /organizationId: session\.organizationId,\s*userId: session\.userId,/);
    }
  });

  it('the actions act on the session’s own connection, and offboarding revokes after the membership change', () => {
    const actions = code(read('google/actions.ts'));
    assert.match(actions, /^\s*'use server';/);
    assert.equal((actions.match(/const session = await requireSession\(\);/g) ?? []).length, 2);
    assert.doesNotMatch(actions, /formData\.get\('(organizationId|userId|org|user)'\)/);
    const admin = code(read('crm/admin-actions.ts'));
    assert.match(admin, /const ended = await repositories\.iam\.disableMember\(session\.organizationId, userId, actor\);[\s\S]*?await finishGoogleOffboarding\(ended\.googleRevocation, actor\);/);
    assert.match(admin, /const ended = await repositories\.iam\.removeMember\(session\.organizationId, userId, actor\);[\s\S]*?await finishGoogleOffboarding\(ended\.googleRevocation, actor\);/);
  });
});

// --- The panel ------------------------------------------------------------------------------

const time = createTimeView(resolveDisplayTimeZone({ device: 'UTC' }), new Date('2026-09-17T12:00:00Z'));
function status(over: Partial<GoogleWorkspaceStatus> = {}, capabilities: Partial<Record<'gmail' | 'calendar' | 'drive', GoogleCapabilityState>> = {}): GoogleWorkspaceStatus {
  return {
    permitted: true,
    configured: true,
    canConnect: true,
    connection: null,
    capabilities: { gmail: 'NOT_CONNECTED', calendar: 'NOT_CONNECTED', drive: 'NOT_CONNECTED', ...capabilities },
    ...over,
  };
}
const live = {
  status: 'CONNECTED' as const,
  email: 'person@example.com',
  hostedDomain: 'example.com',
  connectedAt: new Date('2026-09-17T11:00:00Z'),
  lastUsedAt: null,
  expiredAt: null,
  revokedAt: null,
  revocationUnconfirmed: false,
};
const render = (props: Parameters<typeof GoogleWorkspacePanel>[0]) => renderToStaticMarkup(<GoogleWorkspacePanel {...props} />);
const row = (html: string, capability: string) => html.match(new RegExp(`<div role="listitem" class="loop-row" data-capability="${capability}"[\\s\\S]*?(?=<div role="listitem"|</div></section>)`))?.[0] ?? '';

describe('the panel', () => {
  it('onboarding: three separate approvals, each a plain link for one capability, and a way on without any', () => {
    const html = render({ mode: 'ONBOARDING', status: status(), outcome: null, reconnect: [], time });
    for (const [capability, label] of [['gmail', 'Gmail'], ['calendar', 'Calendar'], ['drive', 'Drive']]) {
      const r = row(html, capability!);
      assert.match(r, /data-state="NOT_CONNECTED"/);
      assert.match(r, /Not connected/);
      assert.ok(r.includes(`<a class="loop-btn loop-btn--primary" href="/api/integrations/google/connect?capability=${capability}&amp;return=onboarding" rel="nofollow">Connect ${label}</a>`), capability);
    }
    assert.match(html, /Never message bodies/);
    assert.match(html, /Never file contents/);
    assert.match(html, /<a class="loop-btn" href="\/app">Skip for now<\/a>/);
    assert.match(html, /Loop works without it/);
    assert.doesNotMatch(html, /Remove |Disconnect Google/, 'onboarding only adds');
    assert.doesNotMatch(html, /person@example\.com/);
  });

  it('onboarding: continue once everything is connected', () => {
    const html = render({ mode: 'ONBOARDING', status: status({ connection: live }, { gmail: 'CONNECTED', calendar: 'CONNECTED', drive: 'CONNECTED' }), outcome: 'CONNECTED', reconnect: [], time });
    assert.match(html, /<a class="loop-btn loop-btn--primary" href="\/app">Continue to Loop<\/a>/);
    assert.match(html, /data-google-outcome="CONNECTED"/);
    assert.match(html, /person@example\.com/);
    assert.match(html, /example\.com/);
    assert.doesNotMatch(html, /api\/integrations\/google\/connect/, 'nothing left to connect');
  });

  it('connections: every state is shown for what it is, with the act that fits it', () => {
    const html = render({
      mode: 'CONNECTIONS',
      status: status({ connection: { ...live, hostedDomain: null } }, { gmail: 'CONNECTED', calendar: 'EXPIRED', drive: 'INSUFFICIENT_SCOPE' }),
      outcome: 'PARTIAL',
      reconnect: [],
      time,
    });
    assert.match(row(html, 'gmail'), /Connected/);
    assert.match(row(html, 'gmail'), /<input type="hidden" name="capability" value="gmail"\/>/);
    assert.match(row(html, 'gmail'), /Remove Gmail/);
    assert.match(row(html, 'calendar'), /Expired — reconnect/);
    assert.match(row(html, 'calendar'), /href="\/api\/integrations\/google\/connect\?capability=calendar" rel="nofollow">Reconnect Calendar</);
    assert.match(row(html, 'drive'), /Access not allowed/);
    assert.match(row(html, 'drive'), />Allow Drive</);
    assert.match(html, /Personal Google account \(no Workspace domain\)/);
    assert.match(html, /Disconnect Google/);
    assert.match(html, /<input type="hidden" name="return" value="CONNECTIONS"\/>/);
    assert.match(html, /Some access was not allowed/);
  });

  it('after removing a capability, the kept ones are offered as one fresh approval', () => {
    const html = render({
      mode: 'CONNECTIONS',
      status: status({ connection: { ...live, status: 'REVOKED', revokedAt: new Date('2026-09-17T11:30:00Z') } }),
      outcome: 'DISCONNECTED',
      reconnect: ['calendar', 'drive'],
      time,
    });
    assert.match(html, /Approve the access you kept/);
    assert.match(html, /href="\/api\/integrations\/google\/connect\?capability=calendar%2Cdrive" rel="nofollow">Continue to Google</);
    assert.doesNotMatch(html, /person@example\.com/, 'a revoked account is not presented as connected');
    assert.doesNotMatch(html, /Disconnect Google/);
  });

  it('unconfigured or not permitted: honest blocks and nothing to click', () => {
    for (const [s, words] of [
      [status({ configured: false }), /Google connections are not available yet/],
      [status({ canConnect: false }), /You cannot connect Google here/],
    ] as const) {
      const html = render({ mode: 'ONBOARDING', status: s, outcome: null, reconnect: ['gmail'], time });
      assert.match(html, words);
      assert.doesNotMatch(html, /api\/integrations\/google\/connect/);
      assert.match(html, /Skip for now/, 'onboarding still continues');
    }
  });

  it('every outcome has plain words and none of them carries a secret or Google’s text', () => {
    for (const outcome of GOOGLE_CONNECT_OUTCOMES) {
      const message = GOOGLE_OUTCOME_MESSAGES[outcome];
      assert.ok(message.title && message.body, outcome);
      assert.doesNotMatch(`${message.title} ${message.body}`, /token|invalid_grant|access_denied|secret|googleapis/i, outcome);
      const html = render({ mode: 'CONNECTIONS', status: status(), outcome, reconnect: [], time });
      assert.match(html, new RegExp(`data-google-outcome="${outcome}"`));
    }
  });
});
