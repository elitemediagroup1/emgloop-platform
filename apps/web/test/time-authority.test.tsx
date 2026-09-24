// Loop Time Authority in the web app (docs/architecture/loop-time-authority.md).
//
// The defect it ends: server-rendered dates used the server's clock (UTC in
// production), so at 8:37 PM Eastern a record showed "Sep 15" beside "8m ago".
// Now every human-facing date resolves the reader's device zone through one
// authority, and nothing that authorizes or stamps a record can read that zone.
//
// Behavioural for the pure pieces (cookie contract, sync decisions, command
// center week, timeline render); source-level for the rules that must hold across
// the whole app (no server-clock formatting, zone never reaches authority).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTimeView, resolveDisplayTimeZone } from '@emgloop/shared';
import {
  TIME_ZONE_COOKIE, decodeTimeZoneCookie, readTimeZoneCookie, shouldSyncTimeZone, timeZoneCookie,
} from '../src/time/time-zone-cookie';
import { viewerTime } from '../src/time/viewer-time';
import { loadCommandCenter, type CommandCenterRepos } from '../src/crm/command-center-data';
import { Timestamp } from '../src/crm/timeline';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
});
const US_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];
const BOUNDARY = '2026-09-15T00:37:00Z';

describe('The browser reports its zone; the server renders in it', () => {
  it('writes only a validated IANA zone, scoped to the whole app, and never marks it httpOnly-sensitive', () => {
    assert.equal(
      timeZoneCookie('America/New_York', true),
      `${TIME_ZONE_COOKIE}=America%2FNew_York; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    );
    assert.equal(timeZoneCookie('America/Los_Angeles', false), `${TIME_ZONE_COOKIE}=America%2FLos_Angeles; Path=/; Max-Age=31536000; SameSite=Lax`);
    for (const bad of ['', '+05:00', 'UTC+5', 'America/New_York; Domain=evil.example', 'Not/AZone', undefined]) {
      assert.equal(timeZoneCookie(bad, true), null, String(bad));
    }
  });

  it('reads the zone back from a cookie header, and ignores anything malformed or forged', () => {
    assert.equal(readTimeZoneCookie(`emgloop_session=abc; ${TIME_ZONE_COOKIE}=America%2FChicago; other=1`), 'America/Chicago');
    assert.equal(readTimeZoneCookie('emgloop_session=abc'), null);
    assert.equal(decodeTimeZoneCookie('%E0%A4%A'), null, 'broken percent-encoding');
    assert.equal(decodeTimeZoneCookie('America%2FNew_York%3B%20Path%3D%2F'), null, 'smuggled attributes');
    assert.equal(decodeTimeZoneCookie('%2B05%3A00'), null, 'a raw offset');
    assert.equal(decodeTimeZoneCookie(undefined), null);
  });

  it('each US zone resolves as the device zone, and the same record shows each reader their own local date', () => {
    const expected: Record<string, string> = {
      'America/New_York': 'Sep 14, 2026, 8:37 PM',
      'America/Chicago': 'Sep 14, 2026, 7:37 PM',
      'America/Denver': 'Sep 14, 2026, 6:37 PM',
      'America/Los_Angeles': 'Sep 14, 2026, 5:37 PM',
    };
    const now = new Date('2026-09-15T00:45:00Z');
    for (const zone of US_ZONES) {
      const resolved = resolveDisplayTimeZone({ device: decodeTimeZoneCookie(encodeURIComponent(zone)) });
      assert.deepEqual(resolved, { timeZone: zone, source: 'device' });
      const view = createTimeView(resolved, now);
      assert.equal(view.dateTime(BOUNDARY), expected[zone], zone);
      assert.equal(view.relative(BOUNDARY), '8m ago', zone);
      assert.equal(view.iso(BOUNDARY), '2026-09-15T00:37:00.000Z', `${zone}: the instant itself is unchanged`);
    }
  });

  it('with no zone recorded, or an invalid one, it renders UTC and says so', () => {
    for (const raw of [undefined, '', 'garbage', '%2B05%3A00']) {
      const view = createTimeView(resolveDisplayTimeZone({ device: decodeTimeZoneCookie(raw) }), new Date('2026-09-15T00:45:00Z'));
      assert.equal(view.source, 'fallback');
      assert.equal(view.dateTime(BOUNDARY), 'Sep 15, 2026, 12:37 AM UTC', String(raw));
    }
  });

  it('syncs on first visit and after travel, never twice for the same zone, and never over a preference', () => {
    assert.equal(shouldSyncTimeZone('America/New_York', { timeZone: 'UTC', source: 'fallback' }), true, 'first visit');
    assert.equal(shouldSyncTimeZone('America/New_York', { timeZone: 'America/New_York', source: 'device' }), false, 'already right');
    assert.equal(shouldSyncTimeZone('America/Los_Angeles', { timeZone: 'America/New_York', source: 'device' }), true, 'travelled west');
    assert.equal(shouldSyncTimeZone('America/Los_Angeles', { timeZone: 'America/Chicago', source: 'preference' }), false, 'a preference wins');
    assert.equal(shouldSyncTimeZone('+05:00', { timeZone: 'UTC', source: 'fallback' }), false, 'an unusable report changes nothing');
    assert.equal(shouldSyncTimeZone(undefined, { timeZone: 'UTC', source: 'fallback' }), false);
  });

  it('the client leaf asks nothing but the zone the browser already knows, and cannot loop', () => {
    const sync = code(read('time/TimeZoneSync.tsx'));
    assert.match(read('time/TimeZoneSync.tsx'), /^'use client';/);
    assert.match(sync, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
    assert.equal(/geolocation|navigator\.permissions|getCurrentPosition/.test(sync), false, 'no location permission');
    assert.match(sync, /if \(refresh && stored && refreshedFor\.current !== stored\) \{/);
    assert.equal(/fetch\(|setInterval|Date\.now\(\)|new Date\(/.test(sync), false, 'no clock, no polling, no writes to the server');
  });

  it('is mounted once in the one Loop shell, so /app and /crm share the reader\'s zone', () => {
    const shell = code(read('workspaces/WorkspaceShell.tsx'));
    assert.match(shell, /const time = viewerTime\(\);/);
    assert.match(shell, /<TimeZoneSync timeZone=\{time\.timeZone\} source=\{time\.source\} \/>/);
    assert.match(code(read('app/crm/login/page.tsx')), /<TimeZoneSync timeZone="UTC" source="fallback" refresh=\{false\} \/>/);
    const mounts = walk(SRC).filter((f) => /<TimeZoneSync\b/.test(code(readFileSync(f, 'utf8'))));
    assert.deepEqual(mounts.map((f) => relative(SRC, f)).sort(), ['app/crm/login/page.tsx', 'workspaces/WorkspaceShell.tsx']);
  });
});

describe('The zone is presentation, never authority', () => {
  it('nothing that authorizes, scopes a tenant, handles a write or ingests an event reads it', () => {
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8');
      const reads = /time\/viewer-time|time-zone-cookie|loop_tz/.test(src);
      if (!reads) continue;
      const rel = relative(SRC, file);
      const forbidden =
        /^'use server'/.test(src.trimStart()) ||
        rel.startsWith('app/api/') ||
        rel === 'middleware.ts' ||
        /^auth\//.test(rel) ||
        /workspaces\/(guard|nav-access|role-router)\.ts$/.test(rel) ||
        /(actions|crm-data)\.ts$/.test(rel);
      assert.equal(forbidden, false, `${rel} must not read the display timezone`);
    }
  });

  it('records are stamped by the server or database clock, whatever zone the reader is in', () => {
    const database = walk(fileURLToPath(new URL('../../../packages/database/src', import.meta.url)));
    for (const file of database) {
      assert.equal(/loop_tz|viewerTime|resolveDisplayTimeZone/.test(readFileSync(file, 'utf8')), false, relative(SRC, file));
    }
    const audit = readFileSync(fileURLToPath(new URL('../../../packages/database/src/repositories/audit.repository.ts', import.meta.url)), 'utf8');
    const create = audit.slice(audit.indexOf('this.prisma.auditLog.create'), audit.indexOf('});', audit.indexOf('this.prisma.auditLog.create')));
    assert.equal(/createdAt/.test(create), false, 'audit entries take the database clock');
  });

  it('the viewer resolves outside a request to the labelled UTC fallback, with the server clock as now', () => {
    const before = Date.now();
    const view = viewerTime();
    assert.equal(view.source, 'fallback');
    assert.equal(view.timeZone, 'UTC');
    assert.ok(view.now.getTime() >= before && view.now.getTime() <= Date.now() + 5, 'now is the server clock');
  });
});

describe('Surfaces present time through the authority', () => {
  it('no human-facing date is formatted, or a day bucketed, on the server clock anywhere in the app', () => {
    const ALLOWED = new Set([
      // CallGrid reconciliation API: provider windows, explicitly labelled Eastern/UTC in its JSON.
      'app/api/integrations/callgrid/reconcile/route.ts',
      // Detects the browser's zone -- the one legitimate read of the device clock's zone.
      'time/TimeZoneSync.tsx',
    ]);
    // A bare `.toLocaleString()` formats numbers too, so only date-shaped receivers count there.
    const DATE_FORMAT = /toLocaleDateString\(|toLocaleTimeString\(|(?:Date\([^()]*\)|\b\w*(?:At|Date|date|Time|iso|Iso|ts|when)\)?)\.toLocaleString\(\s*\)|toLocaleString\((?:undefined|'en-US'|"en-US"),\s*\{[^}]*(?:month|day|hour|minute|weekday|year)|\.getHours\(\)|\.setHours\(|\.getDate\(\)|\.setDate\(|new Intl\.DateTimeFormat\(/;
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (ALLOWED.has(rel)) continue;
      if (DATE_FORMAT.test(code(readFileSync(file, 'utf8')))) offenders.push(rel);
    }
    assert.deepEqual(offenders, []);
  });

  it('no surface hard-codes Eastern as a display zone', () => {
    const offenders = walk(SRC)
      .filter((f) => /America\/New_York/.test(code(readFileSync(f, 'utf8'))))
      .map((f) => relative(SRC, f));
    assert.deepEqual(offenders, ['app/api/integrations/callgrid/reconcile/route.ts']);
  });

  it('every surface from the verified defect now reads the reader\'s time', () => {
    const surfaces = [
      'app/crm/customers/page.tsx', 'app/crm/customers/[id]/page.tsx', 'crm/timeline.tsx',
      'app/crm/customers/[id]/activity/page.tsx', 'app/crm/inbox/page.tsx', 'app/crm/audit/page.tsx',
      'app/crm/page.tsx', 'app/crm/conversations/[id]/page.tsx', 'app/crm/conversations/page.tsx',
      'app/crm/workflows/[id]/page.tsx', 'app/crm/workflows/page.tsx', 'app/crm/organizations/[id]/page.tsx',
      'app/crm/intelligence/page.tsx', 'crm/integration-os.ts',
      'app/crm/settings/integrations/callgrid/page.tsx', 'app/crm/pipeline/page.tsx',
      'app/crm/live/calls/page.tsx', 'app/crm/live/activity/page.tsx', 'app/crm/live/websites/page.tsx',
      'app/app/admin/workspace-home-data.ts', 'app/app/_home/admin-home.tsx', 'app/app/admin/brain/page.tsx',
      'app/app/admin/headlines/page.tsx', 'app/app/admin/queue/page.tsx', 'app/app/admin/work/page.tsx',
      'app/app/admin/work/[id]/page.tsx', 'app/app/admin/work/work-data.ts', 'app/app/employee/work/work-data.ts',
      'app/app/admin/_decisions/decision-ui.tsx', 'app/app/admin/marketplace/dimension-ui.tsx',
      'app/app/admin/administration/team/page.tsx',
    ];
    for (const s of surfaces) assert.match(read(s), /viewerTime/, s);
    // The live feed is a client component: it formats with the shared authority and
    // the zone the server resolved, not the browser's own locale defaults.
    const feed = code(read('app/crm/live/LiveFeed.tsx'));
    assert.match(feed, /formatInstant\(|relativeTime as sharedRelativeTime/);
    assert.match(feed, /timeZone: string;\s*timeZoneSource: TimeZoneSource;/);
  });

  it('calendar dates and reporting windows keep the calendar that owns them', () => {
    const objectives = code(read('app/app/admin/administration/objectives/page.tsx'));
    assert.match(objectives, /return formatCalendarDate\(iso\) \|\| '—';/, 'effective dates are the same day for everyone');
    assert.match(objectives, /formatInstant\(startIso, BUSINESS_TIME_ZONE, 'date'\)/, 'measurement windows are CallGrid reporting days');
    assert.match(code(read('app/app/admin/headlines/headline-ui.tsx')), /formatInstant\(iso, BUSINESS_TIME_ZONE, 'monthDay'\)/);
    // Home's CallGrid figures come from the Command Center's own context, whose window is CallGrid's
    // Eastern reporting calendar by construction; the scorecard that once computed its own day
    // boundaries on Home is gone, and nothing under _home does day arithmetic on the server clock.
    assert.match(code(read('app/app/_home/front-door-data.ts')), /loadCommandContextFor\(organizationId, undefined,/, 'Home reads CallGrid through the command context');
    assert.equal(existsSync(join(SRC, 'app/app/admin/dashboard-data.ts')), false, 'the today-so-far vs yesterday-complete scorecard is retired');
    for (const file of ['app/app/_home/kpis.ts', 'app/app/_home/tiles.ts', 'app/app/_home/front-door-data.ts']) {
      assert.equal(/easternYesterdayWindow|easternTodayWindow|toLocaleDateString|getHours\(/.test(code(read(file))), false, file);
    }
  });

  it('the retired server-clock helpers are gone', () => {
    const format = code(read('app/app/_loop-os/format.ts'));
    assert.equal(/export function (greeting|todayLabel|relTime)\b/.test(format), false);
    assert.equal(/orgClock|org\?\.timezone/.test(code(read('app/crm/page.tsx'))), false);
  });
});

describe('Command Center "this week" is counted where the reader is', () => {
  function repos() {
    const calls: { name: string; args: unknown[] }[] = [];
    const rec = (name: string, value: unknown) => async (...args: unknown[]) => { calls.push({ name, args }); return value; };
    const r = {
      organizations: { findById: rec('organizations.findById', { id: 'org', name: 'Org' }) },
      customers: { countByOrganization: rec('customers.countByOrganization', 0) },
      crm: {
        statusCounts: rec('crm.statusCounts', {}),
        windowCounts: rec('crm.windowCounts', { newCustomers: 0, conversations: 0 }),
        inboxFeed: rec('crm.inboxFeed', []),
      },
      conversationsInbox: { listConversations: rec('conversationsInbox.listConversations', { rows: [], total: 0, counts: {} }) },
      audit: { list: rec('audit.list', []) },
    } as unknown as CommandCenterRepos;
    return { r, calls };
  }

  it('from the start of the reader\'s calendar day seven days ago, until now', async () => {
    const now = new Date(BOUNDARY);
    const expected: Record<string, string> = {
      UTC: '2026-09-08T00:00:00.000Z',
      'America/New_York': '2026-09-07T04:00:00.000Z',
      'America/Los_Angeles': '2026-09-07T07:00:00.000Z',
    };
    for (const [timeZone, start] of Object.entries(expected)) {
      const { r, calls } = repos();
      await loadCommandCenter(r, 'org', { canViewAudit: false }, { now, timeZone });
      const window = calls.find((c) => c.name === 'crm.windowCounts')!;
      assert.equal((window.args[1] as Date).toISOString(), start, timeZone);
      assert.equal(window.args[2], now);
    }
  });
});

describe('Rendered timestamps', () => {
  it('the timeline keeps the canonical instant machine-readable and names the zone of the exact time', () => {
    const html = renderToStaticMarkup(<Timestamp iso={BOUNDARY} />);
    assert.match(html, /<time class="tl-time" dateTime="2026-09-15T00:37:00.000Z" title="Sep 15, 2026, 12:37:00 AM UTC">/);
  });
});
