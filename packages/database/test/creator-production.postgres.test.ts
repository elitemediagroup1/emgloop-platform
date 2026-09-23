// The Creator Hub's canonical production path against a REAL Postgres (2026-09-22).
//
// OPT-IN AND LOCAL ONLY. Runs only when LOOP_TEST_POSTGRES_URL is set, and refuses any URL
// whose host is not localhost or 127.0.0.1 -- it creates rows and must never be pointed at a
// shared or production database. Run it against a disposable container with the migrations
// applied (work-state.postgres.test.ts has the container recipe):
//
//   LOOP_TEST_POSTGRES_URL=postgresql://postgres:verify@127.0.0.1:55432/postgres \
//     npx tsx --test test/creator-production.postgres.test.ts
//
// WHAT IT PROVES, THAT THE IN-MEMORY DOUBLES CANNOT. The whole path -- profile, campaign,
// deliverable, Original, request edit, return for review, request changes (a further round
// APPENDED to the same work item), approve, EMG and relayed brand approvals, publish, and a
// brand's feedback after completion starting Production 2 -- runs through the REAL
// CreatorRepository, CrmCommercialRepository, WorkRepository and both services over the
// migration's unique keys, foreign keys and cascades, and both seats read their projections
// back from the same rows. Every refusal is exercised the way a page would hit it: another
// organization's rows are not found, another creator's content is not found, and the wrong
// step is NOT_YOUR_STEP -- never "forbidden", which would confirm the row exists.
//
// Work OS tables (blueprints, work_instances, work_assignments) carry organizationId with no
// foreign key, so this file removes them itself before the organization row cascades the rest.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { MEDIA_KEY_PREFIX } from '@emgloop/providers';
import type { InstructionNote } from '@emgloop/shared';
import { WorkRepository } from '../src/repositories/work.repository';
import { createCreatorDomain, type CreatorActor, type EmgActor, type ProductionResult } from '../src/creator';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

type Role = 'OWNER' | 'ADMIN' | 'EMPLOYEE' | 'CREATOR';

/** An organization with ACTIVE memberships: one User row and one OrganizationMembership row per person. */
async function tenant<K extends string>(prisma: PrismaClient, label: string, people: readonly { key: K; role: Role; name: string }[]) {
  const organizationId = `org_ch_${label}_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: `Creator Hub ${label}`, slug: organizationId } });
  const users = {} as Record<K, string>;
  for (const p of people) {
    const userId = `user_ch_${label}_${p.key}_${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: p.name, status: 'ACTIVE', metadata: { systemRole: p.role } } });
    await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: p.role, status: 'ACTIVE' } });
    users[p.key] = userId;
  }
  return { organizationId, users };
}

/** Work OS rows have no organization FK: remove them first, then let the organization cascade the creator domain. */
async function removeTenant(prisma: PrismaClient, organizationId: string): Promise<void> {
  const instances = await prisma.workInstance.findMany({ where: { organizationId }, select: { id: true } });
  if (instances.length > 0) await prisma.workAssignment.deleteMany({ where: { workInstanceId: { in: instances.map((i) => i.id) } } });
  await prisma.workInstance.deleteMany({ where: { organizationId } });
  await prisma.blueprint.deleteMany({ where: { organizationId } });
  await prisma.organization.deleteMany({ where: { id: organizationId } });
}

function ok<T>(result: ProductionResult<T>, what: string): T {
  if (!result.ok) assert.fail(`${what}: refused ${result.reason}${result.detail ? ` (${result.detail})` : ''}`);
  return result.value;
}

function refused<T>(result: ProductionResult<T>, reason: string, what: string): void {
  assert.equal(result.ok, false, `${what}: expected a refusal, got ok`);
  if (!result.ok) assert.equal(result.reason, reason, what);
}

async function refusedByDb(promise: Promise<unknown>, what: string): Promise<void> {
  await assert.rejects(promise, (err: any) => {
    const text = `${err?.code ?? ''} ${err?.meta?.code ?? ''} ${err?.message ?? ''}`;
    assert.ok(/P2002|P2003|23503|23505|violates/i.test(text), `${what}: got ${text.slice(0, 160)}`);
    return true;
  }, what);
}

/** Sequential subtests over shared state: once one fails, the rest are skipped rather than failing on its wreckage. */
function sequential(t: TestContext) {
  let failed = false;
  return async (name: string, fn: () => Promise<void>): Promise<void> => {
    await t.test(name, { skip: failed ? 'an earlier step failed' : false }, async () => {
      try {
        await fn();
      } catch (err) {
        failed = true;
        throw err;
      }
    });
  };
}

const REQUIREMENTS = [
  { key: 'creator', label: 'Your approval', required: true },
  { key: 'emg', label: 'EMG approval', required: true },
  { key: 'brand', label: 'Brand approval', required: true },
  { key: 'published', label: 'Published', required: true },
];
const NOTE_1: InstructionNote = { id: 'n1', atSeconds: 2, kind: 'CHANGE', text: 'Kona before the logo' };
const NOTE_2: InstructionNote = { id: 'n2', atSeconds: 11, kind: 'KEEP', text: 'Keep this beat' };
const HREFS = { content: (id: string) => `/app/creator/content/${id}`, profile: '/app/creator/profile' };

test('the canonical production path: request, return, request changes, approve, finalize, publish, then brand feedback after completion', { skip }, async (t) => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const work = new WorkRepository(prisma);
  const domain = createCreatorDomain(prisma, work);
  const step = sequential(t);
  const organizations: string[] = [];
  try {
    const home = await tenant(prisma, 'path', [
      { key: 'owner', role: 'OWNER', name: 'Matt Owner' },
      { key: 'editor', role: 'EMPLOYEE', name: 'Eve Editor' },
      { key: 'colleague', role: 'EMPLOYEE', name: 'Cal Colleague' },
      { key: 'creator', role: 'CREATOR', name: 'Kona Reyes' },
      { key: 'creator2', role: 'CREATOR', name: 'Nia Other' },
    ] as const);
    const away = await tenant(prisma, 'other', [{ key: 'owner', role: 'OWNER', name: 'Away Owner' }] as const);
    organizations.push(home.organizationId, away.organizationId);
    const organizationId = home.organizationId;
    const { owner, editor, colleague, creator: creatorUser, creator2 } = home.users;
    const emg = (userId: string, canActOnAnyStep: boolean): EmgActor => ({ organizationId, userId, canActOnAnyStep });
    const awayEmg: EmgActor = { organizationId: away.organizationId, userId: away.users.owner, canActOnAnyStep: true };
    const emgSeat = { kind: 'EMG' as const, organizationId };

    // Filled in by the steps below, in order.
    let profileId = '';
    let otherProfileId = '';
    let partyId = '';
    let campaignId = '';
    let deliverableId = '';
    let openDeliverableId = '';
    let contentId = '';
    let v0 = '';
    let v1 = '';
    let v2 = '';
    let wid1 = '';
    let wid2 = '';
    let instruction1 = '';
    const requestedReturnAt = new Date('2026-10-01T12:00:00.000Z');
    const expectedReturnAt = new Date('2026-09-29T17:00:00.000Z');
    const creatorActor = (): CreatorActor => ({ organizationId, userId: creatorUser, creatorProfileId: profileId });
    const otherCreatorActor = (): CreatorActor => ({ organizationId, userId: creator2, creatorProfileId: otherProfileId });
    const creatorSeat = () => ({ kind: 'CREATOR' as const, actor: creatorActor() });

    await step('the creator seat, the campaign and its deliverables, the content and its Original', async () => {
      partyId = `party_test_${randomUUID()}`;
      const profile = await domain.creator.createProfile({ organizationId, partyId, userId: creatorUser, displayName: 'Kona Reyes', handle: 'kona', createdByUserId: owner });
      profileId = profile.id;
      assert.equal(profile.payoutState, 'NOT_SET_UP');
      assert.equal(profile.defaultEditorUserId, null);
      const other = await domain.creator.createProfile({ organizationId, partyId: `party_test_${randomUUID()}`, userId: creator2, displayName: 'Nia Other', createdByUserId: owner });
      otherProfileId = other.id;
      assert.equal((await domain.creator.profileForUser(organizationId, creatorUser))?.id, profileId);
      assert.equal(await domain.creator.profileForUser(away.organizationId, creatorUser), null, 'a profile is resolved within its organization');

      const campaign = await domain.commercial.createCampaign({ organizationId, name: 'Spring launch', creatorPartyId: partyId, createdByUserId: owner, state: 'ACTIVE', brandLabel: 'Kona Coffee', brandVisibleToCreator: true, creatorBrief: 'One reel, one story.', termsSummary: 'Net 30' });
      campaignId = campaign.id;
      const dueAt = new Date(Date.now() + 2 * 86400_000);
      const deliverable = await domain.commercial.declareDeliverable({ organizationId, campaignId, creatorPartyId: partyId, title: 'Launch reel', deliverableType: 'REEL', dueAt, requirements: REQUIREMENTS, createdByUserId: owner });
      deliverableId = deliverable.id;
      assert.equal(deliverable.status, 'OPEN');
      assert.equal(deliverable.contentId, null);
      const open = await domain.commercial.declareDeliverable({ organizationId, campaignId, creatorPartyId: partyId, title: 'Behind the scenes', deliverableType: 'STORY', dueAt, createdByUserId: owner });
      openDeliverableId = open.id;

      const content = await domain.creator.createContent({ organizationId, creatorProfileId: profileId, title: 'Launch reel cut', kind: 'VIDEO', campaignId, deliverableId, createdByUserId: creatorUser });
      contentId = content.id;
      // The upload route attaches the content to its deliverable at creation; the path here does the same.
      assert.equal((await domain.commercial.attachDeliverableContent(organizationId, deliverableId, contentId))?.contentId, contentId);
      assert.equal(await domain.commercial.attachDeliverableContent(away.organizationId, deliverableId, contentId), null, 'another organization cannot attach content');

      const original = await domain.creator.beginVersion({ organizationId, contentId, kind: 'ORIGINAL', contentType: 'video/mp4', fileName: 'raw.mp4', uploadedByUserId: creatorUser, uploadedByKind: 'CREATOR' });
      v0 = original.id;
      assert.equal(original.number, 0);
      assert.equal(original.label, 'Original');
      assert.equal(original.uploadState, 'PENDING');
      assert.equal(original.visibleToCreator, true);
      assert.ok(
        original.storageKey.startsWith(`${MEDIA_KEY_PREFIX}${organizationId.toLowerCase()}/${profileId.toLowerCase()}/${contentId.toLowerCase()}/`),
        `the storage key is built from ids the repository owns: ${original.storageKey}`,
      );
      assert.ok(original.storageKey.endsWith(`/${v0.toLowerCase()}.mp4`), `the key ends in the version id and the media extension: ${original.storageKey}`);
      await assert.rejects(
        domain.creator.beginVersion({ organizationId, contentId, kind: 'ORIGINAL', contentType: 'video/mp4', uploadedByUserId: creatorUser, uploadedByKind: 'CREATOR' }),
        /one Original/,
        'a piece of content has one Original',
      );
      await assert.rejects(
        domain.creator.beginVersion({ organizationId: away.organizationId, contentId, kind: 'EDIT', contentType: 'video/mp4', uploadedByUserId: creatorUser, uploadedByKind: 'CREATOR' }),
        /Content not found/,
        'another organization cannot add a version',
      );

      const pending = await domain.records.contentRecord(creatorSeat(), contentId);
      assert.equal(pending?.state, 'RAW');
      assert.equal(pending?.actions.requestEdit, false, 'nothing to edit until the Original is READY');
      refused(await domain.productions.requestEdit(creatorActor(), { contentId, sourceVersionId: v0, summary: 'x', notes: [], requestedReturnAt: null }), 'VERSION_NOT_READY', 'requestEdit on a PENDING Original');

      const ready = await domain.creator.markVersionReady(organizationId, v0, { byteSize: 4096, durationSeconds: 30, width: 1080, height: 1920 });
      assert.equal(ready?.uploadState, 'READY');
      assert.ok(ready?.readyAt);
      assert.equal(await domain.creator.markVersionReady(away.organizationId, v0, { byteSize: 1 }), null, 'another organization cannot mark a version ready');
      const raw = await domain.records.contentRecord(creatorSeat(), contentId);
      assert.equal(raw?.state, 'RAW');
      assert.equal(raw?.actions.requestEdit, true);
      assert.equal(raw?.actions.submitOriginalForApproval, false, 'the deliverable does not accept an unedited Original');
      assert.equal(raw?.context.deliverable?.line, 'awaiting content');
      refused(await domain.productions.submitOriginalForApproval(creatorActor(), { contentId }), 'NOT_ALLOWED', 'ruling 3 needs the deliverable to permit it');
    });

    await step('the creator requests an edit: a Work OS work item with Edit and Creator review, Production 1, instruction set 1', async () => {
      refused(await domain.productions.requestEdit(creatorActor(), { contentId, sourceVersionId: v0, summary: '   ', notes: [], requestedReturnAt: null }), 'INVALID', 'a request must say what to change');
      refused(await domain.productions.requestEdit(otherCreatorActor(), { contentId, sourceVersionId: v0, summary: 'x', notes: [], requestedReturnAt: null }), 'NOT_FOUND', "another creator's content is not found, never forbidden");
      const result = ok(await domain.productions.requestEdit(creatorActor(), { contentId, sourceVersionId: v0, summary: 'Tighten the opening', notes: [NOTE_1], requestedReturnAt }), 'requestEdit');
      wid1 = result.workInstanceId;
      instruction1 = result.instructionId;

      const instance = await work.getWorkInstance(organizationId, wid1);
      assert.ok(instance, 'the work item exists in the organization');
      assert.equal(instance.status, 'active');
      assert.equal(instance.title, 'Production 1 · Launch reel cut');
      assert.equal(instance.createdByUserId, creatorUser);
      assert.deepEqual(instance.stages.map((s) => s.name), ['Edit', 'Creator review']);
      assert.deepEqual(instance.stages.map((s) => s.position), [1, 2]);
      const edit = instance.stages[0]!;
      const review = instance.stages[1]!;
      assert.equal(edit.status, 'ready');
      assert.equal(edit.ownerUserId, null, 'no default editor: the Edit step waits for an owner');
      assert.equal(review.status, 'pending');
      assert.equal(review.ownerUserId, null, 'the review step is owned by nobody until it becomes current');
      assert.equal(instance.currentStageId, edit.id);
      assert.equal(instance.requestedReturnAt?.getTime(), requestedReturnAt.getTime(), "the requester's date is on the work item");
      assert.equal(instance.expectedReturnAt, null, 'a request is never an EMG commitment');
      assert.equal(await work.getWorkInstance(away.organizationId, wid1), null, 'another organization does not find the work item');

      const productions = await prisma.contentProduction.findMany({ where: { contentId }, orderBy: { number: 'asc' } });
      assert.equal(productions.length, 1);
      assert.equal(productions[0]?.id, result.productionId);
      assert.equal(productions[0]?.number, 1);
      assert.equal(productions[0]?.kind, 'EDIT');
      assert.equal(productions[0]?.workInstanceId, wid1);
      assert.equal(productions[0]?.sourceVersionId, v0);
      assert.equal(productions[0]?.requestedByUserId, creatorUser);
      assert.equal(productions[0]?.requestedReturnAt?.getTime(), requestedReturnAt.getTime());
      assert.equal(productions[0]?.completedAt, null);

      const instructions = await work.listInstructions(organizationId, wid1);
      assert.equal(instructions.length, 1);
      const first = instructions[0]!;
      assert.equal(first.id, instruction1);
      assert.equal(first.sequence, 1);
      assert.equal(first.originatorKind, 'CREATOR');
      assert.equal(first.originatorLabel, null);
      assert.equal(first.enteredByUserId, creatorUser);
      assert.equal(first.refersToVersionId, v0);
      assert.equal(first.summary, 'Tighten the opening');
      assert.deepEqual(first.notes, [NOTE_1]);
      assert.equal(first.workStageId, edit.id);
      assert.equal(first.requestedReturnAt?.getTime(), requestedReturnAt.getTime());
      assert.equal(first.answeredByVersionId, null);
      assert.equal(first.visibleToCreator, true);
      assert.deepEqual(await work.listInstructions(away.organizationId, wid1), [], 'instruction sets are listed within the organization');

      const types = await work.listWorkTypes(organizationId);
      assert.equal(types.filter((w) => w.catalogKey === 'creator-production').length, 1, 'one Creator production work type per organization');

      refused(await domain.productions.requestEdit(creatorActor(), { contentId, sourceVersionId: v0, summary: 'again', notes: [], requestedReturnAt: null }), 'PRODUCTION_ACTIVE', 'a second request while one is in production');
      refused(await domain.productions.requestChanges(creatorActor(), { contentId, summary: 'x', notes: [], requestedReturnAt: null }), 'NOT_YOUR_STEP', 'request changes while the work is on the Edit step');
      const record = await domain.records.contentRecord(creatorSeat(), contentId);
      assert.equal(record?.state, 'IN_PRODUCTION');
      assert.equal(record?.actions.requestEdit, false);
      assert.equal(record?.activeProduction?.number, 1);
      assert.equal(record?.activeProduction?.currentStep?.kind, 'EDIT');
      assert.equal(record?.activeProduction?.currentStep?.round, 1);
      assert.equal(record?.activeProduction?.requestedReturnAt, requestedReturnAt.toISOString());
      assert.equal(record?.activeProduction?.expectedReturnAt, null);
      assert.equal(record?.context.deliverable?.line, 'in production');
    });

    await step('EMG assigns the editor, commits an expected return, uploads a hidden edit and returns it for review', async () => {
      const edit = (await work.getWorkInstance(organizationId, wid1))!.stages[0]!;
      await work.assignStage({ organizationId, workStageId: edit.id, userId: editor, assignedByUserId: owner });

      ok(await domain.productions.setExpectedReturn(emg(owner, true), { workInstanceId: wid1, expectedReturnAt }), 'setExpectedReturn');
      refused(await domain.productions.setExpectedReturn(awayEmg, { workInstanceId: wid1, expectedReturnAt }), 'NOT_FOUND', 'another organization setting the expected return');
      const committed = await work.getWorkInstance(organizationId, wid1);
      assert.equal(committed?.expectedReturnAt?.getTime(), expectedReturnAt.getTime());
      assert.equal(committed?.expectedReturnSetByUserId, owner);
      assert.ok(committed?.expectedReturnSetAt);
      assert.equal(committed?.requestedReturnAt?.getTime(), requestedReturnAt.getTime(), 'the request is untouched by the commitment');

      const hidden = await domain.creator.beginVersion({ organizationId, contentId, kind: 'EDIT', contentType: 'video/mp4', fileName: 'cut-v1.mp4', uploadedByUserId: editor, uploadedByKind: 'EMG', visibleToCreator: false, internalNote: 'Colour pass still rough' });
      v1 = hidden.id;
      assert.equal(hidden.number, 1);
      assert.equal(hidden.label, 'Edit v1');
      assert.equal(hidden.visibleToCreator, false);
      assert.equal(hidden.producedByWorkInstanceId, null);
      refused(await domain.productions.returnVersionForReview(emg(editor, false), { workInstanceId: wid1, versionId: v1, noteToCreator: null, addressed: [] }), 'VERSION_NOT_READY', 'returning a version whose bytes are not confirmed');
      await domain.creator.markVersionReady(organizationId, v1, { byteSize: 8192, durationSeconds: 28 });

      const unseen = await domain.records.contentRecord(creatorSeat(), contentId);
      assert.equal(unseen?.versions.some((v) => v.id === v1), false, 'a saved-but-not-sent edit is invisible to the creator');
      assert.equal(unseen?.state, 'IN_PRODUCTION');
      assert.equal((await domain.records.contentRecord(emgSeat, contentId))?.versions.some((v) => v.id === v1), true, 'EMG sees it');

      refused(await domain.productions.returnVersionForReview(emg(colleague, false), { workInstanceId: wid1, versionId: v1, noteToCreator: 'x', addressed: [] }), 'NOT_YOUR_STEP', 'an employee who does not own the Edit step');
      refused(await domain.productions.returnVersionForReview(awayEmg, { workInstanceId: wid1, versionId: v1, noteToCreator: 'x', addressed: [] }), 'NOT_FOUND', 'another organization returning a version');
      refused(await domain.productions.returnVersionForReview(emg(editor, false), { workInstanceId: wid1, versionId: v0, noteToCreator: 'x', addressed: [] }), 'INVALID', 'only an edit can be returned');

      ok(await domain.productions.returnVersionForReview(emg(editor, false), { workInstanceId: wid1, versionId: v1, noteToCreator: 'Cut the intro', addressed: [{ noteId: 'n1', addressed: true, reply: 'done' }] }), 'returnVersionForReview');

      const version = await domain.creator.getVersion(organizationId, v1);
      assert.equal(version?.visibleToCreator, true);
      assert.equal(version?.producedByWorkInstanceId, wid1);
      assert.equal(version?.answersInstructionId, instruction1);
      assert.equal(version?.noteToCreator, 'Cut the intro');
      assert.equal(version?.internalNote, 'Colour pass still rough');

      const instructions = await work.listInstructions(organizationId, wid1);
      assert.equal(instructions[0]?.answeredByVersionId, v1);
      assert.ok(instructions[0]?.answeredAt);
      assert.deepEqual(instructions[0]?.addressed, [{ noteId: 'n1', addressed: true, reply: 'done' }]);

      const instance = await work.getWorkInstance(organizationId, wid1);
      assert.ok(instance);
      const editNow = instance.stages[0]!;
      const reviewNow = instance.stages[1]!;
      assert.equal(editNow.status, 'completed');
      assert.equal(editNow.completedByUserId, editor);
      assert.equal(reviewNow.status, 'ready');
      assert.equal(reviewNow.ownerUserId, creatorUser, "the review step is owned by the creator's own login");
      assert.equal(instance.currentStageId, reviewNow.id);
      const notifications = await prisma.workNotification.findMany({ where: { organizationId, userId: creatorUser, workInstanceId: wid1, workStageId: reviewNow.id } });
      assert.equal(notifications.length, 1, 'the creator is told their step is ready');
      assert.equal(notifications[0]?.type, 'next_action_ready');
    });

    await step('both seats read the same rows: YOUR_REVIEW, the note to the creator on both, the internal note on EMG only', async () => {
      const mine = await domain.records.contentRecord(creatorSeat(), contentId);
      assert.ok(mine);
      assert.equal(mine.seat, 'CREATOR');
      assert.equal(mine.state, 'YOUR_REVIEW');
      assert.equal(mine.stateLabel, 'Ready for your review');
      assert.deepEqual(mine.versions.map((v) => v.id), [v0, v1]);
      const v1Mine = mine.versions.find((v) => v.id === v1)!;
      assert.equal(v1Mine.noteToCreator, 'Cut the intro');
      assert.equal(v1Mine.internalNote, null, 'an internal note never reaches the creator seat');
      assert.equal(v1Mine.uploadedBy?.name, 'Eve', 'EMG staff by first name on the creator seat');
      assert.equal(v1Mine.producedByWorkInstanceId, wid1);
      assert.equal(mine.latestVersion?.id, v1);
      assert.equal(mine.actions.review, true);
      assert.equal(mine.actions.requestEdit, false);
      assert.equal(mine.activeProduction?.currentStep?.kind, 'REVIEW');
      assert.equal(mine.activeProduction?.currentStep?.round, 1);
      assert.equal(mine.activeProduction?.currentStep?.owner?.userId, creatorUser);
      assert.equal(mine.activeProduction?.expectedReturnAt, expectedReturnAt.toISOString());
      assert.equal(mine.activeProduction?.instructions[0]?.answeredByVersionLabel, 'Edit v1');
      assert.equal(mine.activeProduction?.instructions[0]?.refersToVersionLabel, 'Original');
      assert.equal(mine.context.campaign?.brandLabel, 'Kona Coffee', 'the brand is designated visible');
      assert.equal(mine.context.deliverable?.line, 'awaiting your approval');
      assert.equal(mine.context.deliverable?.complete, false);
      assert.deepEqual(mine.requirements.map((r) => r.key), ['creator', 'emg', 'brand', 'published']);

      const theirs = await domain.records.contentRecord(emgSeat, contentId);
      assert.ok(theirs);
      assert.equal(theirs.seat, 'EMG');
      assert.equal(theirs.state, 'YOUR_REVIEW');
      const v1Theirs = theirs.versions.find((v) => v.id === v1)!;
      assert.equal(v1Theirs.noteToCreator, 'Cut the intro');
      assert.equal(v1Theirs.internalNote, 'Colour pass still rough');
      assert.equal(v1Theirs.uploadedBy?.name, 'Eve Editor', 'full names on the EMG seat');
      assert.equal(theirs.activeProduction?.expectedReturnSetBy?.userId, owner);

      assert.equal(await domain.records.contentRecord({ kind: 'EMG', organizationId: away.organizationId }, contentId), null, 'another organization: not found');
      assert.equal(await domain.records.contentRecord({ kind: 'CREATOR', actor: otherCreatorActor() }, contentId), null, 'another creator in the same organization: not found');

      const tasks = await domain.records.tasks(creatorActor(), HREFS);
      const review = tasks.find((x) => x.kind === 'REVIEW');
      assert.ok(review, 'a REVIEW task while the content awaits the creator');
      assert.equal(review.bucket, 'NEEDS_ATTENTION');
      assert.equal(review.href, `${HREFS.content(contentId)}?review=${v1}`);
      assert.equal(tasks.find((x) => x.key === `deliverable:${deliverableId}`)?.kind, 'DELIVERABLE', 'a deliverable with content attached is a DELIVERABLE task');
      assert.equal(tasks.find((x) => x.key === `deliverable:${openDeliverableId}`)?.kind, 'UPLOAD', 'a deliverable with no content is an UPLOAD task');
      assert.deepEqual(tasks.filter((x) => x.kind === 'SETUP').map((x) => x.key).sort(), ['setup:payout', 'setup:social']);
      const otherTasks = await domain.records.tasks(otherCreatorActor(), HREFS);
      assert.equal(otherTasks.some((x) => x.kind === 'REVIEW' || x.kind === 'DELIVERABLE' || x.kind === 'UPLOAD'), false, "another creator sees none of this creator's work");

      const roster = await domain.records.roster(organizationId);
      const row = roster.find((r) => r.profile.id === profileId);
      assert.ok(row);
      assert.equal(row.needsCreator, 1);
      assert.equal(row.needsEmg, 0);
      assert.equal(row.inProduction, 1);
      assert.equal(row.contentCount, 1);
      assert.equal(row.dueSoon, 2, 'both OPEN deliverables are due within seven days');
      const otherRow = roster.find((r) => r.profile.id === otherProfileId);
      assert.deepEqual([otherRow?.needsCreator, otherRow?.needsEmg, otherRow?.inProduction, otherRow?.contentCount, otherRow?.dueSoon], [0, 0, 0, 0, 0]);
      assert.equal((await domain.records.roster(away.organizationId)).length, 0);

      const requests = await domain.records.requests(organizationId);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.needs, 'CREATOR');
      assert.equal(requests[0]?.contentId, contentId);
      assert.equal(requests[0]?.contentTitle, 'Launch reel cut');
      assert.equal(requests[0]?.production.number, 1);
      assert.equal(requests[0]?.creator.id, profileId);
      assert.deepEqual(await domain.records.requests(away.organizationId), []);
    });

    await step('the creator requests changes: round 2 is APPENDED to the same work item; the editor who returned v1 owns the next Edit', async () => {
      refused(await domain.productions.requestChanges(creatorActor(), { contentId, summary: null, notes: [], requestedReturnAt: null }), 'INVALID', 'nothing said');
      refused(await domain.productions.requestChanges(otherCreatorActor(), { contentId, summary: null, notes: [NOTE_2], requestedReturnAt: null }), 'NOT_FOUND', 'another creator');
      const result = ok(await domain.productions.requestChanges(creatorActor(), { contentId, summary: null, notes: [NOTE_2], requestedReturnAt: null }), 'requestChanges');
      assert.equal(result.workInstanceId, wid1, 'the SAME work item continues');
      assert.equal(result.round, 2);

      const instance = await work.getWorkInstance(organizationId, wid1);
      assert.ok(instance);
      assert.equal(instance.status, 'active');
      assert.deepEqual(instance.stages.map((s) => s.name), ['Edit', 'Creator review', 'Edit · round 2', 'Creator review · round 2']);
      assert.deepEqual(instance.stages.map((s) => s.position), [1, 2, 3, 4]);
      const s1 = instance.stages[0]!;
      const s2 = instance.stages[1]!;
      const s3 = instance.stages[2]!;
      const s4 = instance.stages[3]!;
      assert.equal(s1.status, 'completed', 'nothing already recorded is touched');
      assert.equal(s1.completedByUserId, editor);
      assert.equal(s2.status, 'completed');
      assert.equal(s2.completedByUserId, creatorUser);
      assert.equal(s3.status, 'ready');
      assert.equal(s3.ownerUserId, editor, 'the next round goes back to whoever returned the last version');
      assert.ok(s3.startedAt);
      assert.equal(s4.status, 'pending');
      assert.equal(s4.ownerUserId, null);
      assert.equal(instance.currentStageId, s3.id);
      assert.equal(await prisma.contentProduction.count({ where: { contentId } }), 1, 'still one production');
      assert.equal((await prisma.workNotification.findMany({ where: { organizationId, userId: editor, workInstanceId: wid1, workStageId: s3.id } })).length, 1, 'the editor is told round 2 is theirs');

      const instructions = await work.listInstructions(organizationId, wid1);
      assert.equal(instructions.length, 2);
      const second = instructions[1]!;
      assert.equal(second.sequence, 2);
      assert.equal(second.originatorKind, 'CREATOR');
      assert.equal(second.enteredByUserId, creatorUser);
      assert.equal(second.refersToVersionId, v1, 'the notes are about the version just reviewed');
      assert.equal(second.summary, null);
      assert.deepEqual(second.notes, [NOTE_2]);
      assert.equal(second.workStageId, s2.id);
      assert.equal(second.answeredByVersionId, null);
      assert.equal(instructions[0]?.answeredByVersionId, v1, 'set 1 keeps its answer');

      const record = await domain.records.contentRecord(creatorSeat(), contentId);
      assert.equal(record?.state, 'CHANGES_REQUESTED');
      assert.equal(record?.context.deliverable?.line, 'in production again');
      assert.equal(record?.activeProduction?.steps.length, 4);
      assert.equal(record?.activeProduction?.currentStep?.round, 2);
      assert.equal(record?.activeProduction?.steps[1]?.note, 'Changes requested');
      assert.equal((await domain.records.tasks(creatorActor(), HREFS)).some((x) => x.kind === 'REVIEW'), false, 'no review task while EMG has the work');
      const roster = (await domain.records.roster(organizationId)).find((r) => r.profile.id === profileId);
      assert.equal(roster?.needsEmg, 1);
      assert.equal(roster?.needsCreator, 0);
    });

    await step('the editor returns v2 answering set 2; the creator approves it: the mark is on v2 only, the work item and production complete, the deliverable stays OPEN', async () => {
      const edit2 = await domain.creator.beginVersion({ organizationId, contentId, kind: 'EDIT', contentType: 'video/mp4', fileName: 'cut-v2.mp4', uploadedByUserId: editor, uploadedByKind: 'EMG', visibleToCreator: false });
      v2 = edit2.id;
      assert.equal(edit2.number, 2);
      assert.equal(edit2.label, 'Edit v2');
      await domain.creator.markVersionReady(organizationId, v2, { byteSize: 8000, durationSeconds: 27 });
      ok(await domain.productions.returnVersionForReview(emg(editor, false), { workInstanceId: wid1, versionId: v2, noteToCreator: 'Kept the beat at 0:11', addressed: [{ noteId: 'n2', addressed: true, reply: 'kept' }] }), 'return v2');
      const instructions = await work.listInstructions(organizationId, wid1);
      assert.equal(instructions[0]?.answeredByVersionId, v1, 'set 1 keeps its answer');
      assert.equal(instructions[1]?.answeredByVersionId, v2, 'set 2 is answered by v2');
      assert.equal((await domain.creator.getVersion(organizationId, v2))?.answersInstructionId, instructions[1]?.id);

      const review = await domain.records.contentRecord(creatorSeat(), contentId);
      assert.equal(review?.state, 'YOUR_REVIEW');
      assert.equal(review?.latestVersion?.id, v2);
      assert.equal(review?.activeProduction?.currentStep?.round, 2);
      assert.equal(review?.activeProduction?.currentStep?.kind, 'REVIEW');

      refused(await domain.productions.approveVersion(otherCreatorActor(), { contentId, versionId: v2 }), 'NOT_FOUND', "another creator approving this creator's content");
      refused(await domain.productions.approveVersion(creatorActor(), { contentId, versionId: `missing_${randomUUID()}` }), 'NOT_FOUND', 'a version that is not on this content');
      const approved = ok(await domain.productions.approveVersion(creatorActor(), { contentId, versionId: v2 }), 'approveVersion');
      assert.equal(approved.productionCompleted, true);

      const marks = await prisma.contentVersionApproval.findMany({ where: { contentId } });
      assert.equal(marks.length, 1, 'one mark, on one version');
      assert.equal(marks[0]?.versionId, v2);
      assert.equal(marks[0]?.requirementKey, 'creator');
      assert.equal(marks[0]?.approverKind, 'CREATOR');
      assert.equal(marks[0]?.approvedByUserId, creatorUser);

      const instance = await work.getWorkInstance(organizationId, wid1);
      assert.equal(instance?.status, 'completed');
      assert.ok(instance?.completedAt);
      assert.equal(instance?.currentStageId, null);
      assert.equal(instance?.stages[3]?.status, 'completed');
      assert.equal(instance?.stages[3]?.completedByUserId, creatorUser);
      const production = await prisma.contentProduction.findFirst({ where: { contentId, number: 1 } });
      assert.ok(production?.completedAt, 'the production is stamped complete');

      const record = await domain.records.contentRecord(creatorSeat(), contentId);
      assert.ok(record);
      assert.equal(record.state, 'APPROVED_BY_YOU');
      assert.equal(record.stateLabel, 'Approved by you');
      assert.equal(record.activeProduction, null);
      assert.equal(record.productions[0]?.workStatus, 'completed');
      assert.ok(record.productions[0]?.completedAt);
      assert.equal(record.judgedVersion?.id, v2);
      assert.deepEqual(record.requirementStatuses.map((r) => [r.key, r.met]), [['creator', true], ['emg', false], ['brand', false], ['published', false]]);
      assert.equal(record.requirementStatuses[0]?.by, 'Kona');
      assert.equal(record.requirementStatuses[0]?.versionLabel, 'Edit v2');
      assert.equal(record.actions.markPublished, false, 'a deliverable is not publishable before it is final');
      assert.equal(record.actions.requestEdit, true);
      assert.equal(record.context.deliverable?.status, 'OPEN');
      assert.equal(record.context.deliverable?.line, 'Content approved');
      const deliverable = await domain.commercial.getDeliverable(organizationId, deliverableId);
      assert.equal(deliverable?.status, 'OPEN', '"approved" never silently becomes "done"');
      assert.equal(deliverable?.completedAt, null);

      // Approving again is idempotent: the same mark, and nothing else moves.
      const again = ok(await domain.productions.approveVersion(creatorActor(), { contentId, versionId: v2 }), 'approve again');
      assert.equal(again.productionCompleted, false);
      assert.equal(await prisma.contentVersionApproval.count({ where: { contentId } }), 1);
      const tasks = await domain.records.tasks(creatorActor(), HREFS);
      assert.equal(tasks.some((x) => x.kind === 'REVIEW'), false);
      assert.equal(tasks.find((x) => x.key === `deliverable:${deliverableId}`)?.kind, 'DELIVERABLE');
      assert.deepEqual((await domain.records.requests(organizationId)).map((r) => r.needs), ['DONE']);
    });

    await step('EMG and the relayed brand approval make v2 FINAL; the creator marks it published: PUBLISHED, deliverable COMPLETE', async () => {
      refused(await domain.productions.recordEmgApproval(awayEmg, { contentId, versionId: v2, note: null }), 'NOT_FOUND', 'another organization approving');
      ok(await domain.productions.recordEmgApproval(emg(owner, true), { contentId, versionId: v2, note: 'Good to go' }), 'recordEmgApproval');
      assert.equal((await domain.records.contentRecord(creatorSeat(), contentId))?.state, 'APPROVED_BY_YOU', 'still one requirement short');
      refused(await domain.productions.recordBrandApproval(emg(owner, true), { contentId, versionId: v2, originatorLabel: '  ', note: null }), 'INVALID', 'a relayed approval must say who approved');
      ok(await domain.productions.recordBrandApproval(emg(owner, true), { contentId, versionId: v2, originatorLabel: 'Kona Coffee', note: null }), 'recordBrandApproval');

      const final = await domain.records.contentRecord(creatorSeat(), contentId);
      assert.ok(final);
      assert.equal(final.state, 'FINAL');
      assert.equal(final.actions.markPublished, true);
      const v2View = final.versions.find((v) => v.id === v2)!;
      assert.deepEqual(v2View.approvals.map((a) => a.requirementKey).sort(), ['brand', 'creator', 'emg']);
      const brand = v2View.approvals.find((a) => a.requirementKey === 'brand')!;
      assert.equal(brand.approverKind, 'BRAND_RELAYED');
      assert.equal(brand.originatorLabel, 'Kona Coffee', 'who approved');
      assert.equal(brand.by?.userId, owner, 'who entered it -- a different fact');
      assert.equal(final.versions.find((v) => v.id === v1)?.approvals.length, 0, 'an earlier version gets nothing');
      assert.equal(final.context.deliverable?.line, 'Final approved');
      assert.deepEqual(final.requirementStatuses.map((r) => r.met), [true, true, true, false]);
      assert.equal((await domain.commercial.getDeliverable(organizationId, deliverableId))?.status, 'OPEN', 'publication is declared, so it is still owed');

      const publishedAt = new Date('2026-10-02T09:00:00.000Z');
      const published = ok(await domain.productions.markPublished(creatorActor(), { contentId, versionId: v2, platform: 'INSTAGRAM', url: 'https://instagram.com/p/launch', publishedAt }), 'markPublished');
      const publication = await prisma.contentPublication.findFirst({ where: { id: published.publicationId } });
      assert.equal(publication?.versionId, v2);
      assert.equal(publication?.platform, 'INSTAGRAM');
      assert.equal(publication?.markedByUserId, creatorUser);
      assert.equal(publication?.publishedAt.getTime(), publishedAt.getTime());

      const record = await domain.records.contentRecord(creatorSeat(), contentId);
      assert.equal(record?.state, 'PUBLISHED');
      assert.deepEqual(record?.requirementStatuses.map((r) => r.met), [true, true, true, true]);
      assert.equal(record?.requirementStatuses[3]?.by, 'INSTAGRAM');
      assert.equal(record?.context.deliverable?.complete, true);
      assert.equal(record?.context.deliverable?.line, 'Complete');
      const deliverable = await domain.commercial.getDeliverable(organizationId, deliverableId);
      assert.equal(deliverable?.status, 'COMPLETE');
      assert.ok(deliverable?.completedAt);
      assert.equal(deliverable?.contentId, contentId);

      const library = await domain.records.library(creatorSeat(), profileId);
      assert.equal(library.length, 1);
      assert.equal(library[0]?.id, contentId);
      assert.equal(library[0]?.state, 'PUBLISHED');
      assert.equal(library[0]?.published, true);
      assert.equal(library[0]?.campaignName, 'Spring launch');
      assert.equal(library[0]?.deliverableTitle, 'Launch reel');
      assert.deepEqual(await domain.records.library(creatorSeat(), otherProfileId), [], "a creator cannot list another creator's library");
      assert.equal((await domain.records.library(emgSeat, profileId)).length, 1);
      const campaigns = await domain.records.campaigns(creatorSeat(), partyId);
      assert.equal(campaigns.length, 1);
      assert.equal(campaigns[0]?.deliverables.find((d) => d.id === deliverableId)?.line, 'Complete');
      assert.equal(campaigns[0]?.deliverables.find((d) => d.id === deliverableId)?.contentState, 'PUBLISHED');
      assert.equal(campaigns[0]?.deliverables.find((d) => d.id === openDeliverableId)?.line, 'awaiting content');
      assert.equal(campaigns[0]?.termsSummary, null, 'terms never leave EMG');
      assert.equal((await domain.records.campaigns(emgSeat, partyId))[0]?.termsSummary, 'Net 30');
      const tasks = await domain.records.tasks(creatorActor(), HREFS);
      assert.equal(tasks.some((x) => x.key === `deliverable:${deliverableId}`), false, 'a COMPLETE deliverable is no longer a task');
      assert.equal(tasks.find((x) => x.key === `deliverable:${openDeliverableId}`)?.kind, 'UPLOAD');
    });

    await step('ruling 4: brand feedback after completion starts Production 2 on the same lineage; Production 1 is untouched', async () => {
      refused(await domain.productions.relayBrandFeedback(emg(owner, true), { contentId, originatorLabel: 'Kona Coffee', summary: null, notes: [], requestedReturnAt: null }), 'INVALID', 'feedback with nothing in it');
      refused(await domain.productions.relayBrandFeedback(emg(owner, true), { contentId, originatorLabel: ' ', summary: 'x', notes: [], requestedReturnAt: null }), 'INVALID', 'feedback with nobody behind it');
      refused(await domain.productions.relayBrandFeedback(awayEmg, { contentId, originatorLabel: 'Kona Coffee', summary: 'x', notes: [], requestedReturnAt: null }), 'NOT_FOUND', 'another organization relaying');
      const result = ok(await domain.productions.relayBrandFeedback(emg(owner, true), { contentId, originatorLabel: 'Kona Coffee', summary: 'Remove the claim at 0:17', notes: [], requestedReturnAt: null }), 'relayBrandFeedback');
      wid2 = result.workInstanceId;
      assert.notEqual(wid2, wid1, 'a NEW work item');
      assert.equal(result.productionNumber, 2);

      const second = await work.getWorkInstance(organizationId, wid2);
      assert.ok(second);
      assert.equal(second.status, 'active');
      assert.equal(second.title, 'Production 2 · Launch reel cut');
      assert.equal(second.createdByUserId, owner);
      assert.deepEqual(second.stages.map((s) => s.name), ['Edit', 'Creator review']);
      assert.equal(second.stages[0]?.status, 'ready');
      assert.equal(second.stages[0]?.ownerUserId, null);
      assert.equal(second.requestedReturnAt, null);
      const first = await work.getWorkInstance(organizationId, wid1);
      assert.equal(first?.status, 'completed', 'a completed work item is never reopened');
      assert.equal(first?.stages.length, 4);

      const productions = await prisma.contentProduction.findMany({ where: { contentId }, orderBy: { number: 'asc' } });
      assert.deepEqual(productions.map((p) => [p.number, p.workInstanceId, p.completedAt === null]), [[1, wid1, false], [2, wid2, true]]);
      assert.equal(productions[1]?.sourceVersionId, v2, 'the latest READY version is the source');
      assert.equal(productions[1]?.requestedByUserId, owner);

      const instructions = await work.listInstructions(organizationId, wid2);
      assert.equal(instructions.length, 1);
      assert.equal(instructions[0]?.id, result.instructionId);
      assert.equal(instructions[0]?.sequence, 1, 'sequences are per work item');
      assert.equal(instructions[0]?.originatorKind, 'BRAND_RELAYED');
      assert.equal(instructions[0]?.originatorLabel, 'Kona Coffee', 'who said it');
      assert.equal(instructions[0]?.enteredByUserId, owner, 'who entered it');
      assert.equal(instructions[0]?.refersToVersionId, v2);
      assert.equal(instructions[0]?.summary, 'Remove the claim at 0:17');
      assert.equal(instructions[0]?.workStageId, second.stages[0]?.id);

      // With Production 2 on its Edit step, the refusals a page would hit.
      refused(await domain.productions.requestChanges(creatorActor(), { contentId, summary: 'x', notes: [], requestedReturnAt: null }), 'NOT_YOUR_STEP', "the current step is not the creator's");
      refused(await domain.productions.requestEdit(creatorActor(), { contentId, sourceVersionId: v2, summary: 'x', notes: [], requestedReturnAt: null }), 'PRODUCTION_ACTIVE', 'a production is active');
      refused(await domain.productions.returnVersionForReview(emg(editor, false), { workInstanceId: wid2, versionId: v2, noteToCreator: null, addressed: [] }), 'NOT_YOUR_STEP', 'an employee who does not own the (unassigned) Edit step');
      refused(await domain.productions.returnVersionForReview(emg(editor, false), { workInstanceId: wid1, versionId: v2, noteToCreator: null, addressed: [] }), 'NO_ACTIVE_PRODUCTION', 'the completed work item');
      refused(await domain.productions.setExpectedReturn(emg(owner, true), { workInstanceId: `missing_${randomUUID()}`, expectedReturnAt }), 'NOT_FOUND', 'a work item that is not a production');

      const record = await domain.records.contentRecord(emgSeat, contentId);
      assert.equal(record?.productions.length, 2);
      assert.equal(record?.activeProduction?.number, 2);
      assert.equal(record?.activeProduction?.instructions[0]?.originatorLabel, 'Kona Coffee');
      assert.equal(record?.activeProduction?.instructions[0]?.enteredBy?.userId, owner);
      const mine = await domain.records.contentRecord(creatorSeat(), contentId);
      assert.equal(mine?.activeProduction?.instructions[0]?.originatorKind, 'BRAND_RELAYED');
      assert.equal(mine?.activeProduction?.instructions[0]?.originatorLabel, 'Kona Coffee', 'the creator sees the designated label');
      const roster = (await domain.records.roster(organizationId)).find((r) => r.profile.id === profileId);
      assert.deepEqual([roster?.needsEmg, roster?.needsCreator, roster?.inProduction], [1, 0, 1]);
      const requests = await domain.records.requests(organizationId);
      assert.deepEqual(requests.map((r) => [r.production.number, r.needs]).sort((a, b) => Number(a[0]) - Number(b[0])), [[1, 'DONE'], [2, 'EMG']]);
      const forWork = await domain.records.productionForWork(organizationId, wid2);
      assert.equal(forWork?.production.number, 2);
      assert.equal(forWork?.record.id, contentId);
      assert.equal(await domain.records.productionForWork(away.organizationId, wid2), null);
    });

    await step("comments: an EMG internal comment never reaches the creator; a creator-visible one does; the creator's own note is creator-visible", async () => {
      ok(await domain.productions.addEmgComment(emg(owner, true), { workInstanceId: wid2, body: 'Legal flagged the claim', visibility: 'internal' }), 'internal comment');
      ok(await domain.productions.addEmgComment(emg(owner, true), { workInstanceId: wid2, body: 'We will have this back Friday', visibility: 'creator_visible' }), 'creator-visible comment');
      refused(await domain.productions.addEmgComment(awayEmg, { workInstanceId: wid2, body: 'x', visibility: 'internal' }), 'NOT_FOUND', 'another organization commenting');
      ok(await domain.productions.addCreatorNote(creatorActor(), { contentId, body: 'Thanks, no rush' }), 'creator note');
      refused(await domain.productions.addCreatorNote(otherCreatorActor(), { contentId, body: 'x' }), 'NOT_FOUND', 'another creator commenting');
      const mine = await domain.records.contentRecord(creatorSeat(), contentId);
      const theirs = await domain.records.contentRecord(emgSeat, contentId);
      const second = (record: typeof mine) => record?.productions.find((p) => p.workInstanceId === wid2);
      assert.deepEqual(second(mine)?.comments.map((c) => c.body).sort(), ['Thanks, no rush', 'We will have this back Friday']);
      assert.deepEqual(second(theirs)?.comments.map((c) => `${c.visibility}:${c.body}`).sort(), ['creator_visible:Thanks, no rush', 'creator_visible:We will have this back Friday', 'internal:Legal flagged the claim']);
      assert.equal(second(mine)?.comments.every((c) => c.visibility === 'creator_visible'), true);
    });
  } finally {
    for (const organizationId of organizations) await removeTenant(prisma, organizationId);
    await prisma.$disconnect();
  }
});

test("the database itself holds the creator domain's keys and cascades, even without the repositories", { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  let organizationId = '';
  try {
    const t = await tenant(prisma, 'keys', [
      { key: 'owner', role: 'OWNER', name: 'Owner' },
      { key: 'creator', role: 'CREATOR', name: 'Creator' },
    ] as const);
    organizationId = t.organizationId;
    const { owner, creator } = t.users;

    const profile = await prisma.creatorProfile.create({ data: { organizationId, partyId: 'party_keys', userId: creator, displayName: 'C' } });
    await refusedByDb(prisma.creatorProfile.create({ data: { organizationId, partyId: 'party_keys_2', userId: creator, displayName: 'C again' } }), 'one profile per login');
    await refusedByDb(prisma.creatorProfile.create({ data: { organizationId, partyId: 'party_keys', userId: null, displayName: 'same party' } }), 'one profile per party per organization');

    const content = await prisma.creatorContent.create({ data: { organizationId, creatorProfileId: profile.id, title: 'T', kind: 'VIDEO', createdByUserId: creator } });
    const key = `media/${organizationId}/keys/0.mp4`;
    const version = await prisma.contentVersion.create({ data: { organizationId, contentId: content.id, number: 0, label: 'Original', kind: 'ORIGINAL', storageKey: key, contentType: 'video/mp4', uploadedByUserId: creator, uploadedByKind: 'CREATOR' } });
    await refusedByDb(
      prisma.contentVersion.create({ data: { organizationId, contentId: content.id, number: 0, label: 'Original', kind: 'ORIGINAL', storageKey: `${key}.again`, contentType: 'video/mp4', uploadedByUserId: creator, uploadedByKind: 'CREATOR' } }),
      'one version per number',
    );
    await refusedByDb(
      prisma.contentVersion.create({ data: { organizationId, contentId: content.id, number: 1, label: 'Edit v1', kind: 'EDIT', storageKey: key, contentType: 'video/mp4', uploadedByUserId: creator, uploadedByKind: 'CREATOR' } }),
      'one row per storage key',
    );
    await refusedByDb(
      prisma.contentVersion.create({ data: { organizationId, contentId: `missing_${randomUUID()}`, number: 0, label: 'Original', kind: 'ORIGINAL', storageKey: `${key}.orphan`, contentType: 'video/mp4', uploadedByUserId: creator, uploadedByKind: 'CREATOR' } }),
      'a version needs its content',
    );

    await prisma.contentVersionApproval.create({ data: { organizationId, contentId: content.id, versionId: version.id, requirementKey: 'creator', approverKind: 'CREATOR', approvedByUserId: creator } });
    await refusedByDb(
      prisma.contentVersionApproval.create({ data: { organizationId, contentId: content.id, versionId: version.id, requirementKey: 'creator', approverKind: 'EMG', approvedByUserId: owner } }),
      'one mark per (version, requirement)',
    );

    const instance = await prisma.workInstance.create({ data: { organizationId, title: 'P', createdByUserId: owner } });
    await prisma.contentProduction.create({ data: { organizationId, contentId: content.id, number: 1, workInstanceId: instance.id, sourceVersionId: version.id, requestedByUserId: creator } });
    await refusedByDb(
      prisma.contentProduction.create({ data: { organizationId, contentId: content.id, number: 2, workInstanceId: instance.id, sourceVersionId: version.id, requestedByUserId: creator } }),
      'one production per work item',
    );
    await prisma.workInstruction.create({ data: { organizationId, workInstanceId: instance.id, sequence: 1, originatorKind: 'CREATOR', enteredByUserId: creator } });
    await refusedByDb(
      prisma.workInstruction.create({ data: { organizationId, workInstanceId: instance.id, sequence: 1, originatorKind: 'EMG', enteredByUserId: owner } }),
      'one instruction set per sequence per work item',
    );
    await refusedByDb(
      prisma.workInstruction.create({ data: { organizationId, workInstanceId: `missing_${randomUUID()}`, sequence: 1, originatorKind: 'CREATOR', enteredByUserId: creator } }),
      'an instruction set needs a work item behind it',
    );

    // Cascades: the work item takes its instruction sets; the organization takes the creator domain.
    await prisma.workInstance.delete({ where: { id: instance.id } });
    assert.equal(await prisma.workInstruction.count({ where: { organizationId } }), 0);
    await prisma.organization.delete({ where: { id: organizationId } });
    organizationId = '';
    assert.equal(await prisma.creatorProfile.count({ where: { id: profile.id } }), 0);
    assert.equal(await prisma.creatorContent.count({ where: { id: content.id } }), 0);
    assert.equal(await prisma.contentVersion.count({ where: { id: version.id } }), 0);
    assert.equal(await prisma.contentVersionApproval.count({ where: { versionId: version.id } }), 0);
    assert.equal(await prisma.contentProduction.count({ where: { contentId: content.id } }), 0);
  } finally {
    if (organizationId) await removeTenant(prisma, organizationId);
    await prisma.$disconnect();
  }
});
