// Register Web Property: the operator act that binds a property to ONE organization. A dry run writes nothing,
// a key owned elsewhere is refused and never moved, and the runner can reach no provider and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseArgs, runRegisterWebProperty, type RunDeps } from './register-web-property';

function deps(opts: { owner?: string | null; status?: string } = {}) {
  const writes: string[] = [];
  const out: string[] = [];
  const stored = new Map<string, { org: string; key: string; status: string }>();
  if (opts.owner) stored.set('site-a', { org: opts.owner, key: 'site-a', status: 'ACTIVE' });
  const d: RunDeps = {
    organizations: { findBySlug: async (slug) => (slug === 'acme' ? { id: 'org_acme', slug, status: opts.status ?? 'ACTIVE' } : null) },
    properties: {
      async previewRegistration(organizationId, r) {
        const e = stored.get(r.key);
        if (r.allowedDomains.length === 0) return { outcome: 'REFUSED', problems: ['NO_ALLOWED_DOMAINS'] };
        if (e && e.org !== organizationId) return { outcome: 'REFUSED', problems: ['KEY_REGISTERED_ELSEWHERE'] };
        return { outcome: e ? 'UNCHANGED' : 'REGISTERED', problems: [] };
      },
      async register(organizationId, r) {
        writes.push(`register:${r.key}`);
        stored.set(r.key, { org: organizationId, key: r.key, status: 'ACTIVE' });
        return { outcome: 'REGISTERED', property: { key: r.key, status: 'ACTIVE' } };
      },
      async setStatus(organizationId, key, status) {
        writes.push(`status:${key}:${status}`);
        const e = stored.get(key);
        if (!e || e.org !== organizationId) return null;
        e.status = status;
        return { key, status };
      },
      async findForOrganization(organizationId, key) {
        const e = stored.get(key);
        return e && e.org === organizationId ? { key, status: e.status } : null;
      },
    },
    log: (l) => void out.push(l),
  };
  return { d, writes, out };
}

const args = (extra: string[] = []) => parseArgs(['--organization', 'acme', '--key', 'site-a', '--domain', 'site-a.example', '--domain', 'www.site-a.example', '--ga4-property-id', '123456', ...extra]);

test('parseArgs reads every flag, repeatable domains, and --dry-run', () => {
  const r = args(['--dry-run']);
  assert.deepEqual(r.domains, ['site-a.example', 'www.site-a.example']);
  assert.equal(r.ga4PropertyId, '123456');
  assert.equal(r.dryRun, true);
  assert.equal(r.action, 'register');
});

test('a dry run validates and writes nothing', async () => {
  const { d, writes, out } = deps();
  const r = await runRegisterWebProperty(args(['--dry-run']), d);
  assert.equal(r.outcome, 'WOULD_REGISTER');
  assert.deepEqual(writes, []);
  assert.ok(out.some((l) => l.includes('event=DRY_RUN_COMPLETE written=false wouldBe=WOULD_REGISTER')));
  assert.ok(out.some((l) => l.includes('ga4Bound=true')));
  assert.doesNotMatch(out.join('\n'), /123456|site-a\.example/, 'bindings are reported as counts, never values');
});

test('a register writes once and reads back', async () => {
  const { d, writes, out } = deps();
  const r = await runRegisterWebProperty(args(), d);
  assert.equal(r.outcome, 'REGISTERED');
  assert.deepEqual(writes, ['register:site-a']);
  assert.ok(out.some((l) => l.includes('event=REGISTRATION_RESULT result=REGISTERED written=true readBack=FOUND status=ACTIVE')));
});

test('a key registered to another organization is refused and never written', async () => {
  const { d, writes } = deps({ owner: 'org_other' });
  const r = await runRegisterWebProperty(args(), d);
  assert.equal(r.outcome, 'REFUSED');
  assert.deepEqual(r.problems, ['KEY_REGISTERED_ELSEWHERE']);
  assert.deepEqual(writes, []);
});

test('disable names only this organization\'s property; a dry run does not call the write', async () => {
  const mine = deps({ owner: 'org_acme' });
  assert.equal((await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--key', 'site-a', '--action', 'disable', '--dry-run']), mine.d)).outcome, 'WOULD_DISABLE');
  assert.deepEqual(mine.writes, []);
  assert.equal((await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--key', 'site-a', '--action', 'disable']), mine.d)).outcome, 'DISABLED');
  const theirs = deps({ owner: 'org_other' });
  const r = await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--key', 'site-a', '--action', 'disable']), theirs.d);
  assert.equal(r.outcome, 'REFUSED');
  assert.deepEqual(theirs.writes, []);
});

test('preconditions: bad slug, unknown or inactive organization, bad action -- nothing written', async () => {
  for (const [req, opts] of [
    [parseArgs(['--organization', 'Acme!', '--key', 'k']), {}],
    [parseArgs(['--organization', 'nobody', '--key', 'k', '--domain', 'x.example']), {}],
    [parseArgs(['--organization', 'acme', '--key', 'k', '--domain', 'x.example']), { status: 'SUSPENDED' }],
    [parseArgs(['--organization', 'acme', '--key', 'k', '--action', 'delete']), {}],
  ] as const) {
    const { d, writes } = deps(opts);
    assert.equal((await runRegisterWebProperty(req, d)).outcome, 'FAILED_PRECONDITION');
    assert.deepEqual(writes, []);
  }
});

test('the runner reaches no provider, no network, no ingestion and no credential', () => {
  const src = readFileSync(join(__dirname, 'register-web-property.ts'), 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(|googleapis|google-auth|IngestionService|Sealer|secretSealed|storeCredential|@aws-sdk/);
  const wf = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'register-web-property.yml'), 'utf8');
  assert.match(wf, /workflow_dispatch:/);
  assert.doesNotMatch(wf, /^\s*(push|pull_request|schedule|workflow_call):/m);
  assert.match(wf, /default: true\s+type: boolean/, 'dry run is the default');
});
