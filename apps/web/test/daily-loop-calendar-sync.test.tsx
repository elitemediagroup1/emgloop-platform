// The DL-3 manual trigger: whose calendar a sync can possibly be about.
//
// Source-level, in the style this app already uses for its security invariants
// (public-surface-security.test.tsx): the guarantee is about what the route CANNOT express,
// which is a property of the code rather than of one rendered response.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROUTE = readFileSync(fileURLToPath(new URL('../src/app/api/integrations/google/calendar/sync/route.ts', import.meta.url)), 'utf8');
const RUNTIME = readFileSync(fileURLToPath(new URL('../src/daily-loop/calendar-runtime.ts', import.meta.url)), 'utf8');
const code = (source: string) => source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('Calendar sync is the signed-in person’s own, and cannot be aimed at anybody else', () => {
  it('takes the organization and the user from the session, and reads no body, query or header that names a person', () => {
    const route = code(ROUTE);
    assert.match(route, /const session = await getSession\(\)/);
    assert.match(route, /organizationId: session\.organizationId, userId: session\.userId/);

    // Nothing in the request can name a principal: the route never parses one.
    for (const forbidden of ['request.json(', 'await request.text(', 'searchParams', 'formData', "headers.get('x-user", 'body.userId', 'params.userId']) {
      assert.equal(route.includes(forbidden), false, `${forbidden} must not influence whose calendar is read`);
    }
    // The only header it reads is the cross-site guard.
    const headerReads = [...route.matchAll(/headers\.get\('([^']+)'\)/g)].map((m) => m[1]);
    assert.deepEqual(headerReads, ['sec-fetch-site']);
  });

  it('refuses an unauthenticated request, a cross-site request, and a principal without the authority', () => {
    const route = code(ROUTE);
    assert.match(route, /if \(!session\) return json\(401/);
    assert.match(route, /sec-fetch-site'\) === 'cross-site'\) return json\(403/);
    assert.match(route, /resource: 'employeeIntelligence', action: 'update'/);
    assert.match(route, /if \(!permitted\) return json\(403/);
    // And there is no manage/approve anywhere near it.
    for (const forbidden of ["'manage'", "'approve'", 'googleWorkspace']) {
      assert.equal(route.includes(forbidden), false, forbidden);
    }
  });

  it('returns classes and counts, never Google’s text, an event title or a token', () => {
    const route = code(ROUTE);
    for (const forbidden of ['summary', 'title', 'accessToken', 'error.message', 'err.message', 'String(error', 'cause']) {
      assert.equal(route.includes(forbidden), false, forbidden);
    }
    assert.match(route, /catch \{/, 'a thrown cause never becomes a response');
    assert.match(route, /outcome: result\.outcome/);
  });

  it('the runtime reuses the one Google path and opens no second one', () => {
    const runtime = code(RUNTIME);
    assert.match(runtime, /googleWorkspace\(\)\.accessToken\(principal, 'calendar'\)/);
    // No second OAuth flow, token store, refresh implementation or Calendar adapter.
    for (const forbidden of ['GOOGLE_OAUTH_CLIENT', 'refreshToken', 'client_secret', 'oauth2.googleapis.com', 'new GoogleTokenSealer', 'calendar/v3']) {
      assert.equal(runtime.includes(forbidden), false, forbidden);
    }
    assert.match(runtime, /readGoogleCalendarWindow|readGoogleCalendarChanges/, 'the DL-2 sensor, not a new adapter');
    assert.match(runtime, /import 'server-only'/);
  });

  it('adds no employee-visible surface', () => {
    // DL-3 ingests; DL-4 renders. Nothing here is a page, a component or a navigation entry.
    const nav = readFileSync(fileURLToPath(new URL('../src/workspaces/config.ts', import.meta.url)), 'utf8');
    for (const absent of ['/app/day', '/app/today', 'Your Day', 'Tomorrow']) {
      assert.equal(nav.includes(absent), false, absent);
    }
    assert.equal(ROUTE.includes('.tsx'), false);
    assert.equal(RUNTIME.includes('React'), false);
  });
});
