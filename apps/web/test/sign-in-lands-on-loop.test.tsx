// Sign-in lands on Loop — PR 1 of the unified application structure
// (docs/architecture/loop-application-structure.md).
//
// Behavioural where the code runs without a request: the landing authority, the
// role router, the workspace registry, the edge middleware. Source-level where
// the subject is a server action or page that needs a session.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NextRequest } from 'next/server';
import {
  AUTH_SCREENS, LOGIN_PATH, LOOP_HOME, loginPathFor, postLoginDestination, safeNextPath,
} from '../src/auth/landing';
import { WORKSPACES, WORKSPACE_ROLES } from '../src/workspaces/config';
import { resolveWorkspaceRole } from '../src/workspaces/role-router';
import { runWorkspaceRoutingVerification } from '../src/workspaces/verification';
import { middleware } from '../src/middleware';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

// ---------------------------------------------------------------------------

describe('Requested destinations', () => {
  it('safe deep links into the application survive, normalised', () => {
    const cases: [string, string][] = [
      ['/app', '/app'],
      ['/app/admin/work/abc123?tab=steps#s2', '/app/admin/work/abc123?tab=steps#s2'],
      ['/crm', '/crm'],
      ['/crm/customers/c_1?tab=Notes', '/crm/customers/c_1?tab=Notes'],
      ['  /app/admin/headlines  ', '/app/admin/headlines'],
      ['/app/./admin/../admin/queue', '/app/admin/queue'],
    ];
    for (const [raw, expected] of cases) assert.equal(safeNextPath(raw), expected, raw);
  });

  it('open-redirect and malformed values are refused', () => {
    const hostile: unknown[] = [
      undefined, null, 42, {}, '', '   ', 'app', 'app/admin',
      'https://evil.example/app', 'http://app.emgloop.com/app', 'javascript:alert(1)', 'data:text/html,x',
      '//evil.example', '//evil.example/app', '///evil.example', '/\\evil.example', '/app\\..\\evil',
      '/%2F%2Fevil.example', '/%5C%5Cevil.example', '/%2f%2fevil.example/app',
      '/app\n//evil.example', '/app\t/x', '/app /x', '/app\u0000x',
      '/%E0%A4%A', '/app/' + 'x'.repeat(3000),
      '/app/../api/v1/events', '/app/../../etc/passwd', '/api/health', '/demo/timeline', '/status', '/login', '/',
      '/appx', '/crmevil', '/application',
    ];
    for (const raw of hostile) assert.equal(safeNextPath(raw), null, JSON.stringify(raw));
  });

  it('an encoded slash inside an application path stays on this origin', () => {
    const out = safeNextPath('/app/%2F%2Fevil.example');
    assert.ok(out && out.startsWith('/app/'));
    assert.equal(new URL(out!, 'https://app.emgloop.com').origin, 'https://app.emgloop.com');
  });

  it('an authentication screen is never a destination, so sign-in cannot loop', () => {
    for (const screen of AUTH_SCREENS) {
      for (const raw of [screen, `${screen}?next=/crm`, `${screen}/extra`]) {
        assert.equal(safeNextPath(raw), null, raw);
        assert.equal(postLoginDestination(raw), LOOP_HOME, raw);
      }
    }
  });

  it('a normal sign-in, or any unsafe request, goes to Loop Home', () => {
    assert.equal(postLoginDestination(undefined), '/app');
    assert.equal(postLoginDestination(''), '/app');
    assert.equal(postLoginDestination('https://evil.example'), '/app');
    assert.equal(postLoginDestination('/crm/customers/c_1'), '/crm/customers/c_1');
  });

  it('the login path carries only a safe destination, alongside other messages', () => {
    assert.equal(loginPathFor(undefined), LOGIN_PATH);
    assert.equal(loginPathFor('//evil.example'), LOGIN_PATH);
    assert.equal(loginPathFor('/crm/customers/c_1?tab=Notes'), '/crm/login?next=%2Fcrm%2Fcustomers%2Fc_1%3Ftab%3DNotes');
    const withError = new URL(loginPathFor('/app/admin/queue', { error: 'Invalid email or password' }), 'https://x.test');
    assert.equal(withError.searchParams.get('error'), 'Invalid email or password');
    assert.equal(withError.searchParams.get('next'), '/app/admin/queue');
    assert.equal(new URL(loginPathFor('https://evil.example', { error: 'x' }), 'https://x.test').searchParams.has('next'), false);
  });
});

describe('Every sign-in path uses the landing authority', () => {
  it('the login action sends a successful sign-in to Loop Home or the safe requested page', () => {
    const actions = code(read('auth/actions.ts'));
    const login = actions.slice(actions.indexOf('export async function loginAction'), actions.indexOf('export async function logoutAction'));
    assert.match(login, /const requestedNext = formData\.get\('next'\);/);
    assert.match(login, /redirect\(postLoginDestination\(requestedNext\)\);/);
    assert.match(login, /redirect\(loginPathFor\(requestedNext, \{ error:/, 'a failed attempt keeps the destination');
    assert.equal(/redirect\('\/crm'\)/.test(login), false);
  });

  it('an already signed-in visit to login goes to Loop Home or the safe requested page', () => {
    const page = code(read('app/crm/login/page.tsx'));
    assert.match(page, /if \(session\) redirect\(postLoginDestination\(searchParams\.next\)\);/);
    assert.match(page, /const next = safeNextPath\(searchParams\.next\);/);
    assert.match(page, /\{next \? <input type="hidden" name="next" value=\{next\} \/> : null\}/);
  });

  it('the root sends a signed-in visitor to Loop Home and keeps a safe destination for sign-in', () => {
    const root = code(read('app/page.tsx'));
    assert.match(root, /redirect\(session \? LOOP_HOME : loginPathFor\(searchParams\?\.next\)\);/);
  });

  it('session guards go straight to login with the page actually requested, never via the root', () => {
    assert.match(code(read('auth/guard.ts')), /redirect\(loginPathFor\(requestedPath\(\) \?\? returnTo\)\);/);
    const ws = code(read('workspaces/guard.ts'));
    assert.match(ws, /redirect\(loginPathFor\(requestedPath\(\) \?\? returnTo\)\);/);
    assert.equal(/redirect\('\/' \+/.test(ws), false);
    const helper = code(read('auth/request-path.ts'));
    assert.match(helper, /h\.get\('x-pathname'\)/);
    assert.match(helper, /h\.get\('x-search'\)/);
  });

  it('the middleware forwards the requested path and query to server guards', () => {
    for (const url of ['https://app.emgloop.com/app/admin/work/w1?tab=steps', 'https://app.emgloop.com/crm/login?next=%2Fapp']) {
      const res = middleware(new NextRequest(url));
      const u = new URL(url);
      assert.equal(res.headers.get('x-middleware-request-x-pathname'), u.pathname, url);
      assert.equal(res.headers.get('x-middleware-request-x-search'), u.search, url);
    }
  });

  it('the edge keeps the query string of a requested deep link', () => {
    const res = middleware(new NextRequest('https://app.emgloop.com/crm/customers/c_1?tab=Notes'));
    const location = new URL(res.headers.get('location')!);
    assert.equal(location.pathname, '/crm/login');
    assert.equal(location.searchParams.get('next'), '/crm/customers/c_1?tab=Notes');
    assert.equal(safeNextPath(location.searchParams.get('next')), '/crm/customers/c_1?tab=Notes');
  });

  it('no source still lands a person on the CRM, and the dead second login is gone', () => {
    assert.equal(existsSync(join(SRC, 'workspaces/login-action.ts')), false);
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
    for (const file of walk(SRC)) {
      const c = code(readFileSync(file, 'utf8'));
      assert.equal(/(redirect|router\.push)\(\s*'\/crm'\s*\)/.test(c), false, file);
      assert.equal(/redirect\(resolveHomeRoute/.test(c), false, file);
    }
  });
});

describe('/app renders Loop Home for every role', () => {
  const app = code(read('app/app/page.tsx'));

  it('renders inside the shell instead of redirecting by role', () => {
    assert.match(app, /<WorkspaceShell session=\{session\}>/);
    assert.equal(/resolveHomeRoute/.test(app), false);
    assert.equal((app.match(/redirect\(/g) ?? []).length, 1, 'the only redirect is for a missing session');
    assert.match(app, /if \(!session\) redirect\(loginPathFor\(LOOP_HOME\)\);/);
  });

  it('the Owner/Admin/Manager home renders only for that authority and enforces it itself', () => {
    assert.match(app, /\{role === 'ADMIN' \? <AdminHome \/> : <ModuleHome name=\{session\.name\} groups=\{await navFor\(session\)\} \/>\}/);
    const home = code(read('app/app/_home/admin-home.tsx'));
    const body = home.slice(home.indexOf('export async function AdminHome'));
    assert.ok(body.indexOf("await requireWorkspace('ADMIN');") > -1);
    assert.ok(body.indexOf("await requireWorkspace('ADMIN');") < body.indexOf('loadDashboard('), 'authority before any read');
  });

  it('roles resolve as before: nothing is broadened', () => {
    const expected: Record<string, string> = {
      OWNER: 'ADMIN', ADMIN: 'ADMIN', MANAGER: 'ADMIN',
      EMPLOYEE: 'EMPLOYEE', AI_EMPLOYEE: 'EMPLOYEE', READ_ONLY: 'CLIENT', SOMETHING_NEW: 'CLIENT',
    };
    for (const [systemRole, workspace] of Object.entries(expected)) {
      assert.equal(resolveWorkspaceRole({ systemRole }), workspace, systemRole);
    }
  });

  it('every workspace home is Loop Home, and the routing invariants hold', () => {
    for (const role of WORKSPACE_ROLES) assert.equal(WORKSPACES[role].home, LOOP_HOME, role);
    const report = runWorkspaceRoutingVerification();
    assert.equal(report.passed, true, report.checks.filter((c) => !c.passed).map((c) => c.name).join('; '));
  });

  it('former role home URLs lead to Loop Home while their layouts keep guarding the tree', () => {
    for (const [dir, role] of [['admin', 'ADMIN'], ['employee', 'EMPLOYEE'], ['client', 'CLIENT'], ['business', 'BUSINESS_OWNER'], ['creator', 'CREATOR']]) {
      assert.match(code(read(`app/app/${dir}/page.tsx`)), /redirect\(LOOP_HOME\);/, dir);
      assert.match(code(read(`app/app/${dir}/layout.tsx`)), new RegExp(`requireWorkspace\\('${role}'\\)`), `${dir} layout still guards`);
    }
    assert.match(code(read('app/dashboard/page.tsx')), /redirect\('\/app'\);/);
    assert.match(code(read('app/crm/setup/page.tsx')), /redirect\('\/app'\);/);
    assert.match(code(read('app/crm/setup/SetupWizard.tsx')), /router\.push\('\/app'\);/);
  });
});

describe('Unauthorized destinations fail safely', () => {
  it('a destination in another workspace sends the person to Loop Home, which renders', () => {
    const guard = code(read('workspaces/guard.ts'));
    assert.match(guard, /if \(actual !== role\) \{\s*redirect\(WORKSPACES\[actual\]\.home\);/);
    for (const role of WORKSPACE_ROLES) assert.equal(WORKSPACES[role].home, '/app');
  });

  it('a denied permission lands on a screen that needs no permission and leads back to Loop Home', () => {
    assert.match(code(read('auth/guard.ts')), /redirect\('\/crm\/unauthorized\?resource=/);
    const page = code(read('app/crm/unauthorized/page.tsx'));
    assert.equal(/requirePermission|requireWorkspace|requireCrmContext/.test(page), false);
    assert.match(page, /href="\/app">Back to Loop Home</);
    assert.ok(read('middleware.ts').includes("'/crm/unauthorized'"), 'public at the edge');
    assert.ok(AUTH_SCREENS.includes('/crm/unauthorized'), 'never a sign-in destination');
  });
});

describe('No redirect loops', () => {
  // The redirects PR 1 owns, as the source above pins them. RENDER is terminal.
  type Session = 'signed-in' | 'signed-out';
  const next = (url: string, s: Session, workspace: string): string => {
    const { pathname, searchParams } = new URL(url, 'https://app.emgloop.com');
    if (pathname === '/') return s === 'signed-in' ? LOOP_HOME : loginPathFor(searchParams.get('next'));
    if (pathname === LOGIN_PATH) return s === 'signed-in' ? postLoginDestination(searchParams.get('next')) : 'RENDER';
    if (pathname === '/app') return s === 'signed-in' ? 'RENDER' : loginPathFor(LOOP_HOME);
    if (pathname === '/dashboard') return LOOP_HOME;
    const roleHome = ['/app/admin', '/app/employee', '/app/client', '/app/business', '/app/creator'].find((h) => h === pathname);
    if (roleHome) {
      if (s === 'signed-out') return loginPathFor(pathname);
      const owner = { '/app/admin': 'ADMIN', '/app/employee': 'EMPLOYEE', '/app/client': 'CLIENT', '/app/business': 'BUSINESS_OWNER', '/app/creator': 'CREATOR' }[roleHome];
      return owner === workspace ? LOOP_HOME : WORKSPACES[workspace as keyof typeof WORKSPACES].home;
    }
    return 'RENDER';
  };

  it('every entry point settles within two redirects for every role, signed in or out', () => {
    const entries = ['/', '/?next=/crm/customers/c_1', LOGIN_PATH, `${LOGIN_PATH}?next=/app/admin/work`, `${LOGIN_PATH}?next=//evil.example`, `${LOGIN_PATH}?next=/crm/login`, '/app', '/dashboard', '/app/admin', '/app/employee', '/app/client', '/app/business', '/app/creator'];
    for (const workspace of WORKSPACE_ROLES) {
      for (const s of ['signed-in', 'signed-out'] as const) {
        for (const entry of entries) {
          const seen = new Set<string>();
          let url = entry;
          let redirects = 0;
          while (url !== 'RENDER') {
            assert.equal(seen.has(url), false, `${workspace} ${s}: loop at ${url} from ${entry}`);
            seen.add(url);
            url = next(url, s, workspace);
            if (url !== 'RENDER') redirects += 1;
            assert.ok(redirects <= 2, `${workspace} ${s}: ${entry} took more than two redirects`);
          }
        }
      }
    }
  });
});
