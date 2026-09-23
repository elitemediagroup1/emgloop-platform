// The creator seat's pages (Creator Hub, 2026-09-22): the honest states, the Content Record's
// fixed region order, the earnings rule, the seeded label, and the source-level invariants every
// page in a role-guarded tree must keep. The pure bodies render from fixtures with a fixed
// TimeView; no session and no database are needed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { createTimeView } from '@emgloop/shared';
import type { ContentNotice, ContentRecordView, EarningsView, LibraryItem } from '@emgloop/database';

import { CreatorNoticePanel } from '../src/app/app/creator/_parts/notice-panel';
import { LibraryEmpty, LibraryGrid } from '../src/app/app/creator/_parts/library';
import { ContentRecordBody, historyEntries, type RecordHrefs } from '../src/app/app/creator/_parts/content-record-body';
import { EarningsBody } from '../src/app/app/creator/_parts/earnings-body';
import { AudienceChart } from '../src/app/app/creator/_parts/audience-chart';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const CREATOR = join(SRC, 'app', 'app', 'creator');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const render = (el: React.ReactElement) => renderToStaticMarkup(el);

const time = createTimeView({ timeZone: 'America/New_York', source: 'device' }, new Date('2026-09-23T16:00:00Z'));

// ---- fixtures -----------------------------------------------------------------------------------

const CREATOR_USER = 'u_denise';
const you = { userId: CREATOR_USER, name: 'Denise' };
const sam = { userId: 'u_sam', name: 'Sam' };

const original: ContentRecordView['versions'][number] = {
  id: 'v0', number: 0, label: 'Original', kind: 'ORIGINAL', contentType: 'video/mp4', fileName: 'kona.mp4', uploadState: 'READY', byteSize: 52_000_000, durationSeconds: 47, width: 1080, height: 1920,
  storageKey: 'media/o/p/c/v0.mp4', uploadedBy: you, uploadedByKind: 'CREATOR', createdAt: '2026-09-21T14:14:00Z', readyAt: '2026-09-21T14:15:00Z', producedByWorkInstanceId: null, answersInstructionId: null,
  noteToCreator: null, internalNote: null, visibleToCreator: true, approvals: [], publications: [],
};
const editV1: ContentRecordView['versions'][number] = {
  ...original, id: 'v1', number: 1, label: 'Edit v1', kind: 'EDIT', fileName: 'kona-v1.mp4', durationSeconds: 41, storageKey: 'media/o/p/c/v1.mp4', uploadedBy: sam, uploadedByKind: 'EMG',
  createdAt: '2026-09-22T20:00:00Z', readyAt: '2026-09-22T20:02:00Z', producedByWorkInstanceId: 'w1', answersInstructionId: 'i1', noteToCreator: 'Cut the logo intro; Kona at 0:04. Kept your 0:11 beat.',
};

const production1: ContentRecordView['productions'][number] = {
  id: 'prod1', number: 1, kind: 'EDIT', workInstanceId: 'w1', workStatus: 'active', sourceVersionId: 'v0', requestedBy: you, requestedReturnAt: '2026-09-23T19:00:00Z', expectedReturnAt: '2026-09-23T16:00:00Z', expectedReturnSetBy: { userId: 'u_priya', name: 'Priya' }, expectedReturnSetAt: '2026-09-21T19:40:00Z',
  createdAt: '2026-09-21T19:10:00Z', completedAt: null,
  currentStep: { id: 's2', position: 2, name: 'Creator review', kind: 'REVIEW', round: 1, status: 'ready', owner: you, startedAt: '2026-09-22T20:02:00Z', completedAt: null, completedBy: null, note: null },
  steps: [
    { id: 's1', position: 1, name: 'Edit', kind: 'EDIT', round: 1, status: 'completed', owner: sam, startedAt: '2026-09-21T20:20:00Z', completedAt: '2026-09-22T20:02:00Z', completedBy: sam, note: 'Cut the logo intro; Kona at 0:04. Kept your 0:11 beat.' },
    { id: 's2', position: 2, name: 'Creator review', kind: 'REVIEW', round: 1, status: 'ready', owner: you, startedAt: '2026-09-22T20:02:00Z', completedAt: null, completedBy: null, note: null },
  ],
  instructions: [{ id: 'i1', sequence: 1, originatorKind: 'CREATOR', originatorLabel: null, enteredBy: you, refersToVersionId: 'v0', refersToVersionLabel: 'Original', summary: 'Tighten the opening; Kona in the first 5 s.', notes: [], requestedReturnAt: '2026-09-23T19:00:00Z', answeredByVersionId: 'v1', answeredByVersionLabel: 'Edit v1', answeredAt: '2026-09-22T20:02:00Z', addressed: [], createdAt: '2026-09-21T19:10:00Z' }],
  comments: [],
};

const review: ContentRecordView = {
  seat: 'CREATOR', id: 'c1', title: 'Kona unboxing reel', kind: 'VIDEO', creator: { profileId: 'p1', partyId: 'party1', displayName: 'Denise R.', userId: CREATOR_USER },
  state: 'YOUR_REVIEW', stateLabel: 'Ready for your review', createdAt: '2026-09-21T14:14:00Z',
  versions: [original, editV1], latestVersion: editV1,
  productions: [production1],
  activeProduction: production1,
  requirements: [
    { key: 'creator', label: 'Your approval', required: true },
    { key: 'emg', label: 'EMG approval', required: true },
    { key: 'brand', label: "Kona's approval", required: true },
    { key: 'published', label: 'Published', required: true },
  ],
  requirementStatuses: [
    { key: 'creator', label: 'Your approval', required: true, met: false, by: null, versionLabel: null, at: null },
    { key: 'emg', label: 'EMG approval', required: true, met: false, by: null, versionLabel: null, at: null },
    { key: 'brand', label: "Kona's approval", required: true, met: false, by: null, versionLabel: null, at: null },
    { key: 'published', label: 'Published', required: true, met: false, by: null, versionLabel: null, at: null },
  ],
  judgedVersion: editV1,
  context: {
    campaign: { id: 'camp1', name: 'Kona Product Video', state: 'ACTIVE', brandLabel: 'Kona' },
    deliverable: { id: 'd1', title: 'Reel 1 of 2', dueAt: '2026-09-25T16:00:00Z', status: 'OPEN', line: 'awaiting your approval', complete: false, acceptsUnedited: false },
    opportunity: { id: 'opp1', title: 'Kona', creatorVisibleState: 'CONFIRMED', label: 'Confirmed' },
  },
  actions: { requestEdit: false, submitOriginalForApproval: false, publishAsIs: false, review: true, markPublished: false },
};

const hrefs: RecordHrefs = {
  library: '/app/creator/content',
  record: '/app/creator/content/c1',
  requestEdit: '/app/creator/content/c1/request-edit',
  version: (v) => `/app/creator/content/c1?v=${v}`,
  review: (v) => `/app/creator/content/c1?review=${v}`,
  publish: '/app/creator/content/c1?publish=1',
  opportunity: (id) => `/app/creator/opportunities/${id}`,
};

const earnings = (over: Partial<EarningsView> = {}): EarningsView => ({
  currency: 'USD',
  totals: { EXPECTED: 120000, PENDING: 0, RECEIVED_BY_EMG: 30000, AVAILABLE: 5000, TRANSFER_PENDING: 0, PAID: 0 },
  availableMinor: 5000,
  entries: [
    { id: 'e1', description: 'Reel 1 of 2', amountMinor: 5000, currency: 'USD', state: 'AVAILABLE', stateLabel: 'Available to you', payable: true, occurredAt: '2026-09-20T12:00:00Z', source: 'SEEDED_DEMO', campaignName: 'Kona Product Video', deliverableTitle: 'Reel 1 of 2' },
    { id: 'e2', description: 'Reel 2 of 2', amountMinor: 120000, currency: 'USD', state: 'EXPECTED', stateLabel: 'Expected', payable: false, occurredAt: '2026-09-21T12:00:00Z', source: 'EMG', campaignName: 'Kona Product Video', deliverableTitle: null },
  ],
  seeded: true,
  payoutState: 'NOT_SET_UP',
  ...over,
});

// ---- What Loop noticed -----------------------------------------------------------------------------

describe('What Loop noticed', () => {
  it('with no notice, says nothing was noticed rather than inventing a rung', () => {
    const html = render(<CreatorNoticePanel notice={null} />);
    assert.match(html, /aria-label="What Loop noticed"/);
    assert.match(html, /Nothing noticed yet/);
    assert.match(html, /data-state="unavailable"/);
    assert.equal(render(<CreatorNoticePanel notice={{ rungs: [], seeded: false }} />).includes('Nothing noticed yet'), true);
  });

  it('tags every rung with its kind and source; a withheld rung is the dashed card; seeded data is said', () => {
    const notice: ContentNotice = {
      seeded: true,
      rungs: [
        { rung: 'FACT', text: 'Edit v1 runs 0:41', source: "from the file, as read in the uploader's browser", observedAt: '2026-09-22T20:02:00Z' },
        { rung: 'OBSERVATION', text: 'Edit v1 is 0:41, 6 s shorter than the Original', source: "Loop's comparison of the versions", observedAt: null },
        { rung: 'NOT_YET', text: 'How this compares: Loop needs at least 3 other published pieces on Instagram to compare (has 1)', source: "Loop's comparison with your other pieces on Instagram" },
        { rung: 'INTERPRETATION', text: 'This is above your usual first-window reach on Instagram', source: "Loop's inference from 6 other pieces", sample: 6, standing: 'proposed', restsOn: '1.6× your median', limitations: ['One window against 6 pieces; it is not a forecast'] },
      ],
    };
    const html = render(<CreatorNoticePanel notice={notice} when={(iso) => time.dateTime(iso)} />);
    for (const tag of ['>Fact<', '>Observation<', '>Not yet<', '>Interpretation<']) assert.ok(html.includes(tag), tag);
    assert.match(html, /data-rung="NOT_YET"[^>]*>|ch-rung--held/);
    assert.ok(html.includes('ch-rung ch-rung--held'), 'the withheld rung is the dashed card');
    assert.ok(html.includes("from the file, as read in the uploader&#x27;s browser"), 'the source is under the rung');
    assert.ok(html.includes('6 pieces'), 'the sample is stated');
    assert.ok(html.includes('standing: proposed'), 'the standing is stated, never verified');
    assert.ok(html.includes('Rests on: 1.6× your median'));
    assert.ok(html.includes('data-seeded'), 'seeded demo data is labelled');
    assert.equal(html.includes('verified'), false);
  });
});

// ---- the library ---------------------------------------------------------------------------------------

describe('The Content library', () => {
  it('has an honest empty state, and a different one for an empty filter', () => {
    assert.match(render(<LibraryEmpty filtered={false} />), /No content yet\./);
    assert.match(render(<LibraryEmpty filtered={true} />), /Nothing matches this filter\./);
  });

  it('draws a placeholder, never a broken player, when storage cannot serve the version', () => {
    const item: LibraryItem = { id: 'c1', title: 'Kona unboxing reel', kind: 'VIDEO', state: 'YOUR_REVIEW', stateLabel: 'Ready for your review', latestVersion: editV1, campaignName: 'Kona Product Video', deliverableTitle: 'Reel 1 of 2', published: false, updatedAt: '2026-09-22T20:02:00Z' };
    const without = render(<LibraryGrid items={[item]} time={time} mediaHref={null} recordHref={(id) => `/app/creator/content/${id}`} />);
    assert.match(without, /data-thumb="placeholder"/);
    assert.equal(without.includes('<video'), false);
    const withMedia = render(<LibraryGrid items={[item]} time={time} mediaHref={(v) => `/api/creator/media/${v}`} recordHref={(id) => `/app/creator/content/${id}`} />);
    assert.match(withMedia, /<video[^>]*src="\/api\/creator\/media\/v1"/);
    assert.match(withMedia, /href="\/app\/creator\/content\/c1"/);
    assert.match(withMedia, /Ready for your review/);
    assert.match(withMedia, /Kona Product Video/);
  });
});

// ---- the Content Record ----------------------------------------------------------------------------------

describe('The Content Record', () => {
  const html = render(
    <ContentRecordBody record={review} time={time} mediaHref={(v) => `/api/creator/media/${v}`} notice={null} performance={[]} selectedVersionId={null} hrefs={hrefs} actionBar={<div data-region="actions" />} noteForm={<form data-region="note-form" />} />,
  );

  it('keeps the eight regions in the mockup order', () => {
    const marks = ['<h1 class="loop-title">Kona unboxing reel</h1>', 'data-region="state"', 'data-region="media"', 'aria-label="Where this fits"', 'aria-label="Production"', 'aria-label="Versions"', 'aria-label="What Loop noticed"', 'aria-label="After publishing"', 'data-region="actions"'];
    const positions = marks.map((m) => html.indexOf(m));
    positions.forEach((p, i) => assert.ok(p >= 0, `${marks[i]} is rendered`));
    for (let i = 1; i < positions.length; i += 1) assert.ok(positions[i]! > positions[i - 1]!, `${marks[i]} comes after ${marks[i - 1]}`);
  });

  it('says the state and the fact that put it there, and the deliverable line the campaign owns', () => {
    assert.match(html, /loop-pill loop-pill--attention">Ready for your review</);
    assert.match(html, /Edit v1 · returned .* by Sam/);
    assert.match(html, /Reel 1 of 2 · awaiting your approval/);
    assert.match(html, /Needed for Reel 1 of 2/);
    assert.match(html, /data-requirement="brand" data-met="false"/);
    assert.match(html, /Kona&#x27;s approval/);
  });

  it('projects the production from Work OS: the cycle, its stage, who returned it and the note', () => {
    assert.match(html, /<dt>Production 1<\/dt><dd>Your review/);
    assert.match(html, /<dt>Returned by<\/dt><dd>Sam · /);
    assert.match(html, /Sam&#x27;s note/);
    assert.match(html, /Kept your 0:11 beat/);
    assert.match(html, /<dt>You asked for<\/dt>/);
    assert.match(html, /<dt>EMG expects<\/dt>/);
    assert.match(html, /data-region="note-form"/, 'the note form is offered while a production is active');
  });

  it('shows the lineage as a strip with the latest selected, and the full history behind one disclosure', () => {
    assert.match(html, /class="ch-vchip"[^>]*href="\/app\/creator\/content\/c1\?v=v0"/);
    assert.match(html, /class="ch-vchip is-on"[^>]*href="\/app\/creator\/content\/c1\?v=v1"/);
    const entries = historyEntries(review, time);
    assert.deepEqual(entries.map((e) => e.story), [
      'Original uploaded by you',
      'You asked EMG for an edit — Production 1 started',
      'EMG set the expected return: Sep 23, 2026, 12:00 PM',
      'Edit v1 returned by Sam',
    ]);
    assert.match(html, /Full history · 4 events/);
    assert.match(html, /<video[^>]*src="\/api\/creator\/media\/v1"/, 'the preview plays the selected version');
  });

  it('with no storage, the preview is an honest state and nothing else changes', () => {
    const noStorage = render(<ContentRecordBody record={review} time={time} mediaHref={null} notice={null} performance={[]} selectedVersionId={null} hrefs={hrefs} actionBar={null} />);
    assert.match(noStorage, /Preview unavailable on this deployment\./);
    assert.equal(noStorage.includes('<video'), false);
    assert.match(noStorage, /Nothing noticed yet/);
    assert.match(noStorage, /Performance appears here after you publish and connect the post\./);
  });

  it('renders a refusal the last action sent back as an attention block', () => {
    const refused = render(<ContentRecordBody record={review} time={time} mediaHref={null} notice={null} performance={[]} selectedVersionId={null} hrefs={hrefs} actionBar={null} refused={{ reason: 'PRODUCTION_ACTIVE', detail: null }} />);
    assert.match(refused, /data-state="attention"/);
    assert.match(refused, /already in production/);
  });
});

// ---- earnings --------------------------------------------------------------------------------------------

describe('Earnings', () => {
  it('offers the transfer control only for an available balance, and keeps it inert until payouts are set up', () => {
    const html = render(<EarningsBody earnings={earnings()} time={time} />);
    assert.match(html, /data-available-minor="5000"[^>]*>\$50\.00</);
    assert.match(html, /data-transfer-control/);
    assert.match(html, /aria-disabled="true" title="Payouts are not set up">Transfer funds/);
    assert.equal(/<a[^>]*>Transfer funds/.test(html), false, 'never a link that moves money');
    const none = render(<EarningsBody earnings={earnings({ totals: { EXPECTED: 120000, PENDING: 0, RECEIVED_BY_EMG: 30000, AVAILABLE: 0, TRANSFER_PENDING: 0, PAID: 0 }, availableMinor: 0 })} time={time} />);
    assert.equal(none.includes('data-transfer-control'), false);
    assert.match(none, /data-available-minor="0"[^>]*>\$0\.00</);
    const demoPayout = render(<EarningsBody earnings={earnings({ payoutState: 'SEEDED_DEMO' })} time={time} />);
    assert.match(demoPayout, /aria-disabled="true" title="Transfers are not available in Loop yet">Transfer funds/);
  });

  it('labels a seeded row on the row, and the page when any row is seeded', () => {
    const html = render(<EarningsBody earnings={earnings()} time={time} />);
    const rows = html.split('<tr');
    const seededRow = rows.find((r) => r.includes('data-entry-source="SEEDED_DEMO"'))!;
    const emgRow = rows.find((r) => r.includes('data-entry-source="EMG"'))!;
    assert.match(seededRow, /data-seeded-row[^>]*>seeded demo data</);
    assert.equal(emgRow.includes('data-seeded-row'), false);
    assert.match(html, /data-seeded[^>]*>Some of these amounts are seeded demo data/);
    for (const label of ['Expected', 'Pending', 'Received by EMG', 'Available to you', 'Transfer pending', 'Paid']) assert.ok(html.includes(label), label);
  });
});

// ---- analytics -------------------------------------------------------------------------------------------

describe('Audience over time', () => {
  it('draws to scale only from rows, one series per chart, with the same rows as a table', () => {
    const series = { platform: 'INSTAGRAM', points: [
      { observedAt: '2026-08-01T12:00:00Z', followers: 10000, source: 'SEEDED_DEMO' },
      { observedAt: '2026-09-01T12:00:00Z', followers: 12000, source: 'SEEDED_DEMO' },
    ] };
    const html = render(<AudienceChart series={series} time={time} />);
    assert.match(html, /role="img" aria-label="Instagram followers from 10K on Aug 1, 2026 to 12K on Sep 1, 2026, 2 observations"/);
    assert.match(html, /<title>Aug 1, 2026 · 10,000 followers · seeded demo data<\/title>/, 'the exact number lives on the point and in the table');
    assert.equal((html.match(/<circle/g) ?? []).length, 2, 'one marker per observation');
    assert.equal(html.includes('<legend') || html.includes('class="legend"'), false, 'a single series needs no legend');
    assert.match(html, /As a table · 2 observations/);
    assert.match(html, /Includes seeded demo data\./);
    const one = render(<AudienceChart series={{ platform: 'TIKTOK', points: [series.points[0]!] }} time={time} />);
    assert.equal(one.includes('<svg'), false, 'a line needs two points; one is said, not drawn');
  });
});

// ---- source-level invariants ---------------------------------------------------------------------------------

describe('The creator tree keeps the platform invariants', () => {
  const pages = walk(CREATOR).filter((f) => f.endsWith('/page.tsx'));

  it('every page states the tree authority as its first await, then binds the creator seat', () => {
    assert.ok(pages.length >= 9, pages.map((p) => relative(SRC, p)).join(', '));
    for (const page of pages) {
      const rel = relative(SRC, page);
      const src = code(readFileSync(page, 'utf8'));
      if (/redirect\(LOOP_HOME\);/.test(src)) continue; // the former role home
      const body = src.slice(src.indexOf('export default async function'));
      const first = body.match(/await ([^;]+);/)?.[1] ?? '';
      assert.ok(first.startsWith("requireWorkspace('CREATOR')"), `${rel}: first await is "${first}"`);
      if (!rel.includes('[...slug]')) assert.match(body, /const seat = await requireCreator\(\);/, `${rel} binds the seat`);
    }
  });

  it('the client leaves import nothing from the database package, and are the only client boundaries in the tree', () => {
    const files = walk(CREATOR).filter((f) => /\.tsx?$/.test(f));
    const clients = files.filter((f) => /^(\s*(\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*'use client'/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(clients.map((f) => relative(CREATOR, f)).sort(), ['_client/ReviewSheet.tsx', '_client/Uploader.tsx']);
    for (const f of clients) {
      const src = code(readFileSync(f, 'utf8'));
      for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        assert.equal(/^@emgloop\/database|^@prisma\/client|^server-only$/.test(m[1]!), false, `${relative(CREATOR, f)} imports ${m[1]}`);
      }
    }
  });

  it('adds no stylesheet of its own, and its CSS section declares no colour', () => {
    assert.deepEqual(walk(CREATOR).filter((f) => f.endsWith('.css')), []);
    const css = read('app/loop-os.css');
    const start = css.indexOf('/* ===================== CREATOR HUB =====================');
    assert.ok(start > 0, 'the section exists');
    const section = css.slice(start).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(section), false, 'no colour literal');
    assert.equal(/--[a-z0-9-]+\s*:/.test(section), false, 'no token declared');
    assert.match(section, /\.ch-actbar \{ position: sticky; bottom: 0;/);
  });

  it('the inert upload page is gone, and Loop Home hands a creator seat its own Home', () => {
    assert.equal(existsSync(join(CREATOR, 'upload', 'page.tsx')), false);
    const home = code(read('app/app/page.tsx'));
    assert.match(home, /const creatorSeat = await creatorSeatOf\(session\);/);
    assert.match(home, /\{creatorSeat \? \(\s*<CreatorHome seat=\{creatorSeat\} time=\{time\} \/>\s*\) : role === 'ADMIN' \? \(/);
  });

  it('every action begins with the seat and reads no organization or creator from the form', () => {
    const actions = code(read('creator/creator-actions.ts'));
    assert.match(actions, /^'use server';/m);
    const bodies = actions.split(/export async function /).slice(1);
    assert.ok(bodies.length >= 8, `${bodies.length} actions`);
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf('('));
      assert.match(body, /const seat = await requireCreator\(\);/, `${name} binds the seat first`);
      assert.equal(/formData\.get\('(organizationId|orgId|creatorProfileId|profileId|userId)'\)/.test(body), false, `${name} takes no scope from the form`);
    }
    assert.equal(/new Date\(local\)|new Date\(field/.test(actions), false, 'wall-clock input never becomes an instant on the server clock');
    assert.match(actions, /zonedWallTimeToUtc\(zone,/);
  });
});
