// Register Web Property: the operator acts on the authoritative EMG website-property registry. A dry run writes
// nothing; the whole portfolio can be registered without any property being LIVE; lifecycle and ingestion move only
// by their own explicit acts and never move a property's owner; a key owned elsewhere is refused, never moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMG_WEBSITE_PROPERTIES } from '@emgloop/database';
import { webPropertyLiveCommission } from '@emgloop/shared';

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
      // The repository's rules: scoped to the organization, the shared plan, one entry per key, all or nothing.
      async previewLiveCommission(organizationId, keys) {
        const entries = keys.map((key) => {
          const e = rows.get(key);
          if (!e || e.organizationId !== organizationId) return { key, before: null, result: 'REFUSED' as const, code: 'PROPERTY_NOT_IN_ORGANIZATION' };
          const before = { lifecycle: e.lifecycle, ingestion: e.ingestion };
          const plan = webPropertyLiveCommission(e);
          if (!plan.ok) return { key, before, result: 'REFUSED' as const, code: plan.code };
          if (!plan.lifecycleChange && !plan.ingestionChange) return { key, before, result: 'UNCHANGED' as const };
          return { key, before, result: 'WOULD_COMMISSION' as const, plan: plan.lifecycleChange ? 'LIFECYCLE_AND_INGESTION' as const : 'INGESTION_ONLY' as const };
        });
        return { outcome: entries.some((e) => e.result === 'REFUSED') ? 'REFUSED' as const : 'PLANNED' as const, entries };
      },
      async commissionLive(organizationId, keys) {
        const planned = await d.properties.previewLiveCommission(organizationId, keys);
        if (planned.outcome !== 'PLANNED') return planned;
        for (const entry of planned.entries) {
          if (entry.result !== 'WOULD_COMMISSION') continue;
          writes.push(`commission:${entry.key}`);
          const e = rows.get(entry.key)!;
          e.lifecycle = 'LIVE';
          e.ingestion = 'ENABLED';
        }
        return { outcome: 'COMMISSIONED' as const, entries: planned.entries };
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
  for (const a of ['register-portfolio', 'set-lifecycle', 'enable-ingestion', 'disable-ingestion', 'commission-live-sites']) assert.match(wf, new RegExp(`- ${a}\\b`));
  assert.match(wf, /property_keys:/);
  assert.match(wf, /--property-keys "\$\{PROPERTY_KEYS\}"/);
});

// --- commission-live-sites ----------------------------------------------------------------------------------

const commission = (keys: string, dry = false) => parseArgs(['--organization', 'acme', '--action', 'commission-live-sites', '--property-keys', keys, ...(dry ? ['--dry-run'] : [])]);
const FIVE = ['consumersupporthelp', 'marriageinmycity', 'careinmycity', 'petsinmycity', 'gamedayinmycity'];
const fiveRows = () => FIVE.map((k) => own(k));

test('commission-live-sites: three properties of one organization commission together; ownership unchanged; read back', async () => {
  const { d, rows, out, writes } = deps([own('a1'), own('a2'), own('a3')]);
  const r = await runRegisterWebProperty(commission('a1,a2,a3'), d);
  assert.deepEqual(r, { outcome: 'COMMISSIONED', problems: [] });
  assert.deepEqual(writes, ['commission:a1', 'commission:a2', 'commission:a3']);
  for (const k of ['a1', 'a2', 'a3']) assert.deepEqual([rows.get(k)!.lifecycle, rows.get(k)!.ingestion, rows.get(k)!.organizationId], ['LIVE', 'ENABLED', 'org_acme']);
  assert.ok(out.includes('event=COMMISSION_PREFLIGHT property=a1 result=WOULD_COMMISSION before=OWNED/DISABLED after=LIVE/ENABLED'));
  assert.ok(out.includes('event=COMMISSION_READBACK property=a1 result=COMMISSIONED after=LIVE/ENABLED ownerUnchanged=true'));
  assert.ok(out.includes('event=COMMISSION_BATCH_RESULT requested=3 commissioned=3 unchanged=0 refused=0 readbackFailed=0 ownerChanges=0 ownerUnchanged=true dryRun=false'));
});

test('commission-live-sites: mixed starting states -- OWNED and BUILDING commission, LIVE+DISABLED gets ingestion, LIVE+ENABLED is UNCHANGED and not rewritten', async () => {
  const { d, rows, out, writes } = deps([own('m-owned'), own('m-building', 'BUILDING'), own('m-livedis', 'LIVE', 'DISABLED'), own('m-liveon', 'LIVE', 'ENABLED')]);
  const r = await runRegisterWebProperty(commission('m-owned,m-building,m-livedis,m-liveon'), d);
  assert.equal(r.outcome, 'COMMISSIONED');
  assert.deepEqual(writes, ['commission:m-owned', 'commission:m-building', 'commission:m-livedis'], 'the already-commissioned property is not written');
  assert.ok([...rows.values()].every((row) => row.lifecycle === 'LIVE' && row.ingestion === 'ENABLED'));
  assert.ok(out.includes('event=COMMISSION_PREFLIGHT property=m-building result=WOULD_COMMISSION before=BUILDING/DISABLED after=LIVE/ENABLED'));
  assert.ok(out.includes('event=COMMISSION_PREFLIGHT property=m-livedis result=WOULD_COMMISSION before=LIVE/DISABLED after=LIVE/ENABLED'));
  assert.ok(out.includes('event=COMMISSION_PREFLIGHT property=m-liveon result=UNCHANGED before=LIVE/ENABLED after=LIVE/ENABLED'));
  assert.ok(out.includes('event=COMMISSION_READBACK property=m-liveon result=UNCHANGED after=LIVE/ENABLED ownerUnchanged=true'));
  assert.ok(out.includes('event=COMMISSION_BATCH_RESULT requested=4 commissioned=3 unchanged=1 refused=0 readbackFailed=0 ownerChanges=0 ownerUnchanged=true dryRun=false'));
});

test('commission-live-sites: the same batch twice -- the second run writes nothing and reports every property UNCHANGED', async () => {
  const { d, rows, out, writes } = deps(fiveRows());
  assert.equal((await runRegisterWebProperty(commission(FIVE.join(',')), d)).outcome, 'COMMISSIONED');
  const firstWrites = writes.length;
  out.length = 0;
  assert.equal((await runRegisterWebProperty(commission(FIVE.join(',')), d)).outcome, 'COMMISSIONED');
  assert.equal(writes.length, firstWrites, 'zero writes on the re-run');
  assert.ok(out.includes('event=COMMISSION_BATCH_RESULT requested=5 commissioned=0 unchanged=5 refused=0 readbackFailed=0 ownerChanges=0 ownerUnchanged=true dryRun=false'));
  assert.ok([...rows.values()].every((row) => row.organizationId === 'org_acme'));
});

test('commission-live-sites: five valid + one property of ANOTHER organization -> ZERO properties changed', async () => {
  const { d, rows, out, writes } = deps([...fiveRows(), { ...own('foodinmycity'), organizationId: 'org_other' }]);
  const r = await runRegisterWebProperty(commission(`${FIVE.join(',')},foodinmycity`), d);
  assert.equal(r.outcome, 'REFUSED');
  assert.deepEqual(r.problems, ['foodinmycity:PROPERTY_NOT_IN_ORGANIZATION']);
  assert.deepEqual(writes, []);
  assert.ok(FIVE.every((k) => rows.get(k)!.lifecycle === 'OWNED' && rows.get(k)!.ingestion === 'DISABLED'));
  assert.equal(rows.get('foodinmycity')!.organizationId, 'org_other');
  assert.ok(out.includes('event=COMMISSION_PREFLIGHT property=foodinmycity result=REFUSED:PROPERTY_NOT_IN_ORGANIZATION before=- after=-'));
  assert.ok(out.includes('event=COMMISSION_PREFLIGHT property=careinmycity result=WOULD_COMMISSION before=OWNED/DISABLED after=LIVE/ENABLED'), 'the whole batch is reported');
  assert.ok(out.includes('event=COMMISSION_BATCH_RESULT requested=6 eligible=5 unchanged=0 refused=1 written=0 dryRun=false'));
});

test('commission-live-sites: five valid + one UNKNOWN key -> ZERO properties changed', async () => {
  const { d, rows, writes } = deps(fiveRows());
  const r = await runRegisterWebProperty(commission(`${FIVE.join(',')},nosuchsite`), d);
  assert.equal(r.outcome, 'REFUSED');
  assert.deepEqual(r.problems, ['nosuchsite:PROPERTY_NOT_IN_ORGANIZATION']);
  assert.deepEqual(writes, []);
  assert.ok(FIVE.every((k) => rows.get(k)!.lifecycle === 'OWNED'));
});

test('commission-live-sites: a property that cannot legally become LIVE (RETIRED) -> ZERO properties changed', async () => {
  const { d, rows, writes, out } = deps([...fiveRows(), own('spasinmycity', 'RETIRED')]);
  const r = await runRegisterWebProperty(commission(`${FIVE.join(',')},spasinmycity`), d);
  assert.equal(r.outcome, 'REFUSED');
  assert.deepEqual(r.problems, ['spasinmycity:LIFECYCLE_TRANSITION_REFUSED']);
  assert.deepEqual(writes, []);
  assert.equal(rows.get('spasinmycity')!.lifecycle, 'RETIRED', 'no intermediate lifecycle is invented to force it through');
  assert.ok(out.includes('event=COMMISSION_PREFLIGHT property=spasinmycity result=REFUSED:LIFECYCLE_TRANSITION_REFUSED before=RETIRED/DISABLED after=-'));
});

test('commission-live-sites: dry run completes the preflight, reports every property, writes nothing', async () => {
  const { d, writes, out, rows } = deps([...fiveRows(), own('servicesinmycity', 'LIVE', 'ENABLED')]);
  const r = await runRegisterWebProperty(commission(`servicesinmycity,${FIVE.join(',')}`, true), d);
  assert.equal(r.outcome, 'WOULD_COMMISSION');
  assert.deepEqual(writes, []);
  assert.ok(FIVE.every((k) => rows.get(k)!.lifecycle === 'OWNED'));
  assert.ok(out.includes('event=COMMISSION_PREFLIGHT property=servicesinmycity result=UNCHANGED before=LIVE/ENABLED after=LIVE/ENABLED'));
  assert.ok(out.includes('event=COMMISSION_BATCH_RESULT requested=6 eligible=5 unchanged=1 refused=0 written=0 dryRun=true'));
});

test('commission-live-sites: a write that returns success is not trusted -- a failed read-back is READBACK_FAILED and exits non-zero', async () => {
  const { d, out } = deps(fiveRows());
  // A repository that claims success without the rows reflecting it.
  d.properties.commissionLive = async (organizationId, keys) => {
    const planned = await d.properties.previewLiveCommission(organizationId, keys);
    return { outcome: 'COMMISSIONED', entries: planned.entries };
  };
  const r = await runRegisterWebProperty(commission(FIVE.join(',')), d);
  assert.deepEqual(r, { outcome: 'COMMISSIONED', problems: ['READBACK_FAILED'] });
  assert.ok(out.includes('event=COMMISSION_READBACK property=careinmycity result=READBACK_FAILED after=OWNED/DISABLED ownerUnchanged=true'));
  assert.ok(out.includes('event=COMMISSION_BATCH_RESULT requested=5 commissioned=0 unchanged=0 refused=0 readbackFailed=5 ownerChanges=0 ownerUnchanged=true dryRun=false'));
});

test('commission-live-sites: a read-back finding a different owner is READBACK_FAILED and counted as an owner change', async () => {
  const { d, out, rows } = deps(fiveRows());
  d.properties.commissionLive = async (organizationId, keys) => {
    const planned = await d.properties.previewLiveCommission(organizationId, keys);
    for (const k of keys) Object.assign(rows.get(k)!, { lifecycle: 'LIVE', ingestion: 'ENABLED' });
    rows.get('careinmycity')!.organizationId = 'org_other';
    return { outcome: 'COMMISSIONED', entries: planned.entries };
  };
  const r = await runRegisterWebProperty(commission(FIVE.join(',')), d);
  assert.deepEqual(r.problems, ['READBACK_FAILED']);
  assert.ok(out.includes('event=COMMISSION_READBACK property=careinmycity result=READBACK_FAILED after=- ownerUnchanged=false'));
  assert.ok(out.some((l) => l.startsWith('event=COMMISSION_BATCH_RESULT') && l.includes('ownerChanges=1 ownerUnchanged=false')));
});

test('commission-live-sites: malformed, duplicate, empty or oversized input is refused before any lookup, never echoing bad text', async () => {
  for (const [keys, codeExpected] of [['', null], ['careinmycity,,petsinmycity', 'EMPTY_KEY'], ['careinmycity,Care In My City', 'KEY_SHAPE'], ['careinmycity, careinmycity', 'DUPLICATE_KEY'], [Array.from({ length: 26 }, (_, i) => `s${i}`).join(','), 'TOO_MANY_KEYS']] as const) {
    const { d, writes, out } = deps(fiveRows());
    let looked = false;
    const preview = d.properties.previewLiveCommission;
    d.properties.previewLiveCommission = async (o, k) => ((looked = true), preview(o, k));
    const r = await runRegisterWebProperty(commission(keys), d);
    assert.equal(r.outcome, 'FAILED_PRECONDITION', keys);
    assert.equal(looked, false, 'refused before any database lookup');
    assert.deepEqual(writes, []);
    if (codeExpected) assert.ok(out.some((l) => l.startsWith('event=INPUT_REFUSED') && l.includes(`code=${codeExpected}`)), keys);
    assert.doesNotMatch(out.join('\n'), /Care In My City/);
  }
  const single = deps(fiveRows());
  assert.equal((await runRegisterWebProperty(parseArgs(['--organization', 'acme', '--action', 'commission-live-sites', '--key', 'careinmycity', '--property-keys', 'careinmycity']), single.d)).outcome, 'FAILED_PRECONDITION', '--key is not a batch input');
  assert.deepEqual(single.writes, []);
});
