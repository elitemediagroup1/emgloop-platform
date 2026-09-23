// The pure heart of the Creator Hub: the content state derivation never collapses the five
// separate events, requirements are read (never invented), and note validation fails closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveContentState,
  requirementStatuses,
  deliverableComplete,
  deliverableLine,
  creatorActionsFor,
  validateNotes,
  readRequirements,
  DEFAULT_DELIVERABLE_REQUIREMENTS,
  productionStepName,
  formatSeconds,
  type VersionMarks,
} from '../src/creator-hub';

const v = (n: number, over: Partial<VersionMarks> = {}): VersionMarks => ({
  versionId: `v${n}`,
  label: n === 0 ? 'Original' : `Edit v${n}`,
  number: n,
  uploadState: 'READY',
  kind: n === 0 ? 'ORIGINAL' : 'EDIT',
  visibleToCreator: true,
  createdAt: '2026-09-21T10:14:00.000Z',
  approvals: [],
  published: [],
  ...over,
});
const REQ = DEFAULT_DELIVERABLE_REQUIREMENTS;
const BRAND = [...REQ.slice(0, 2), { key: 'brand' as const, label: "Kona's approval", required: true }, REQ[2]!];

test('RAW: an original with nothing else', () => {
  assert.equal(deriveContentState({ versions: [v(0)], productions: [], requirements: REQ }), 'RAW');
  assert.equal(deriveContentState({ versions: [], productions: [], requirements: REQ }), 'RAW');
});

test('the active production decides IN_PRODUCTION / YOUR_REVIEW / CHANGES_REQUESTED', () => {
  const p = (kind: 'EDIT' | 'REVIEW', round: number) => [{ number: 1, workStatus: 'active' as const, currentStep: { kind, round, status: 'ready' } }];
  assert.equal(deriveContentState({ versions: [v(0)], productions: p('EDIT', 1), requirements: REQ }), 'IN_PRODUCTION');
  assert.equal(deriveContentState({ versions: [v(0), v(1)], productions: p('REVIEW', 1), requirements: REQ }), 'YOUR_REVIEW');
  assert.equal(deriveContentState({ versions: [v(0), v(1)], productions: p('EDIT', 2), requirements: REQ }), 'CHANGES_REQUESTED');
});

test('creator approval is not finality: APPROVED_BY_YOU until every required approval is on the SAME version', () => {
  const creatorOnly = v(2, { approvals: [{ requirementKey: 'creator', approverKind: 'CREATOR', by: 'u1', at: 'x' }] });
  const done = [{ number: 1, workStatus: 'completed' as const, currentStep: null }];
  assert.equal(deriveContentState({ versions: [v(0), v(1), creatorOnly], productions: done, requirements: BRAND }), 'APPROVED_BY_YOU');
  const all = v(3, {
    approvals: [
      { requirementKey: 'creator', approverKind: 'CREATOR', by: 'u1', at: 'x' },
      { requirementKey: 'emg', approverKind: 'EMG', by: 'u2', at: 'x' },
      { requirementKey: 'brand', approverKind: 'BRAND_RELAYED', by: 'u2', at: 'x' },
    ],
  });
  assert.equal(deriveContentState({ versions: [v(0), creatorOnly, all], productions: done, requirements: BRAND }), 'FINAL');
  // A newer version inherits nothing: the marks on v3 do not make v4 final.
  assert.equal(deriveContentState({ versions: [v(0), all, v(4)], productions: done, requirements: BRAND }), 'RAW');
  // Independent content: the creator's approval is the only approval, so it IS final.
  assert.equal(deriveContentState({ versions: [v(0), creatorOnly], productions: done, requirements: [REQ[0]!] }), 'FINAL');
});

test('PUBLISHED needs a publication mark; a draft (EMG-only) version never decides the creator state', () => {
  const pub = v(2, { published: [{ platform: 'INSTAGRAM', at: 'x' }] });
  assert.equal(deriveContentState({ versions: [v(0), pub], productions: [], requirements: REQ }), 'PUBLISHED');
  const draft = v(3, { visibleToCreator: false, approvals: [{ requirementKey: 'creator', approverKind: 'CREATOR', by: 'u', at: 'x' }] });
  assert.equal(deriveContentState({ versions: [v(0), draft], productions: [], requirements: [REQ[0]!] }), 'RAW');
});

test('requirements are read from the deliverable and reported per version; complete only when all required are met', () => {
  const version = v(3, {
    approvals: [
      { requirementKey: 'creator', approverKind: 'CREATOR', by: 'Denise', at: '2026-09-24T16:00:00Z' },
      { requirementKey: 'emg', approverKind: 'EMG', by: 'Priya', at: '2026-09-24T16:30:00Z' },
    ],
  });
  const statuses = requirementStatuses(REQ, version, (a) => a.by);
  assert.deepEqual(statuses.map((s) => [s.key, s.met, s.by]), [['creator', true, 'Denise'], ['emg', true, 'Priya'], ['published', false, null]]);
  assert.equal(deliverableComplete(statuses), false);
  const published = requirementStatuses(REQ, { ...version, published: [{ platform: 'INSTAGRAM', at: 'y' }] }, (a) => a.by);
  assert.equal(deliverableComplete(published), true);
  assert.equal(deliverableComplete(requirementStatuses(REQ, null, (a) => a.by)), false);
  assert.deepEqual(readRequirements([{ key: 'brand', label: 'Kona', required: true }, { key: 'nope' }]), [{ key: 'brand', label: 'Kona', required: true }]);
});

test('the deliverable line and the creator actions follow state and context, never a page', () => {
  assert.equal(deliverableLine('APPROVED_BY_YOU', false), 'Content approved');
  assert.equal(deliverableLine('FINAL', false), 'Final approved');
  assert.equal(deliverableLine('PUBLISHED', true), 'Complete');
  const campaign = creatorActionsFor({ state: 'RAW', hasDeliverable: true, acceptsUnedited: false, hasReadyOriginal: true });
  assert.deepEqual(campaign, { requestEdit: true, submitOriginalForApproval: false, publishAsIs: false, review: false, markPublished: false });
  const independent = creatorActionsFor({ state: 'RAW', hasDeliverable: false, acceptsUnedited: false, hasReadyOriginal: true });
  assert.equal(independent.publishAsIs, true);
  const unedited = creatorActionsFor({ state: 'RAW', hasDeliverable: true, acceptsUnedited: true, hasReadyOriginal: true });
  assert.equal(unedited.submitOriginalForApproval, true);
  assert.equal(creatorActionsFor({ state: 'YOUR_REVIEW', hasDeliverable: true, acceptsUnedited: false, hasReadyOriginal: true }).review, true);
  assert.equal(creatorActionsFor({ state: 'FINAL', hasDeliverable: true, acceptsUnedited: false, hasReadyOriginal: true }).markPublished, true);
  assert.equal(creatorActionsFor({ state: 'IN_PRODUCTION', hasDeliverable: true, acceptsUnedited: false, hasReadyOriginal: true }).requestEdit, false);
});

test('notes: validated, sorted, fail closed', () => {
  const ok = validateNotes([
    { id: 'b', atSeconds: 11, kind: 'KEEP', text: 'Keep this beat.' },
    { id: 'a', atSeconds: 2.04, untilSeconds: 6, kind: 'CHANGE', text: 'Kona before the logo.' },
  ], 41);
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.notes.map((n) => [n.id, n.atSeconds]), [['a', 2], ['b', 11]]);
  const bad = validateNotes([{ id: 'x', atSeconds: -1, kind: 'MAYBE', text: '' }, { id: 'x', atSeconds: 99, kind: 'KEEP', text: 'late' }], 41);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(bad.refusals.sort(), ['BAD_KIND', 'BAD_TIMESTAMP', 'DUPLICATE_ID', 'EMPTY_TEXT'].sort());
  assert.equal(productionStepName('Edit', 1), 'Edit');
  assert.equal(productionStepName('Creator review', 2), 'Creator review · round 2');
  assert.equal(formatSeconds(71.9), '1:11');
});
