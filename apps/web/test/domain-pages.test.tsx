// Loop Intelligence Phase E: every domain page reads its own reading through the ONE section, the Mail
// pass route fails closed, and pages only read (never produce or enqueue).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INTELLIGENCE_DOMAIN_REGISTRY } from '@emgloop/shared';

const src = (...p: string[]) => readFileSync(join(__dirname, '..', 'src', ...p), 'utf8');

const PAGES: readonly [string[], string, string][] = [
  [['app', 'app', 'admin', 'marketplace', 'page.tsx'], 'OrganizationReadingSection', 'CALLGRID'],
  [['app', 'app', 'admin', 'marketplace', 'call-dimension-page.tsx'], 'OrganizationReadingSection', 'CAMPAIGNS'],
  [['app', 'crm', 'pipeline', 'page.tsx'], 'OrganizationReadingSection', 'PIPELINE'],
  [['app', 'app', 'crm', 'people', 'page.tsx'], 'OrganizationReadingSection', 'CRM'],
  [['app', 'app', 'admin', 'creator-hub', 'page.tsx'], 'OrganizationReadingSection', 'CREATORS'],
  [['app', 'app', 'admin', 'work', 'page.tsx'], 'OrganizationReadingSection', 'WORK'],
  [['app', 'crm', 'analytics', 'page.tsx'], 'OrganizationReadingSection', 'WEBSITE'],
  [['app', 'app', 'calendar', 'page.tsx'], 'PrincipalReadingSection', 'CALENDAR'],
];

test('each domain page renders its reading through the shared section, after its own guard', () => {
  for (const [path, component, domain] of PAGES) {
    const code = src(...path);
    assert.match(code, new RegExp(`<${component} domain="${domain}"`), path.join('/'));
    // The shared dimension renderer is guarded by the route that calls it (campaigns/page.tsx).
    const guarded = path.at(-1) === 'call-dimension-page.tsx' ? src('app', 'app', 'admin', 'marketplace', 'campaigns', 'page.tsx') : code;
    assert.ok(guarded.search(/require(Workspace|WorkspacePermission|Permission)\(|getSession\(\)/) >= 0, `${path.join('/')} guards itself`);
  }
});

test('every organization domain in the registry has a page that shows its reading', () => {
  const shown = new Set(PAGES.map(([, , d]) => d));
  for (const d of INTELLIGENCE_DOMAIN_REGISTRY) if (d.domain !== 'CHATS' && d.domain !== 'MAIL') assert.ok(shown.has(d.domain), d.domain);
});

test('the section reads through the scoped loaders only, and never produces or enqueues', () => {
  const code = src('intelligence', 'domain-reading-section.tsx');
  assert.match(code, /loadOrganizationReading\(session, domain/);
  assert.match(code, /loadPrincipalReading\(session, domain/);
  assert.doesNotMatch(code, /enqueue|runIntelligence|loopProducers|searchParams|organizationId:/);
});

test('the Mail pass route fails closed and takes no tenant from the request', () => {
  const code = src('app', 'api', 'internal', 'intelligence', 'mail', 'route.ts');
  assert.match(code, /if \(!expected \|\| !provided \|\| !secretMatches\(provided, expected\)\)/);
  assert.match(code, /timingSafeEqual/);
  assert.doesNotMatch(code, /request\.json\(|searchParams|formData/);
  assert.match(code, /MAIL_PRODUCERS\.has\(id\)/, 'only Mail producers are hosted here');
  assert.match(code, /LOOP_MAIL_CONTENT_GOVERNANCE_DECISION/);
});
