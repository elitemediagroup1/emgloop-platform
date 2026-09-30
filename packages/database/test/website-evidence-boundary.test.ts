// The website evidence foundation's boundary (2026-09-30), read from source: no external HTTP call, no vendor SDK,
// no new AI task, one website producer (website.domain@2), and no hard-coded tenancy or property count on the
// ingress path. Test numbers refer to the foundation PR's required list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AI_TASKS, INTELLIGENCE_SOURCE_REGISTRY } from '@emgloop/shared';

import { INTELLIGENCE_PRODUCER_CATALOG } from '../src/services/intelligence-fabric/catalog';

const ROOT = join(__dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Every module this foundation added or rewrote on the evidence path. */
const FOUNDATION_FILES = [
  'packages/shared/src/website-evidence.ts',
  'packages/providers/src/adapters/website.provider.ts',
  'packages/providers/src/interfaces/analytics.provider.ts',
  'packages/database/src/repositories/web-property.repository.ts',
  'packages/database/src/repositories/organization-connection.repository.ts',
  'packages/database/src/repositories/source-metric-window.repository.ts',
  'packages/database/src/repositories/website-analytics.repository.ts',
  'packages/database/src/repositories/website-telemetry-retention.repository.ts',
  'packages/database/src/repositories/intelligence/website-evidence-state.repository.ts',
  'packages/database/src/services/website/website-ingress.ts',
  'packages/database/src/services/connections/organization-credential-sealer.ts',
  'packages/database/src/services/intelligence-fabric/website-coverage.ts',
  'apps/connections-worker/src/website-retention.ts',
  'apps/web/src/app/api/webhooks/website/route.ts',
  'scripts/operations/register-web-property.ts',
];

test('23: no external HTTP/API call and no vendor SDK is introduced on the website evidence path', () => {
  for (const f of FOUNDATION_FILES) {
    const src = read(f);
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|from ['"](node:)?https?['"]|require\(['"]https?['"]\)|axios|undici/, `${f} makes no network call`);
    assert.doesNotMatch(src, /from ['"](googleapis|google-auth-library|@google-analytics\/[^'"]*|@googleapis\/[^'"]*|@aws-sdk\/[^'"]*)['"]/, `${f} imports no provider SDK`);
    assert.doesNotMatch(src, /https:\/\/(analyticsdata|searchconsole|www\.googleapis|oauth2\.googleapis|sts\.googleapis|ssl\.bing|www\.bing|www\.clarity)/, `${f} names no provider endpoint`);
  }
});

test('24: no additional AI task -- the website reading keeps its one existing task, and no source has its own', () => {
  assert.equal(AI_TASKS.length, 18);
  const ids = AI_TASKS.map((t) => t.taskId);
  assert.equal(ids.filter((id) => id.startsWith('website.')).length, 1);
  assert.ok(ids.includes('website.domain.reading'));
  assert.equal(ids.some((id) => /ga4|analytics|search_console|searchconsole|bing|clarity|webmaster/i.test(id)), false);
});

test('the catalog carries exactly one website producer, website.domain@2, and no reading names an external website source', () => {
  const website = INTELLIGENCE_PRODUCER_CATALOG.filter((p) => p.domain === 'WEBSITE');
  assert.deepEqual(website.map((p) => p.id), ['website.domain@2']);
  const records = read('packages/database/src/services/intelligence-fabric/domains/records.ts');
  for (const s of INTELLIGENCE_SOURCE_REGISTRY.filter((x) => x.basis === 'ORGANIZATION_CONNECTION')) {
    assert.equal(records.includes(`'${s.sourceId}'`), false, `no producer reads ${s.sourceId}`);
  }
});

test('the website ingress resolves no tenancy from a constant: no LIVE_ORG_SLUG, no catalog property list, no fixed count', () => {
  const route = read('apps/web/src/app/api/webhooks/website/route.ts');
  assert.doesNotMatch(route, /LIVE_ORG_SLUG|ensureLiveOrganization|servicesinmycity-demo/);
  assert.doesNotMatch(route, /EMG_WEBSITE_PROPERTIES|propertyIngestKey|propertyAllowedDomains/);
  assert.match(route, /admitWebsiteDelivery/);
  for (const f of ['apps/web/src/app/api/webhooks/website/route.ts', 'packages/database/src/services/website/website-ingress.ts', 'packages/database/src/repositories/web-property.repository.ts']) {
    assert.doesNotMatch(read(f), /\b7\b/, `${f} hard-codes no property count`);
  }
  const migration = read('packages/database/prisma/migrations/20261009000000_website_evidence_foundation/migration.sql');
  assert.doesNotMatch(migration, /INSERT\s+INTO/i, 'the migration registers no property');
  assert.doesNotMatch(migration, /^\s*(DROP|DELETE|UPDATE|TRUNCATE)\b/im, 'the migration is additive');
});
