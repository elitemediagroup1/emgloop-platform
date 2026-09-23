// EMG Creator Operations (Creator Hub, 2026-09-22): the roster, the requests lane, the
// creator operating view and the EMG content record, plus the two Work OS detail pages
// and the Person record that compose it.
//
// What these prove:
//   - Every creator-hub page states the ADMIN tree's authority first, before any read, and
//     exactly that authority: the nav item carries no permission, so no requirePermission.
//   - Empty is said, never dressed as data: the roster and the lane have honest empty states.
//   - The requests lane groups and orders the domain's rows purely.
//   - The upload leaf ships no database to the browser; every action begins with the EMG seat.
//   - The Person record links to creator operations only when a profile exists AND the seat
//     can open the ADMIN tree; otherwise it says where the view is, and never invents a value.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CreatorProfile, ProductionView } from '@emgloop/database';
import { createTimeView } from '@emgloop/shared';

import { DONE_LIMIT, RequestsView, RosterView, groupRequests, refusalText, type RequestRow } from '../src/app/app/admin/creator-hub/_shared';
import { EMG_HREFS } from '../src/creator/creator-runtime';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const read = (p: string) => readFileSync(join(SRC, p), 'utf8');
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const render = (el: unknown) => renderToStaticMarkup(el as never);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });

const HUB = join(SRC, 'app/app/admin/creator-hub');
const PAGES = walk(HUB).filter((f) => f.endsWith('/page.tsx'));

const profile = (over: Partial<CreatorProfile> & { id: string; displayName: string }): CreatorProfile =>
  ({ handle: null, partyId: `party_${over.id}`, userId: null, ...over }) as unknown as CreatorProfile;

const time = createTimeView({ timeZone: 'UTC', source: 'fallback' }, new Date('2026-09-22T12:00:00.000Z'));

function production(over: Partial<ProductionView> & { id: string; number: number }): ProductionView {
  return {
    kind: 'EDIT',
    workInstanceId: `w_${over.id}`,
    workStatus: 'active',
    sourceVersionId: 'v0',
    requestedBy: { userId: 'u_denise', name: 'Denise Reyes' },
    requestedReturnAt: null,
    expectedReturnAt: null,
    expectedReturnSetBy: null,
    expectedReturnSetAt: null,
    createdAt: '2026-09-20T10:00:00.000Z',
    completedAt: null,
    currentStep: null,
    steps: [],
    instructions: [],
    comments: [],
    ...over,
  };
}

describe('Creator Operations pages state the ADMIN authority first, and only that', () => {
  it('finds the four pages', () => {
    const rel = PAGES.map((p) => relative(HUB, p)).sort();
    assert.deepEqual(rel, ['[profileId]/content/[contentId]/page.tsx', '[profileId]/page.tsx', 'page.tsx', 'requests/page.tsx']);
  });

  it("every page's first await is requireWorkspace('ADMIN'), and no page adds a requirePermission the nav item does not state", () => {
    for (const page of PAGES) {
      const src = code(readFileSync(page, 'utf8'));
      const body = src.slice(src.indexOf('export default async function'));
      const first = body.match(/await ([^;]+);/)?.[1] ?? '';
      assert.ok(first.startsWith("requireWorkspace('ADMIN')"), `${relative(SRC, page)}: first await is "${first}"`);
      assert.equal(/requirePermission|requireWorkspacePermission/.test(src), false, relative(SRC, page));
      assert.equal(src.includes("'use client'"), false, relative(SRC, page));
      assert.match(src, /<LoopPage\b/, `${relative(SRC, page)} renders on the shared page`);
      assert.match(src, /export const dynamic = 'force-dynamic';/);
    }
  });

  it('the roster and the lane read only the EMG projections the domain offers; nothing touches prisma', () => {
    for (const page of PAGES) {
      const src = code(readFileSync(page, 'utf8'));
      assert.equal(/\bprisma\./.test(src), false, relative(SRC, page));
    }
    assert.match(code(read('app/app/admin/creator-hub/page.tsx')), /creatorDomain\(\)\.records\.roster\(session\.organizationId\)/);
    assert.match(code(read('app/app/admin/creator-hub/requests/page.tsx')), /creatorDomain\(\)\.records\.requests\(session\.organizationId\)/);
    assert.match(code(read('app/app/admin/creator-hub/[profileId]/content/[contentId]/page.tsx')), /contentRecord\(\{ kind: 'EMG', organizationId \}, params\.contentId\)/);
    // A content record addressed under the wrong creator is not found, never explained.
    assert.match(code(read('app/app/admin/creator-hub/[profileId]/content/[contentId]/page.tsx')), /if \(!record \|\| record\.creator\.profileId !== params\.profileId\) notFound\(\);/);
  });

  it('the addresses the pages and the nav agree on', () => {
    assert.equal(EMG_HREFS.creators, '/app/admin/creator-hub');
    assert.equal(EMG_HREFS.requests, '/app/admin/creator-hub/requests');
    assert.equal(EMG_HREFS.creator('p 1'), '/app/admin/creator-hub/p%201');
    assert.equal(EMG_HREFS.creatorContent('p1', 'c1'), '/app/admin/creator-hub/p1/content/c1');
  });
});

describe('The roster', () => {
  it('says honestly when there is no creator', () => {
    const html = render(<RosterView rows={[]} />);
    assert.match(html, /class="loop-state loop-state--empty"/);
    assert.match(text(html), /No creators yet\./);
    assert.equal(html.includes('<table'), false);
  });

  it('shows one row per creator with the counts and a link to the operating view', () => {
    const html = render(
      <RosterView
        rows={[
          { profile: profile({ id: 'cp1', displayName: 'Denise Reyes', handle: 'denise' }), needsEmg: 2, needsCreator: 1, inProduction: 3, dueSoon: 0, contentCount: 7 },
          { profile: profile({ id: 'cp2', displayName: 'Marco Li' }), needsEmg: 0, needsCreator: 0, inProduction: 0, dueSoon: 1, contentCount: 0 },
        ]}
      />,
    );
    assert.match(html, /href="\/app\/admin\/creator-hub\/cp1"/);
    assert.match(html, /href="\/app\/admin\/creator-hub\/cp2"/);
    assert.match(text(html), /Denise Reyes · @denise 2 1 3 0 7/);
    assert.match(text(html), /Marco Li 0 0 0 1 0/);
  });
});

describe('The requests lane', () => {
  const rows: RequestRow[] = [
    { production: production({ id: 'a', number: 1, createdAt: '2026-09-21T09:00:00.000Z', currentStep: { id: 's', position: 1, name: 'Edit', kind: 'EDIT', round: 1, status: 'ready', owner: null, startedAt: null, completedAt: null, completedBy: null, note: null }, requestedReturnAt: '2026-09-23T15:00:00.000Z' }), contentId: 'c_a', contentTitle: 'Kona unboxing reel', creator: profile({ id: 'cp1', displayName: 'Denise Reyes' }), needs: 'EMG' },
    { production: production({ id: 'b', number: 2, createdAt: '2026-09-19T09:00:00.000Z', currentStep: { id: 's', position: 1, name: 'Edit · round 2', kind: 'EDIT', round: 2, status: 'in_progress', owner: { userId: 'u_sam', name: 'Sam K.' }, startedAt: null, completedAt: null, completedBy: null, note: null }, expectedReturnAt: '2026-09-23T12:00:00.000Z', expectedReturnSetBy: { userId: 'u_priya', name: 'Priya N.' } }), contentId: 'c_b', contentTitle: 'Studio tour', creator: profile({ id: 'cp2', displayName: 'Marco Li' }), needs: 'EMG' },
    { production: production({ id: 'c', number: 1, currentStep: { id: 's', position: 2, name: 'Creator review', kind: 'REVIEW', round: 1, status: 'ready', owner: { userId: 'u_denise', name: 'Denise Reyes' }, startedAt: null, completedAt: null, completedBy: null, note: null } }), contentId: 'c_c', contentTitle: 'Morning routine', creator: profile({ id: 'cp1', displayName: 'Denise Reyes' }), needs: 'CREATOR' },
    ...Array.from({ length: DONE_LIMIT + 3 }, (_, i) => ({
      production: production({ id: `d${i}`, number: 1, workStatus: 'completed' as const, completedAt: `2026-09-${String(1 + (i % 20)).padStart(2, '0')}T10:00:00.000Z` }),
      contentId: `c_d${i}`,
      contentTitle: `Done ${i}`,
      creator: profile({ id: 'cp1', displayName: 'Denise Reyes' }),
      needs: 'DONE' as const,
    })),
  ];

  it('groups purely: needs EMG and awaiting creator oldest first, done newest first and capped', () => {
    const g = groupRequests(rows);
    assert.deepEqual(g.needsEmg.map((r) => r.production.id), ['b', 'a']);
    assert.deepEqual(g.awaitingCreator.map((r) => r.production.id), ['c']);
    assert.equal(g.done.length, DONE_LIMIT);
    const stamps = g.done.map((r) => r.production.completedAt!);
    assert.deepEqual(stamps, [...stamps].sort().reverse());
  });

  it('renders each row with creator, content, production, step and owner (or no owner yet), requested vs expected, and both links', () => {
    const html = render(<RequestsView groups={groupRequests(rows)} time={time} />);
    const t = text(html);
    assert.match(t, /Needs EMG 2/);
    assert.match(t, /Awaiting creator 1/);
    assert.match(t, new RegExp(`Finished ${DONE_LIMIT}`));
    assert.match(t, /Denise Reyes Kona unboxing reel · Production 1 Edit — no owner yet Sep 23, 2026, 3:00 PM UTC · Denise Reyes Not set Work · Content/);
    assert.match(t, /Marco Li Studio tour · Production 2 Edit · round 2 — Sam K\. Not asked Sep 23, 2026, 12:00 PM UTC · set by Priya N\. Work · Content/);
    assert.match(t, /Morning routine · Production 1 Creator review — Denise Reyes/);
    assert.match(html, /href="\/app\/admin\/work\/w_a"/);
    assert.match(html, /href="\/app\/admin\/creator-hub\/cp1\/content\/c_a"/);
    assert.match(t, new RegExp(`The ${DONE_LIMIT} most recent`));
  });

  it('says honestly when there is nothing', () => {
    const html = render(<RequestsView groups={groupRequests([])} time={time} />);
    assert.match(html, /loop-state--empty/);
    assert.match(text(html), /No production requests yet\./);
  });
});

describe('The EMG seat acts only through the actions, and the actions only through the seat', () => {
  const actions = read('creator/emg-actions.ts');

  it("every exported action's first await is requireEmgActor()", () => {
    assert.match(actions, /^'use server';/);
    const names = [...actions.matchAll(/export async function (\w+Action)\(formData: FormData\)/g)].map((m) => m[1]!);
    assert.deepEqual(names.sort(), [
      'addProductionCommentAction', 'bindCreatorLoginAction', 'declareDeliverableAction', 'designateOpportunityAction',
      'recordBrandApprovalAction', 'recordEmgApprovalAction', 'relayBrandFeedbackAction', 'returnVersionForReviewAction',
      'setExpectedReturnAction', 'transitionCampaignAction',
    ]);
    for (const name of names) {
      const start = actions.indexOf(`export async function ${name}(`);
      const body = actions.slice(start);
      const first = body.match(/await ([^;]+);/)?.[1] ?? '';
      assert.equal(first, 'requireEmgActor()', `${name}: first await is "${first}"`);
    }
    // Nothing reads an organization or a creator from the form.
    assert.equal(/formData\.get\('(organizationId|orgId|creatorPartyId|userId)'\)/.test(actions), false);
    // A wall-clock time never becomes an instant through the server's clock.
    assert.equal(/new Date\(str\(|new Date\(raw|new Date\(formData/.test(actions), false);
    assert.match(actions, /zonedWallTimeToUtc\(zone\.timeZone/);
    // Return paths are safe application paths only.
    assert.match(actions, /safeNextPath\(formData\.get\('returnTo'\)\)/);
  });

  it('a refusal is rendered as attention, with words for every reason the services and actions can give', () => {
    for (const reason of ['NOT_FOUND', 'NOT_ALLOWED', 'NOT_YOUR_STEP', 'VERSION_NOT_READY', 'NO_ACTIVE_PRODUCTION', 'PRODUCTION_ACTIVE', 'BAD_DATE', 'BAD_NOTES', 'NOT_A_CREATOR_LOGIN', 'INVALID']) {
      assert.notEqual(refusalText(reason), refusalText('SOMETHING_ELSE'), reason);
    }
    assert.match(refusalText('SOMETHING_ELSE'), /refused and nothing was changed/);
  });

  it('the upload leaf is a client component that ships no database, no server module and no configuration', () => {
    const leaf = read('creator/_client/EmgVersionUploader.tsx');
    assert.match(leaf.replace(/^(\s*(\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*/, ''), /^'use client'/);
    const imports = [...code(leaf).matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    assert.deepEqual(imports, ['react', '../emg-actions']);
    assert.equal(/process\.env|@emgloop\/database|@prisma\/client|server-only|next\/navigation/.test(leaf), false);
    // Two visibilities, two fields; and the act after the upload is a choice, defaulting to send.
    assert.match(leaf, /Note to \{creatorFirstName\} · visible to them/);
    assert.match(leaf, /Internal note · EMG only/);
    assert.match(leaf, /useState<'send' \| 'draft'>\('send'\)/);
    assert.match(leaf, /<form ref=\{sendFormRef\} action=\{returnVersionForReviewAction\} hidden/);
  });
});

describe('The Work OS detail pages render the production view in place of the generic completion', () => {
  it('the admin detail reads the production, passes the ADMIN seat, and hides "Complete this step" for a production', () => {
    const src = code(read('app/app/admin/work/[id]/page.tsx'));
    assert.match(src, /const actor = await requireWorkActor\(\);/);
    assert.match(src, /creatorDomain\(\)\.records\.productionForWork\(actor\.organizationId, params\.id\)/);
    assert.match(src, /const primaryAction = production \? \(\s*<ProductionPanel/);
    assert.match(src, /actor=\{\{ userId: actor\.userId, canActOnAnyStep: true \}\}/);
    assert.match(src, /workspace="ADMIN"/);
    assert.match(src, /\{production \? null : \(\s*<div className="ent-manage__block">\s*<p className="ent-manage__label">Comments/);
  });

  it('the employee detail reads the production, passes the EMPLOYEE seat, and hides "Complete current stage" for a production', () => {
    const src = code(read('app/app/employee/work/[id]/page.tsx'));
    assert.match(src, /const actor = await requireEmployeeActor\(\);/);
    assert.match(src, /creatorDomain\(\)\.records\.productionForWork\(actor\.organizationId, params\.id\)/);
    assert.match(src, /actor=\{\{ userId: actor\.userId, canActOnAnyStep: false \}\}/);
    assert.match(src, /workspace="EMPLOYEE"/);
    assert.match(src, /hrefs=\{\{ work: EMG_HREFS\.employeeWork\(instance\.id\), content: null, creator: null \}\}/);
    assert.match(src, /\{production \? null : instance\.status === 'active' && current && isMine \? \(/);
  });

  it('neither page tells the panel more than the storage state and its reason', () => {
    for (const file of ['app/app/admin/work/[id]/page.tsx', 'app/app/employee/work/[id]/page.tsx']) {
      const src = code(read(file));
      assert.match(src, /mediaRuntime\?\.state === 'CONFIGURED' \? \(\{ state: 'CONFIGURED' \} as const\)/, file);
      assert.equal(/mediaRuntime\.storage|storage=/.test(src), false, file);
    }
  });
});

describe('The Person record and its creator context', () => {
  const src = code(read('app/app/crm/people/[partyId]/page.tsx'));

  it('still guards itself first and keeps its honest summary', () => {
    assert.match(src, /const session = await requirePermission\('identityResolution', 'view'\);/);
    assert.ok(src.indexOf("await requirePermission('identityResolution', 'view')") < src.indexOf('crmSubjectReads('));
    assert.match(src, /label: 'Opportunities', value: null/);
    assert.match(src, /label: 'Open work', value: null/);
  });

  it('links Opportunities and Work to the creator operating view only when a profile exists and the seat can open the ADMIN tree', () => {
    assert.match(src, /creatorDomain\(\)\.creator\.profileByParty\(session\.organizationId, record\.partyId\)/);
    assert.match(src, /const creatorHref = creatorProfile && resolveWorkspaceRole\(session\) === 'ADMIN' \? EMG_HREFS\.creator\(creatorProfile\.id\) : null;/);
    assert.match(src, /\{ label: 'Opportunities', href: `\$\{creatorHref\}#commercial` \}/);
    assert.match(src, /\{ label: 'Work', href: `\$\{creatorHref\}#content` \}/);
    assert.match(src, /reason: creatorProfile \? CREATOR_ELSEWHERE : 'Opportunities are not tracked in Loop yet\.'/);
    assert.match(src, /reason: creatorProfile \? CREATOR_ELSEWHERE : 'Work is not linked to a person yet\.'/);
    assert.match(src, /<Panel title="Creator">/);
    assert.match(src, /\{creatorHref \? <Link href=\{creatorHref\}>Open creator operations<\/Link> : CREATOR_ELSEWHERE\}/);
  });
});
