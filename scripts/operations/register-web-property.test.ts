// Register Web Property: the operator acts on the authoritative EMG website-property registry. A dry run writes
// nothing; the whole portfolio can be registered without any property being LIVE; lifecycle and ingestion move only
// by their own explicit acts and never move a property's owner; a key owned elsewhere is refused, never moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMG_WEBSITE_PROPERTIES } from '@emgloop/database';

import { parseArgs, runRegisterWebProperty, type RunDeps } from './register-web-property';

type Row = { key: string; organizationId: string; primaryDomain: string; lifecycle: string; ingestion: string };

/** A registrar double with the repository's rules: identity is never moved; state changes are their own acts. */
function deps(seed: Row[] = [], status = 'ACTIVE') {
  const writes: string[] = [];
  const out: string[] = [];
  const rows = new Map<string, Row>(seed.map((r) => [r.key, { ...r }]));
  const d: RunDeps = {
    organizations: { findBySlug: async (slug) => (slug === 'acme' ? { id: 'org_acme', slug, status } : null) },
    portfolio: EMG_WEBSITE_PROPERTIES,
    now: () => new Date('2026-09-30T12:00:00Z'),
    properties: {
      async previewRegistration(organizationId, r) {
        const e = rows.get(r.key);
        if (e && e.organizationId !== organizationId) return { outcome: 'REFUSED', problems: ['KEY_REGISTERED_ELSEWHERE'] };
        if ([...rows.values()].some((x) => x.key !== r.key && x.primaryDomain === r.primaryDomain)) return { outcome: 'REFUSED', problems: ['PRIMARY_DOMAIN_REGISTERED_ELSEWHERE'] };
        return { outcome: e ? 'UNCHANGED' : 'REGISTERED', problems: [] };
      },
      async register(organizationId, r) {
        writes.push(`register:${r.key}`);
        const e = rows.get(r.key);
        if (e) return { outcome: 'UNCHANGED', property: e };
        const row = { key: r.key, organizationId, primaryDomain: r.primaryDomain, lifecycle: r.lifecycle ?? 'OWNED', ingestion: 'DISABLED' };
        rows.set(r.key, row);
        return { outcome: 'REGISTERED', property: row };
      },
      async transitionLifecycle(organizationId, key, to) {
        writes.push(`lifecycle:${key}:${to}`);
        const e = rows.get(key);
        if (!e || e.organizationId !== organizationId) return { outcome: 'REFUSED', code: 'PROPERTY_NOT_IN_ORGANIZATION' };
        e.lifecycle = to;
        if (to !== 'LIVE') e.ingestion = 'DISABLED';
        return { outcome: 'CHANGED', property: e };
      },
      async setIngestion(organizationId, key, to) {
        writes.push(`ingestion:${key}:${to}`);
        const e = rows.get(key);
        if (!e || e.organizationId !== organizationId) return { outcome: 'REFUSED', code: 'PROPERTY_NOT_IN_ORGANIZATION' };
        e.ingestion = to;
        return { outcome: 'CHANGED', property: e };
      },
      async findForOrganization(organizationId, key) {
        const e = rows.get(key);
        return e && e.organizationId === organizationId ? e : null;
      },
    },
    log: (l) => void out.push(l),
  };
  return { d, writes, out, rows };
}

const own = (key: string, lifecycle = 'OWNED', ingestion = 'DISABLED'): Row => ({ key, organizationId: 'org_acme', primaryDomain: `${key}.com`, lifecycle, ingestion });

test('the portfolio list is the 17 owned EMG domains, each key its domain', () => {
  assert.equal(EMG_WEBSITE_PROPERTIES.length, 17);
  for (const p of EMG_WEBSITE_PROPERTIES) assert.equal(`${p.key}.com`, p.domain);
  assert.equal(new Set(EMG_WEBSITE_PROPERTIES.map((p) => p.domain)).size, 17);
});

test('register-portfolio: a dry run writes nothing; the run registers every property OWNED with ingestion DISABLED', async () => {
  const dry = deps();
  assert.equal((await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--action', 'register-portfolio', '--dry-run']), dry.d)).outcome, 'WOULD_REGISTER_PORTFOLIO');
  assert.deepEqual(dry.writes, []);
  assert.ok(dry.out.some((l) => l.includes('properties=17 wouldRegister=17')));

  const run = deps();
  assert.equal((await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--action', 'register-portfolio']), run.d)).outcome, 'PORTFOLIO_REGISTERED');
  assert.equal(run.rows.size, 17);
  assert.ok([...run.rows.values()].every((r) => r.lifecycle === 'OWNED' && r.ingestion === 'DISABLED' && r.organizationId === 'org_acme'));
  assert.ok(run.out.some((l) => l.includes('registered=17') && l.includes('readBack=FOUND')));
  // Idempotent: a second run registers nothing new.
  const again = await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--action', 'register-portfolio']), run.d);
  assert.equal(again.outcome, 'PORTFOLIO_REGISTERED');
  assert.ok(run.out.some((l) => l.includes('registered=0') && l.includes('unchanged=17')));
});

test('register-portfolio refuses the whole batch when a property belongs to another organization -- nothing written', async () => {
  const { d, writes } = deps([{ ...own('servicesinmycity'), organizationId: 'org_other' }]);
  const r = await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--action', 'register-portfolio']), d);
  assert.equal(r.outcome, 'REFUSED');
  assert.ok(r.problems.includes('KEY_REGISTERED_ELSEWHERE'));
  assert.deepEqual(writes, []);
});

test('register one property: bindings are reported as counts, never values', async () => {
  const { d, out, rows } = deps();
  const r = await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--key', 'site-a', '--primary-domain', 'site-a.example', '--ga4-property-id', '123456']), d);
  assert.equal(r.outcome, 'REGISTERED');
  assert.equal(rows.get('site-a')!.lifecycle, 'OWNED');
  assert.ok(out.some((l) => l.includes('ga4Bound=true')));
  assert.doesNotMatch(out.join('\n'), /123456|site-a\.example/);
});

test('set-lifecycle and ingestion are separate acts; entering LIVE never enables ingestion; the owner never moves', async () => {
  const { d, rows, writes } = deps([own('siteb')]);
  assert.equal((await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--key', 'siteb', '--action', 'enable-ingestion']), d)).outcome, 'REFUSED', 'OWNED cannot ingest');
  assert.deepEqual(writes, []);
  assert.equal((await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--key', 'siteb', '--action', 'set-lifecycle', '--lifecycle', 'LIVE', '--dry-run']), d)).outcome, 'WOULD_CHANGE');
  assert.deepEqual(writes, []);
  assert.equal((await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--key', 'siteb', '--action', 'set-lifecycle', '--lifecycle', 'LIVE']), d)).outcome, 'CHANGED');
  assert.deepEqual([rows.get('siteb')!.lifecycle, rows.get('siteb')!.ingestion], ['LIVE', 'DISABLED']);
  assert.equal((await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--key', 'siteb', '--action', 'enable-ingestion']), d)).outcome, 'CHANGED');
  assert.equal(rows.get('siteb')!.ingestion, 'ENABLED');
  assert.equal((await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--key', 'siteb', '--action', 'set-lifecycle', '--lifecycle', 'OWNED']), d)).outcome, 'REFUSED', 'LIVE -> OWNED is not a transition');
  assert.equal((await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--key', 'siteb', '--action', 'set-lifecycle', '--lifecycle', 'PAUSED']), d)).outcome, 'CHANGED');
  assert.deepEqual([rows.get('siteb')!.lifecycle, rows.get('siteb')!.ingestion, rows.get('siteb')!.organizationId], ['PAUSED', 'DISABLED', 'org_acme']);
});

test("a state change names only this organization's property", async () => {
  const { d, writes } = deps([{ ...own('sitec'), organizationId: 'org_other' }]);
  const r = await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--key', 'sitec', '--action', 'set-lifecycle', '--lifecycle', 'BUILDING']), d);
  assert.equal(r.outcome, 'REFUSED');
  assert.deepEqual(r.problems, ['PROPERTY_NOT_IN_ORGANIZATION']);
  assert.deepEqual(writes, []);
});

test('preconditions: bad slug, unknown or inactive organization, bad action or lifecycle -- nothing written', async () => {
  const cases: [string[], string][] = [
    [['--organization', 'Acme!', '--key', 'k'], 'ACTIVE'],
    [['--organization', 'nobody', '--key', 'k', '--primary-domain', 'x.example'], 'ACTIVE'],
    [['--organization', 'acme', '--key', 'k', '--primary-domain', 'x.example'], 'SUSPENDED'],
    [['--organization', 'acme', '--key', 'k', '--action', 'delete'], 'ACTIVE'],
    [['--organization', 'acme', '--key', 'k', '--action', 'set-lifecycle', '--lifecycle', 'ACTIVE'], 'ACTIVE'],
  ];
  for (const [argv, status] of cases) {
    const { d, writes } = deps([], status);
    assert.equal((await runRegisterWebProperty(parseArgs(argv), d)).outcome, 'FAILED_PRECONDITION', argv.join(' '));
    assert.deepEqual(writes, []);
  }
});

test('the runner reaches no provider, no network, no ingestion and no credential; the workflow is dispatch-only, dry run by default', () => {
  const src = readFileSync(join(__dirname, 'register-web-property.ts'), 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(|googleapis|google-auth|IngestionService|Sealer|secretSealed|storeCredential|@aws-sdk/);
  const wf = readFileSync(join(__dirname, '..', '..', '.github', 'workflows', 'register-web-property.yml'), 'utf8');
  assert.match(wf, /workflow_dispatch:/);
  assert.doesNotMatch(wf, /^\s*(push|pull_request|schedule|workflow_call):/m);
  assert.match(wf, /dry_run:[\s\S]*?default: true\s+type: boolean/);
  for (const a of ['register-portfolio', 'set-lifecycle', 'enable-ingestion', 'disable-ingestion']) assert.match(wf, new RegExp(`- ${a}\\b`));
});
