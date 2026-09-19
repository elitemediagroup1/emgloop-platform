// What wakes intelligence up in the web tier: never a page render as the only trigger.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

describe('the scheduled CallGrid detection route', () => {
  const route = code(read('../src/app/api/internal/intelligence/callgrid/route.ts'));

  it('fails closed: no configured secret and a wrong secret are the same 401, before anything is read', () => {
    assert.match(route, /if \(!expected \|\| !provided \|\| !secretMatches\(provided, expected\)\) \{\s*return NextResponse\.json\(\{ ok: false, error: 'unauthorized' \}, \{ status: 401 \}\);/);
    assert.ok(route.indexOf('secretMatches(provided, expected)') < route.indexOf('organizationIdsWithCallsSince'), 'authenticated before the database is asked anything');
    assert.match(route, /timingSafeEqual/);
  });

  it('takes no organization from the request: the database says which organizations have calls', () => {
    for (const input of ['searchParams', 'request.json', 'request.formData', 'request.url', 'nextUrl']) {
      assert.equal(route.includes(input), false, `${input} must not be read`);
    }
    assert.match(route, /repositories\.marketplaceCalls\.organizationIdsWithCallsSince\(/);
  });

  it('runs the page’s own pipeline with no viewer and no authority to act', () => {
    assert.match(route, /loadCommandContextFor\(organizationId, \{ period: 'daily' \}, \{ session: null, canAct: async \(\) => false \}\)/);
    assert.match(route, /loadExecutiveAnalysis\(ctx\)/);
    for (const act of ['assign', 'resolve', 'ignore', 'send', 'Draft']) assert.equal(new RegExp(`\\b${act}\\(`).test(route), false, `${act} is not a detection`);
  });

  it('reports organization ids and counts only, and one organization failing never stops the next', () => {
    assert.match(route, /passes\.push\(\{ organizationId, result: 'FAILED', situations: 0 \}\)/);
    assert.equal(/title|buyer|summary|whatHappened/.test(route.slice(route.indexOf('return NextResponse.json({ ok: true'))), false);
  });
});

describe('the page and the system build the same CallGrid context', () => {
  const data = code(read('../src/app/app/admin/marketplace/command-data.ts'));
  it('the page delegates to the one loader, with the viewer’s own permission', () => {
    assert.match(data, /return loadCommandContextFor\(session\.organizationId, searchParams, \{ session, canAct: \(\) => hasPermission\('intelligence', 'update'\) \}\);/);
    assert.match(data, /viewer\.canAct\(\)/);
  });
});

describe('the scheduled workflow', () => {
  const yml = read('../../../.github/workflows/detect-callgrid-intelligence.yml');
  it('is off until switched on, holds its secret in a header, and takes no input', () => {
    assert.match(yml, /if \[ "\$\{ENABLED:-\}" != "true" \]; then/);
    assert.match(yml, /--header "x-emg-detect-secret: \$\{DETECT_SECRET\}"/);
    assert.equal(/inputs:/.test(yml), false, 'nothing a person types can name a tenant');
    assert.equal(/\$\{\{ secrets\.[A-Z_]+ \}\}[^\n]*run:/.test(yml), false);
  });
});

describe('mail detection: one assembly for the page and the cycle', () => {
  it('the web tier reads the facts through the shared assembly, never its own', () => {
    const web = code(read('../src/daily-loop/mail-attention.ts'));
    assert.match(web, /mailThreadFacts\(new WorkGraphRepository\(prisma\), principal, limit\)/);
    assert.equal(/graph\.threads\(/.test(web), false);
  });
});
