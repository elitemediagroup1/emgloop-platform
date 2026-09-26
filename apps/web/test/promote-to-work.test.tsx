// Loop Intelligence Phase C (2026-09-26): Promote to Work on the web -- the one bridge, confirmed by a person.
//
//   - the origin travels as keyed references on the SAME page (no new subpage); garbage parses to nothing;
//   - the action takes the organization and the person from the signed session only, requires the
//     confirmation box, and hands the service authority decided from permissions (work:manage for
//     assigning others, the Headlines gate for Cases, each domain's registry authority);
//   - the confirmation says exactly what becomes shared and cannot be submitted unconfirmed;
//   - AI NEVER CREATES WORK: nothing but the confirmed web action calls the service's `promote`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { promoteHref, promoteOriginFrom, promoteParams } from '../src/work/promote-origin';
import { PromotePanel } from '../src/work/promote-panel';
import type { PromoteView } from '../src/work/promote';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === 'node_modules' || f === 'dist' || f === '.next') return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });

describe('the origin travels as keys, on the page that shows it', () => {
  it('round-trips every origin kind, and refuses anything malformed', () => {
    const origins = [
      { kind: 'WORK_ITEM', itemId: 'wi_123' },
      { kind: 'CASE', caseId: 'case_9' },
      { kind: 'DIGEST_SIGNAL', scope: 'PRINCIPAL', domain: 'CHATS', subjectKind: 'CONVERSATION', subjectRef: 'telegram_conversation:ck_1', signalKey: 'obligation.ab12.0' },
      { kind: 'DIGEST_SIGNAL', scope: 'ORGANIZATION', domain: 'CALLGRID', subjectKind: 'DOMAIN', subjectRef: 'domain', signalKey: 'conversion-slip' },
    ] as const;
    for (const origin of origins) {
      const params = promoteParams(origin);
      assert.deepEqual(promoteOriginFrom((k) => params[k] ?? null), origin);
    }
    assert.match(promoteHref('/app/chats', origins[0]), /^\/app\/chats\?promote=item&id=wi_123#promote$/);
    for (const bad of [{ promote: 'item', id: 'bad id' }, { promote: 'signal', d: 'chats', k: 'CONVERSATION', s: 'x', g: 'k' }, { promote: 'case', id: '' }, { promote: 'everything' }, {}]) {
      assert.equal(promoteOriginFrom((k) => (bad as Record<string, string>)[k] ?? null), null, JSON.stringify(bad));
    }
    // Nothing that names an organization or a person can be carried.
    assert.equal(promoteOriginFrom((k) => ({ promote: 'item', id: 'wi_1', organizationId: 'other', userId: 'u' } as Record<string, string>)[k] ?? null)?.kind, 'WORK_ITEM');
    assert.doesNotMatch(JSON.stringify(promoteParams(origins[2])), /organizationId|userId/);
  });
});

describe('the confirmed act', () => {
  it('the action: session first, authority from permissions, the confirmation box required, no organization or user from the form', () => {
    const action = code(read('apps/web/src/work/promote-actions.ts'));
    assert.match(action, /^'use server';/m);
    assert.match(action, /const session = await requireSession\(\);/);
    assert.match(action, /const actor = await promoteActorFor\(session\);/);
    assert.match(action, /confirmed: form\.get\('confirm'\) === 'yes'/);
    for (const forbidden of ["form.get('organizationId')", "form.get('userId')", "form.get('scope')", 'mayAssignOthers: true', 'prisma.workInstance', 'createWorkItem']) {
      assert.equal(action.includes(forbidden), false, forbidden);
    }
    const loader = code(read('apps/web/src/work/promote.ts'));
    assert.match(loader, /hasPermission\('work', 'manage'\)/, 'assigning others is work:manage');
    assert.match(loader, /canOpenHeadlines\(session\)/, 'Cases need the Headlines gate');
    assert.match(loader, /entry\.readAuthority/, 'organization domains use their registry read authority');
    assert.match(loader, /organizationId: session\.organizationId,\s+userId: session\.userId,/);
  });

  it('AI NEVER CREATES WORK: the only caller of the service\'s promote is the confirmed web action', () => {
    const callers: string[] = [];
    for (const dir of ['apps/web/src', 'apps/connections-worker/src', 'packages/database/src', 'packages/shared/src', 'packages/providers/src']) {
      for (const file of walk(join(ROOT, dir))) {
        const src = code(readFileSync(file, 'utf8'));
        if (/PromoteToWorkService\([^)]*\)\.promote\(|\.promote\(actor/.test(src)) callers.push(file.slice(ROOT.length));
      }
    }
    assert.deepEqual(callers, ['apps/web/src/work/promote-actions.ts']);
    // And no producer, sweep or model path imports the service at all.
    for (const dir of ['apps/connections-worker/src', 'packages/database/src/services/intelligence-fabric', 'packages/database/src/services/ai-runtime']) {
      for (const file of walk(join(ROOT, dir))) assert.equal(readFileSync(file, 'utf8').includes('PromoteToWorkService'), false, file);
    }
  });
});

describe('the confirmation says what becomes shared', () => {
  const view = (over: Partial<PromoteView> = {}): PromoteView => ({
    preview: {
      outcome: 'READY',
      proposal: {
        origin: { kind: 'WORK_ITEM', itemId: 'wi_1' },
        originLabel: 'Your chats',
        originScope: 'PRINCIPAL',
        title: 'Send Premier the revised allocation',
        outcome: 'Premier has the revised allocation',
        suggestedAssigneeUserId: 'u_me',
        targetAt: new Date('2026-09-30T17:00:00Z'),
        sharedFields: ['title', 'outcome', 'assignee', 'targetDate'],
        fingerprint: 'promote:abc',
        submissionNonce: 'nonce_abcdefghijklmnop',
        alreadyLinkedCount: 0,
      },
    },
    workTypes: [{ id: 'bp_1', name: 'Follow-up' }],
    assignees: [{ id: 'u_me', name: 'Matt (you)' }],
    ...over,
  });

  it('private origins say they stay private until confirmed; the box is required; only yourself unless permitted', () => {
    const html = renderToStaticMarkup(<PromotePanel view={view()} returnTo="/app/chats" />);
    assert.match(html, /This stays private until you confirm/);
    assert.match(html, /Nothing else from the conversation is shared/);
    assert.match(html, /Becomes shared: the title, the outcome, who it is assigned to, the target date\./);
    assert.match(html, /<input type="checkbox" name="confirm" required="" value="yes"\/>/);
    assert.match(html, /name="fingerprint" value="promote:abc"/);
    assert.match(html, /name="promote" value="item"/);
    assert.equal((html.match(/<option /g) ?? []).length, 2, 'one work type and one assignee: yourself');
    assert.match(html, /value="2026-09-30"/);
    // One submission, one piece of work: the preview's nonce travels with the form.
    assert.match(html, /name="submission" value="nonce_abcdefghijklmnop"/);
    assert.doesNotMatch(html, /data-promote-linked/, 'nothing linked yet: nothing said');
  });

  it('an origin already linked says so, and that promoting again creates another piece of work', () => {
    const v = view();
    const linked = { ...v, preview: { outcome: 'READY' as const, proposal: { ...(v.preview as { proposal: object }).proposal, alreadyLinkedCount: 2 } } } as PromoteView;
    const html = renderToStaticMarkup(<PromotePanel view={linked} returnTo="/app" />);
    assert.match(html, /already linked to 2 pieces of work\. Promoting it again creates another\./);
  });

  it('Home hosts the confirmation for a person’s own private situation; the action carries the nonce', () => {
    const home = read('apps/web/src/app/app/page.tsx');
    assert.match(home, /promoteOriginFrom\(param\)/);
    assert.match(home, /<PromotePanel view=\{promoteView\} returnTo="\/app" \/>/);
    assert.match(read('apps/web/src/intelligence/situations-view.tsx'), /s\.visibility === 'PRINCIPAL' \? \([\s\S]*promoteHref\('\/app', \{ kind: 'CASE', caseId: s\.id \}\)/);
    assert.match(read('apps/web/src/work/promote-actions.ts'), /submissionNonce: String\(form\.get\('submission'\) \?\? ''\)/);
  });

  it('a refusal is words, and nothing is offered to submit', () => {
    const html = renderToStaticMarkup(<PromotePanel view={view({ preview: { outcome: 'REFUSED', refusal: 'NOT_FOUND' } })} returnTo="/app/chats" />);
    assert.match(html, /could not find that any more/);
    assert.doesNotMatch(html, /<form/);
    const none = renderToStaticMarkup(<PromotePanel view={view({ workTypes: [] })} returnTo="/app/chats" />);
    assert.match(none, /No active work type exists yet/);
    assert.doesNotMatch(none, /type="submit"/);
  });
});
