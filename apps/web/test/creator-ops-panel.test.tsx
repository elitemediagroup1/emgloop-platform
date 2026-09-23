// The EMG editing work view (edit-review handoff §3) as the ProductionPanel renders it on
// the Work OS detail pages. Rendered here from a fixture in the exact shape the record
// service's EMG projection returns.
//
// What these prove:
//   - Notes render on the timeline as "m:ss · Change · text", with the set's provenance as
//     two facts: originated by, entered by.
//   - The upload control exists only on an Edit step this seat may act on; a creator-review
//     step says "Waiting for <first name>" and offers no upload; storage that is not
//     configured is said, not hidden.
//   - EMG-only drafts and internal notes are marked so; comments carry their visibility.
//   - Only the ADMIN seat commits an expected return.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ContentRecordView, InstructionView, PersonRef, ProductionView, StepView, VersionView } from '@emgloop/database';

import { ProductionPanel, openInstruction, provenanceLine, nextVersionLabel } from '../src/creator/production-panel';

const render = (el: unknown) => renderToStaticMarkup(el as never);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const denise: PersonRef = { userId: 'u_denise', name: 'Denise Reyes' };
const sam: PersonRef = { userId: 'u_sam', name: 'Sam K.' };

function version(over: Partial<VersionView> & { id: string; number: number; label: string }): VersionView {
  return {
    kind: over.number === 0 ? 'ORIGINAL' : 'EDIT',
    contentType: 'video/mp4',
    fileName: null,
    uploadState: 'READY',
    byteSize: 1000,
    durationSeconds: 47,
    width: 1080,
    height: 1920,
    storageKey: 'k',
    uploadedBy: denise,
    uploadedByKind: 'CREATOR',
    createdAt: '2026-09-21T10:00:00.000Z',
    readyAt: '2026-09-21T10:01:00.000Z',
    producedByWorkInstanceId: null,
    answersInstructionId: null,
    noteToCreator: null,
    internalNote: null,
    visibleToCreator: true,
    approvals: [],
    publications: [],
    ...over,
  };
}

function step(over: Partial<StepView> & { id: string; position: number; name: string; kind: 'EDIT' | 'REVIEW' }): StepView {
  return { round: 1, status: 'ready', owner: null, startedAt: null, completedAt: null, completedBy: null, note: null, ...over };
}

const instruction: InstructionView = {
  id: 'i1',
  sequence: 1,
  originatorKind: 'CREATOR',
  originatorLabel: null,
  enteredBy: denise,
  refersToVersionId: 'v0',
  refersToVersionLabel: 'Original',
  summary: 'Tighten the opening',
  notes: [
    { id: 'n1', atSeconds: 2, kind: 'CHANGE', text: 'Kona should come before the logo' },
    { id: 'n2', atSeconds: 11, untilSeconds: 14, kind: 'KEEP', text: 'Keep this beat exactly as it is' },
  ],
  requestedReturnAt: '2026-09-23T15:00:00.000Z',
  answeredByVersionId: null,
  answeredByVersionLabel: null,
  answeredAt: null,
  addressed: [],
  createdAt: '2026-09-22T11:00:00.000Z',
};

const editStep = step({ id: 's1', position: 1, name: 'Edit', kind: 'EDIT', status: 'ready', owner: sam });
const reviewStep = step({ id: 's2', position: 2, name: 'Creator review', kind: 'REVIEW', status: 'pending', owner: denise });

function production(over: Partial<ProductionView> = {}): ProductionView {
  return {
    id: 'p1',
    number: 1,
    kind: 'EDIT',
    workInstanceId: 'w1',
    workStatus: 'active',
    sourceVersionId: 'v0',
    requestedBy: denise,
    requestedReturnAt: '2026-09-23T15:00:00.000Z',
    expectedReturnAt: null,
    expectedReturnSetBy: null,
    expectedReturnSetAt: null,
    createdAt: '2026-09-22T11:00:00.000Z',
    completedAt: null,
    currentStep: editStep,
    steps: [editStep, reviewStep],
    instructions: [instruction],
    comments: [
      { id: 'c1', by: sam, body: 'Rendering from the 4K master.', visibility: 'internal', at: '2026-09-22T11:30:00.000Z' },
      { id: 'c2', by: sam, body: 'On it — back to you by noon.', visibility: 'creator_visible', at: '2026-09-22T11:31:00.000Z' },
    ],
    ...over,
  };
}

function record(p: ProductionView, versions: VersionView[]): ContentRecordView {
  return {
    seat: 'EMG',
    id: 'c1',
    title: 'Kona unboxing reel',
    kind: 'VIDEO',
    creator: { profileId: 'cp1', partyId: 'party1', displayName: 'Denise Reyes', userId: 'u_denise' },
    state: 'IN_PRODUCTION',
    stateLabel: 'In production',
    createdAt: '2026-09-21T10:00:00.000Z',
    versions,
    latestVersion: versions[0] ?? null,
    productions: [p],
    activeProduction: p.workStatus === 'active' ? p : null,
    requirements: [],
    requirementStatuses: [],
    judgedVersion: null,
    context: { campaign: null, deliverable: null, opportunity: null },
    actions: { requestEdit: false, submitOriginalForApproval: false, publishAsIs: false, review: false, markPublished: false },
  };
}

const original = version({ id: 'v0', number: 0, label: 'Original' });
const draft = version({ id: 'v1', number: 1, label: 'Edit v1', uploadedBy: sam, uploadedByKind: 'EMG', visibleToCreator: false, internalNote: 'colour untouched', producedByWorkInstanceId: 'w1' });

const hrefs = { work: '/app/admin/work/w1', content: '/app/admin/creator-hub/cp1/content/c1', creator: '/app/admin/creator-hub/cp1' };
const admin = { userId: 'u_priya', canActOnAnyStep: true };
const employeeSam = { userId: 'u_sam', canActOnAnyStep: false };
const employeeOther = { userId: 'u_other', canActOnAnyStep: false };
const configured = { state: 'CONFIGURED' } as const;
const notConfigured = { state: 'NOT_CONFIGURED', reason: 'Media storage is not configured for this deployment.' } as const;

describe('The production panel', () => {
  it('renders the instruction set with its notes on the timeline and its provenance', () => {
    const html = render(<ProductionPanel view={{ record: record(production(), [original]), production: production() }} actor={admin} workspace="ADMIN" hrefs={hrefs} media={configured} />);
    const t = text(html);
    assert.match(t, /Set 1 · “Tighten the opening”/);
    assert.match(t, /0:02 · Change · Kona should come before the logo/);
    assert.match(t, /0:11 – 0:14 · Keep · Keep this beat exactly as it is/);
    assert.match(t, /Originated by Denise Reyes \(creator\) · Entered by Denise Reyes · refers to Original · asked for Sep 23, 2026, 3:00 PM UTC · not yet answered/);
    assert.equal(provenanceLine({ ...instruction, originatorKind: 'BRAND_RELAYED', originatorLabel: 'Kona', enteredBy: sam }), 'Originated by Kona (relayed) · Entered by Sam K.');
    assert.equal(provenanceLine({ ...instruction, originatorKind: 'EMG', enteredBy: sam }), 'Originated by EMG · Entered by Sam K.');
  });

  it('shows requested and expected return as two facts, unknown when unset, and the creator and content links', () => {
    const html = render(<ProductionPanel view={{ record: record(production(), [original]), production: production() }} actor={admin} workspace="ADMIN" hrefs={hrefs} media={configured} />);
    const t = text(html);
    assert.match(t, /Requested return Sep 23, 2026, 3:00 PM UTC · Denise Reyes/);
    assert.match(t, /Expected return Not set yet/);
    assert.match(t, /Waiting on Sam K\./);
    assert.match(t, /Answers next Set 1/);
    assert.match(html, /href="\/app\/admin\/creator-hub\/cp1"/);
    assert.match(html, /href="\/app\/admin\/creator-hub\/cp1\/content\/c1"/);
    const withExpected = production({ expectedReturnAt: '2026-09-23T12:00:00.000Z', expectedReturnSetBy: { userId: 'u_priya', name: 'Priya N.' } });
    assert.match(text(render(<ProductionPanel view={{ record: record(withExpected, [original]), production: withExpected }} actor={admin} workspace="ADMIN" hrefs={hrefs} media={configured} />)), /Expected return Sep 23, 2026, 12:00 PM UTC · set by Priya N\./);
  });

  it('offers the upload on an Edit step to an ADMIN or the assigned editor, and refuses it to anyone else', () => {
    const view = { record: record(production(), [original]), production: production() };
    for (const [actor, workspace] of [[admin, 'ADMIN'], [employeeSam, 'EMPLOYEE']] as const) {
      const html = render(<ProductionPanel view={view} actor={actor} workspace={workspace} hrefs={hrefs} media={configured} />);
      assert.match(html, /data-emg-uploader/, workspace);
      const t = text(html);
      assert.match(t, /Upload Edit v1/, workspace);
      assert.match(t, /Edit v1 answers Set 1 · 2 notes\./, workspace);
      assert.match(t, /Denise’s notes — mark what this version addresses/, workspace);
      assert.match(t, /Note to Denise · visible to them/, workspace);
      assert.match(t, /Internal note · EMG only/, workspace);
      assert.match(t, /Send to Denise for review — completes the Edit step/, workspace);
      assert.match(t, /Save as a draft version — EMG only/, workspace);
      assert.match(html, /<input type="radio" name="then" checked="" value="send"\/>/, `${workspace}: send is the default`);
    }
    const other = render(<ProductionPanel view={view} actor={employeeOther} workspace="EMPLOYEE" hrefs={{ work: '/app/employee/work/w1', content: null, creator: null }} media={configured} />);
    assert.equal(other.includes('data-emg-uploader'), false);
    assert.match(text(other), /This Edit step is assigned to Sam K\./);
    assert.match(other, /loop-state--denied/);
  });

  it('on a creator-review step it waits for the creator by first name and offers no upload', () => {
    const p = production({ currentStep: { ...reviewStep, status: 'ready' }, steps: [{ ...editStep, status: 'completed', completedBy: sam, completedAt: '2026-09-22T16:02:00.000Z' }, { ...reviewStep, status: 'ready' }] });
    const html = render(<ProductionPanel view={{ record: record(p, [version({ id: 'v1', number: 1, label: 'Edit v1', uploadedBy: sam, uploadedByKind: 'EMG' }), original]), production: p }} actor={admin} workspace="ADMIN" hrefs={hrefs} media={configured} />);
    assert.equal(html.includes('data-emg-uploader'), false);
    const t = text(html);
    assert.match(t, /Waiting for Denise\./);
    assert.match(t, /Waiting on Denise/);
    assert.match(t, /Now Creator review — Denise Reyes/);
  });

  it('says when storage is not configured instead of pretending an upload could happen', () => {
    const html = render(<ProductionPanel view={{ record: record(production(), [original]), production: production() }} actor={admin} workspace="ADMIN" hrefs={hrefs} media={notConfigured} />);
    assert.match(html, /loop-state--unavailable/);
    assert.match(text(html), /Uploads are not available on this deployment\. Media storage is not configured for this deployment\./);
    assert.equal(html.includes('type="file"'), false);
  });

  it('marks EMG-only drafts and internal notes, and each comment with its visibility', () => {
    const html = render(<ProductionPanel view={{ record: record(production(), [draft, original]), production: production() }} actor={admin} workspace="ADMIN" hrefs={hrefs} media={configured} />);
    const t = text(html);
    assert.match(t, /Edit v1 EMG-only draft Sam K\. · EMG/);
    assert.match(t, /EMG only colour untouched/);
    assert.match(t, /Original Denise Reyes · creator/);
    assert.match(t, /Sam K\. Internal · Sep 22, 2026, 11:30 AM UTC Rendering from the 4K master\./);
    assert.match(t, /Sam K\. Visible to Denise · Sep 22, 2026, 11:31 AM UTC On it — back to you by noon\./);
    assert.match(html, /<option value="internal" selected="">Internal · EMG only<\/option>/);
    assert.match(html, /href="\/api\/creator\/media\/v1"/);
    assert.equal(nextVersionLabel(record(production(), [draft, original])), 'Edit v2');
    assert.equal(openInstruction(production())?.id, 'i1');
    assert.equal(openInstruction(production({ instructions: [{ ...instruction, answeredByVersionId: 'v1', answeredByVersionLabel: 'Edit v1' }] })), null);
  });

  it('only the ADMIN seat gets the expected-return form; both get the comment form returning to their own page', () => {
    const view = { record: record(production(), [original]), production: production() };
    const adminHtml = render(<ProductionPanel view={view} actor={admin} workspace="ADMIN" hrefs={hrefs} media={configured} />);
    assert.match(adminHtml, /aria-label="Set expected return"/);
    assert.match(adminHtml, /type="datetime-local" name="expectedReturnAt"/);
    const employeeHtml = render(<ProductionPanel view={view} actor={employeeSam} workspace="EMPLOYEE" hrefs={{ work: '/app/employee/work/w1', content: null, creator: null }} media={configured} />);
    assert.equal(employeeHtml.includes('aria-label="Set expected return"'), false);
    assert.match(employeeHtml, /<input type="hidden" name="returnTo" value="\/app\/employee\/work\/w1"\/>/);
    assert.equal(employeeHtml.includes('href="/app/admin/creator-hub'), false, 'an employee gets no link into the ADMIN tree');
    assert.match(text(employeeHtml), /Creator Denise Reyes Content Kona unboxing reel/);
  });

  it('renders a refusal as attention, and a finished production as finished', () => {
    const refused = render(<ProductionPanel view={{ record: record(production(), [original]), production: production() }} actor={admin} workspace="ADMIN" hrefs={hrefs} media={configured} refused="NOT_YOUR_STEP" />);
    assert.match(refused, /loop-state--attention/);
    assert.match(text(refused), /That step is not assigned to you/);
    const finished = production({ workStatus: 'completed', currentStep: null, completedAt: '2026-09-24T09:00:00.000Z' });
    const html = render(<ProductionPanel view={{ record: record(finished, [original]), production: finished }} actor={admin} workspace="ADMIN" hrefs={hrefs} media={configured} />);
    assert.match(text(html), /This production is finished\./);
    assert.equal(html.includes('data-emg-uploader'), false);
    assert.equal(html.includes('aria-label="Set expected return"'), false);
  });
});
