// Guards that stood on the retired Home panels' tests and belong to Home itself, not to a panel
// (restored 2026-09-24 when the panels were replaced by the briefing): the first 14-day Gmail read
// can never be started from a page; a guard's redirect is never swallowed as "a source failed"; the
// calendar read model and its action take nothing from the request and call no model.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const SRC = fileURLToPath(new URL('../src', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (['node_modules', '.next', 'dist'].includes(f)) return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });

describe('Home reads mail only through the read model', () => {
  it('neither Home nor Mail can perform the first 14-day read: every Gmail sync a page can start has FRESHNESS reach', () => {
    const files = walk(SRC);
    const syncCalls = files.flatMap((f) => [...code(readFileSync(f, 'utf8')).matchAll(/\.syncGmail\(([^)]*)\)/g)].map((m) => ({ f, args: m[1]! })));
    assert.ok(syncCalls.length >= 1, 'the web tier still reads mail');
    for (const { f, args } of syncCalls) assert.match(args, /reach: 'FRESHNESS'/, `${f} must not start a first read`);
    // One assembly of the sync in the web tier, and Home and Mail reach it only through the read model.
    const assemblers = files.filter((f) => /createEmployeeGmailSync\(/.test(code(readFileSync(f, 'utf8'))));
    assert.deepEqual(assemblers.map((f) => f.slice(f.indexOf('/src/'))), ['/src/daily-loop/mail-runtime.ts']);
    for (const page of ['../src/app/app/page.tsx', '../src/app/app/mail/page.tsx']) {
      const text = code(read(page));
      assert.equal(/mail-runtime|syncGmail|createEmployeeGmailSync/.test(text), false, `${page} reads mail only through loadMailDashboard`);
      assert.match(text, /loadMailDashboard\(principal/);
    }
    // Refresh is offered only where it can do something: a stored position to read changes from.
    assert.match(code(read('../src/app/app/mail/page.tsx')), /\{mail\.canRefresh \? <RefreshMail \/> : null\}/);
  });
});

describe('a source that cannot be read never takes Home down, and a guard is never mistaken for a source', () => {
  it('a redirect or not-found thrown by a guard is never swallowed as “a source failed”', async () => {
    const { settle } = await import('../src/app/app/_home/settle');
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/crm/login;307;' });
    await assert.rejects(settle(async () => { throw redirect; }), (e) => e === redirect);
    assert.deepEqual(await settle(async () => { throw new Error('P2021 table does not exist'); }), { ok: false });
    assert.deepEqual(await settle(async () => 7), { ok: true, value: 7 });
  });
});

describe('the calendar read model and its action are the viewer’s own and call no model', () => {
  it('takes no userId from anywhere but the session, and calls no model', () => {
    const readModel = read('../src/daily-loop/your-day.ts');
    const page = read('../src/app/app/page.tsx');
    const action = read('../src/daily-loop/actions.ts');
    for (const forbidden of ['searchParams', 'params.userId', 'request.json', 'formData', 'headers.get(']) {
      assert.equal(readModel.includes(forbidden), false, `read model: ${forbidden}`);
      assert.equal(action.includes(forbidden), false, `action: ${forbidden}`);
    }
    assert.match(page, /organizationId: session\.organizationId, userId: session\.userId/);
    assert.match(action, /requirePermission\('employeeIntelligence', 'update'\)/);
    assert.match(action, /organizationId: session\.organizationId, userId: session\.userId/);
    for (const forbidden of ['anthropic', 'openai', 'AiRuntimeGateway', 'gmail', 'drive', 'googleapis.com']) {
      assert.equal(readModel.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
    }
  });

  it('reads only the reader’s day: the tomorrow preview went with the panel that drew it', () => {
    const readModel = code(read('../src/daily-loop/your-day.ts'));
    assert.equal(/tomorrow/i.test(readModel), false);
    assert.match(readModel, /toInstant: today\.endsAt,/);
  });
});
