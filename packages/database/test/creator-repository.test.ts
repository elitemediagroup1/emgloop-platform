// CreatorRepository and CrmCommercialRepository over the in-memory Prisma double (2026-09-22).
//
// These run everywhere the suite runs -- no Postgres -- and the double ENFORCES the new
// models' unique keys the way Postgres does (a colliding insert throws P2002), so what is
// proven here is the repositories' own numbering and idempotency, not the fake's tolerance:
//
//   - a piece of content has one Original, edits count from 1, and the storage key is built
//     from ids the repository owns (never from a caller);
//   - an approval is ONE mark per (version, requirement): a repeat returns the existing mark;
//   - a production is numbered per content and joined to exactly one work item;
//   - an Opportunity's and a Campaign's stage history is append-only with a sequence, an actor
//     and both ends of the move, and the row's current values are that log's projection;
//   - a deliverable's completion is stamped both ways, and every method resolves its row
//     within the organization first -- another organization's id is null, never forbidden.
//
// The reads that carry a nested `include` (getContent, productionByWorkInstance,
// getDeliverable's campaign) are not exercised here; the Postgres suite covers them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { MEDIA_KEY_PREFIX } from '@emgloop/providers';
import { CreatorRepository, versionLabel } from '../src/creator/creator.repository';
import { CrmCommercialRepository } from '../src/creator/crm-commercial.repository';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';

const ORG = 'org_a';
const OTHER = 'org_b';

function harness() {
  const prisma = makeCognitivePrisma({
    also: [
      'creatorProfile', 'creatorContent', 'contentVersion', 'contentVersionApproval', 'contentPublication', 'contentProduction',
      'crmOpportunity', 'crmOpportunityTransition', 'crmCampaign', 'crmCampaignTransition', 'campaignDeliverable',
    ],
  });
  const client = prisma as unknown as PrismaClient;
  return { prisma, creator: new CreatorRepository(client), commercial: new CrmCommercialRepository(client) };
}

async function content(creator: CreatorRepository) {
  const profile = await creator.createProfile({ organizationId: ORG, partyId: 'party_1', userId: 'u_creator', displayName: 'Kona Reyes' });
  const row = await creator.createContent({ organizationId: ORG, creatorProfileId: profile.id, title: 'Launch reel cut', kind: 'VIDEO', createdByUserId: 'u_creator' });
  return { profile, content: row };
}

function p2002(promise: Promise<unknown>, what: string) {
  return assert.rejects(promise, (err: any) => err?.code === 'P2002', what);
}

test('versionLabel: 0 is the Original; edits count from 1', () => {
  assert.equal(versionLabel(0), 'Original');
  assert.equal(versionLabel(1), 'Edit v1');
  assert.equal(versionLabel(7), 'Edit v7');
});

test('beginVersion: the first version is the Original, edits count from 1, and the storage key is minted from ids the repository owns', async () => {
  const { creator, prisma } = harness();
  const { profile, content: row } = await content(creator);

  await assert.rejects(
    creator.beginVersion({ organizationId: ORG, contentId: row.id, kind: 'EDIT', contentType: 'video/mp4', uploadedByUserId: 'u_editor', uploadedByKind: 'EMG' }),
    /Original/,
    'an edit before the Original',
  );
  const v0 = await creator.beginVersion({ organizationId: ORG, contentId: row.id, kind: 'ORIGINAL', contentType: 'video/mp4', fileName: 'raw.mp4', uploadedByUserId: 'u_creator', uploadedByKind: 'CREATOR' });
  assert.equal(v0.number, 0);
  assert.equal(v0.label, 'Original');
  assert.equal(v0.uploadState, 'PENDING');
  assert.equal(v0.visibleToCreator, true);
  assert.equal(v0.storageKey, `${MEDIA_KEY_PREFIX}${ORG}/${profile.id.toLowerCase()}/${row.id.toLowerCase()}/${v0.id.toLowerCase()}.mp4`);

  await assert.rejects(
    creator.beginVersion({ organizationId: ORG, contentId: row.id, kind: 'ORIGINAL', contentType: 'video/mp4', uploadedByUserId: 'u_creator', uploadedByKind: 'CREATOR' }),
    /one Original/,
  );
  const v1 = await creator.beginVersion({ organizationId: ORG, contentId: row.id, kind: 'EDIT', contentType: 'video/quicktime', uploadedByUserId: 'u_editor', uploadedByKind: 'EMG', visibleToCreator: false, internalNote: 'rough' });
  assert.equal(v1.number, 1);
  assert.equal(v1.label, 'Edit v1');
  assert.equal(v1.visibleToCreator, false);
  assert.ok(v1.storageKey.endsWith('.mov'));
  const v2 = await creator.beginVersion({ organizationId: ORG, contentId: row.id, kind: 'EDIT', contentType: 'video/mp4', uploadedByUserId: 'u_editor', uploadedByKind: 'EMG' });
  assert.equal(v2.number, 2);

  await assert.rejects(
    creator.beginVersion({ organizationId: OTHER, contentId: row.id, kind: 'EDIT', contentType: 'video/mp4', uploadedByUserId: 'u_intruder', uploadedByKind: 'EMG' }),
    /Content not found/,
    'another organization cannot add a version',
  );
  assert.equal(prisma.contentVersion.__rows.length, 3);
  // The double holds the keys the migration declares.
  await p2002(prisma.contentVersion.create({ data: { ...prisma.contentVersion.__rows[0], id: 'dup', storageKey: 'media/x' } }), 'one version per (content, number)');
  await p2002(prisma.contentVersion.create({ data: { ...prisma.contentVersion.__rows[0], id: 'dup2', number: 9 } }), 'one row per storage key');
});

test('markVersionReady / markVersionFailed / setVersionVisibility / setVersionProvenance resolve the version within the organization first', async () => {
  const { creator } = harness();
  const { content: row } = await content(creator);
  const v0 = await creator.beginVersion({ organizationId: ORG, contentId: row.id, kind: 'ORIGINAL', contentType: 'image/png', uploadedByUserId: 'u_creator', uploadedByKind: 'CREATOR' });

  assert.equal(await creator.markVersionReady(OTHER, v0.id, { byteSize: 1 }), null);
  assert.equal(await creator.markVersionFailed(OTHER, v0.id), null);
  assert.equal(await creator.setVersionVisibility(OTHER, v0.id, false), null);
  assert.equal(await creator.setVersionProvenance(OTHER, v0.id, { producedByWorkInstanceId: 'wi_x' }), null);
  assert.equal((await creator.getVersion(ORG, v0.id))?.uploadState, 'PENDING', 'nothing was written');
  assert.equal(await creator.getVersion(OTHER, v0.id), null);

  const ready = await creator.markVersionReady(ORG, v0.id, { byteSize: 512, width: 100, height: 200, clientFacts: { source: 'browser' } });
  assert.equal(ready?.uploadState, 'READY');
  assert.equal(ready?.byteSize, 512);
  assert.equal(ready?.contentType, 'image/png', 'the reserved content type stands when the facts carry none');
  assert.equal(ready?.durationSeconds, null);
  assert.ok(ready?.readyAt instanceof Date);

  const hidden = await creator.setVersionVisibility(ORG, v0.id, false);
  assert.equal(hidden?.visibleToCreator, false);
  assert.equal(hidden?.noteToCreator, null, 'a visibility change without a note leaves the note alone');
  const shown = await creator.setVersionVisibility(ORG, v0.id, true, 'Cut the intro');
  assert.equal(shown?.noteToCreator, 'Cut the intro');
  const linked = await creator.setVersionProvenance(ORG, v0.id, { producedByWorkInstanceId: 'wi_1', answersInstructionId: 'ins_1' });
  assert.equal(linked?.producedByWorkInstanceId, 'wi_1');
  assert.equal(linked?.answersInstructionId, 'ins_1');
});

test('recordApproval is ONE mark per (version, requirement): a repeat returns the existing mark; a version off this content is not found', async () => {
  const { creator, prisma } = harness();
  const { profile, content: row } = await content(creator);
  const v0 = await creator.beginVersion({ organizationId: ORG, contentId: row.id, kind: 'ORIGINAL', contentType: 'video/mp4', uploadedByUserId: 'u_creator', uploadedByKind: 'CREATOR' });
  const other = await creator.createContent({ organizationId: ORG, creatorProfileId: profile.id, title: 'Other', kind: 'PHOTO', createdByUserId: 'u_creator' });

  const first = await creator.recordApproval({ organizationId: ORG, contentId: row.id, versionId: v0.id, requirementKey: 'creator', approverKind: 'CREATOR', approvedByUserId: 'u_creator' });
  const again = await creator.recordApproval({ organizationId: ORG, contentId: row.id, versionId: v0.id, requirementKey: 'creator', approverKind: 'CREATOR', approvedByUserId: 'u_creator', note: 'ignored' });
  assert.equal(again.id, first.id, 'the existing mark, unchanged');
  assert.equal(again.note, null);
  const brand = await creator.recordApproval({ organizationId: ORG, contentId: row.id, versionId: v0.id, requirementKey: 'brand', approverKind: 'BRAND_RELAYED', approvedByUserId: 'u_owner', originatorLabel: 'Kona Coffee' });
  assert.notEqual(brand.id, first.id);
  assert.equal(brand.originatorLabel, 'Kona Coffee');
  assert.equal(prisma.contentVersionApproval.__rows.length, 2);

  await assert.rejects(
    creator.recordApproval({ organizationId: ORG, contentId: other.id, versionId: v0.id, requirementKey: 'emg', approverKind: 'EMG', approvedByUserId: 'u_owner' }),
    /Version not found/,
    'the version must be on the content named',
  );
  await assert.rejects(
    creator.recordApproval({ organizationId: OTHER, contentId: row.id, versionId: v0.id, requirementKey: 'emg', approverKind: 'EMG', approvedByUserId: 'u_intruder' }),
    /Version not found/,
    'another organization',
  );
  await assert.rejects(
    creator.recordPublication({ organizationId: OTHER, contentId: row.id, versionId: v0.id, platform: 'INSTAGRAM', publishedAt: new Date(), markedByUserId: 'u_intruder' }),
    /Version not found/,
  );
  assert.equal(prisma.contentVersionApproval.__rows.length, 2, 'nothing was written');
  await p2002(prisma.contentVersionApproval.create({ data: { organizationId: ORG, contentId: row.id, versionId: v0.id, requirementKey: 'creator', approverKind: 'EMG', approvedByUserId: 'u_owner' } }), 'the double holds the (version, requirement) key');
});

test('createProduction numbers per content and joins exactly one work item; completeProduction is organization-scoped', async () => {
  const { creator, prisma } = harness();
  const { content: row } = await content(creator);
  const v0 = await creator.beginVersion({ organizationId: ORG, contentId: row.id, kind: 'ORIGINAL', contentType: 'video/mp4', uploadedByUserId: 'u_creator', uploadedByKind: 'CREATOR' });
  const p1 = await creator.createProduction({ organizationId: ORG, contentId: row.id, workInstanceId: 'wi_1', sourceVersionId: v0.id, requestedByUserId: 'u_creator', requestedReturnAt: new Date('2026-10-01T00:00:00Z') });
  const p2 = await creator.createProduction({ organizationId: ORG, contentId: row.id, workInstanceId: 'wi_2', sourceVersionId: v0.id, requestedByUserId: 'u_owner' });
  assert.deepEqual([p1.number, p2.number], [1, 2]);
  assert.equal(p1.kind, 'EDIT');
  assert.equal(p2.requestedReturnAt, null);
  assert.equal(p1.completedAt, null);
  await p2002(
    creator.createProduction({ organizationId: ORG, contentId: row.id, workInstanceId: 'wi_1', sourceVersionId: v0.id, requestedByUserId: 'u_creator' }),
    'one production per work item',
  );
  assert.equal(await creator.completeProduction(OTHER, p1.id), null);
  assert.equal(prisma.contentProduction.__rows.find((r: { id: string }) => r.id === p1.id)?.completedAt, null, 'nothing was written');
  assert.ok((await creator.completeProduction(ORG, p1.id))?.completedAt instanceof Date);
});

test('profile and content writes resolve within the organization: another organization gets null and writes nothing', async () => {
  const { creator } = harness();
  const { profile, content: row } = await content(creator);
  assert.equal(await creator.updateProfile(OTHER, profile.id, { displayName: 'Taken' }), null);
  assert.equal(await creator.bindUser(OTHER, profile.id, 'u_intruder'), null);
  assert.equal(await creator.renameContent(OTHER, row.id, 'Taken'), null);
  assert.equal(await creator.attachContext(OTHER, row.id, { campaignId: 'c_x' }), null);
  assert.equal((await creator.profileById(ORG, profile.id))?.displayName, 'Kona Reyes');
  assert.equal((await creator.profileById(ORG, profile.id))?.userId, 'u_creator');
  assert.equal(await creator.profileById(OTHER, profile.id), null);
  assert.equal(await creator.profileForUser(OTHER, 'u_creator'), null);
  assert.equal((await creator.profileByParty(ORG, 'party_1'))?.id, profile.id);

  assert.equal((await creator.updateProfile(ORG, profile.id, { displayName: 'Kona R.', handle: 'kona' }))?.handle, 'kona');
  assert.equal((await creator.bindUser(ORG, profile.id, null))?.userId, null);
  assert.equal((await creator.renameContent(ORG, row.id, 'Renamed'))?.title, 'Renamed');
  assert.equal((await creator.attachContext(ORG, row.id, { campaignId: 'c_1', deliverableId: 'd_1' }))?.deliverableId, 'd_1');
});

test('an opportunity opens with transition 1 and moves by append-only transitions; the row is the projection; another organization moves nothing', async () => {
  const { commercial, prisma } = harness();
  const o = await commercial.createOpportunity({ organizationId: ORG, title: 'Kona spring', stage: 'Qualifying', creatorPartyId: 'party_1', createdByUserId: 'u_owner', creatorVisibleState: 'PITCHING', amountMinor: 250000, currency: 'USD' });
  assert.equal(o.category, 'OPEN');
  assert.equal(o.stage, 'Qualifying');
  const opened = prisma.crmOpportunityTransition.__rows;
  assert.equal(opened.length, 1);
  assert.deepEqual(
    [opened[0].sequence, opened[0].fromCategory, opened[0].fromStage, opened[0].toCategory, opened[0].toStage, opened[0].actorUserId, opened[0].note, opened[0].creatorVisible],
    [1, null, null, 'OPEN', 'Qualifying', 'u_owner', 'Opened', true],
    'the opening is visible to the creator exactly when a creator-visible state was designated',
  );

  const won = await commercial.transitionOpportunity({ organizationId: ORG, opportunityId: o.id, toCategory: 'CLOSED_WON', toStage: 'Won', actorUserId: 'u_owner', note: 'Signed', creatorVisible: true, outcome: 'Signed' });
  assert.equal(won?.category, 'CLOSED_WON');
  assert.equal(won?.stage, 'Won');
  assert.equal(won?.outcome, 'Signed');
  assert.equal(won?.lossReason, null);
  const moved = prisma.crmOpportunityTransition.__rows;
  assert.equal(moved.length, 2);
  assert.deepEqual([moved[1].sequence, moved[1].fromCategory, moved[1].fromStage, moved[1].toCategory, moved[1].toStage], [2, 'OPEN', 'Qualifying', 'CLOSED_WON', 'Won'], 'both ends of the move are stored');

  assert.equal(await commercial.transitionOpportunity({ organizationId: OTHER, opportunityId: o.id, toCategory: 'CLOSED_LOST', toStage: 'Lost', actorUserId: 'u_intruder' }), null);
  assert.equal(prisma.crmOpportunityTransition.__rows.length, 2, 'no transition for a move that did not happen');
  assert.equal(await commercial.designateOpportunity(OTHER, o.id, { creatorVisibleState: 'CONFIRMED' }), null);
  assert.equal((await commercial.designateOpportunity(ORG, o.id, { creatorVisibleState: 'CONFIRMED', brandVisibleToCreator: true }))?.creatorVisibleState, 'CONFIRMED');
  await p2002(prisma.crmOpportunityTransition.create({ data: { organizationId: ORG, opportunityId: o.id, sequence: 2, toCategory: 'OPEN', toStage: 'x' } }), 'the double holds the (opportunity, sequence) key');

  const silent = await commercial.createOpportunity({ organizationId: ORG, title: 'Quiet pursuit', stage: 'Lead', creatorPartyId: 'party_1', createdByUserId: 'u_owner' });
  const its = prisma.crmOpportunityTransition.__rows.filter((r: { opportunityId: string }) => r.opportunityId === silent.id);
  assert.equal(its[0].creatorVisible, false, 'nothing designated, nothing shown');
});

test('a campaign is declared with transition 1, moves by append-only transitions, and its deliverables are stamped complete both ways within the organization', async () => {
  const { commercial, prisma } = harness();
  const c = await commercial.createCampaign({ organizationId: ORG, name: 'Spring launch', creatorPartyId: 'party_1', createdByUserId: 'u_owner', brandLabel: 'Kona Coffee' });
  assert.equal(c.state, 'DRAFT');
  assert.equal(c.brandVisibleToCreator, false, 'never visible by default');
  assert.deepEqual(prisma.crmCampaignTransition.__rows.map((r: { sequence: number; fromState: string | null; toState: string; note: string | null }) => [r.sequence, r.fromState, r.toState, r.note]), [[1, null, 'DRAFT', 'Declared']]);
  const active = await commercial.transitionCampaign({ organizationId: ORG, campaignId: c.id, toState: 'ACTIVE', actorUserId: 'u_owner' });
  assert.equal(active?.state, 'ACTIVE');
  assert.equal(prisma.crmCampaignTransition.__rows[1].fromState, 'DRAFT');
  assert.equal(prisma.crmCampaignTransition.__rows[1].creatorVisible, true, 'campaign moves are visible unless said otherwise');
  assert.equal(await commercial.transitionCampaign({ organizationId: OTHER, campaignId: c.id, toState: 'CANCELLED', actorUserId: 'u_intruder' }), null);
  assert.equal(prisma.crmCampaignTransition.__rows.length, 2);

  await assert.rejects(
    commercial.declareDeliverable({ organizationId: OTHER, campaignId: c.id, creatorPartyId: 'party_1', title: 'x', deliverableType: 'REEL', createdByUserId: 'u_intruder' }),
    /Campaign not found/,
    'a deliverable is declared on a campaign the organization holds',
  );
  const d = await commercial.declareDeliverable({ organizationId: ORG, campaignId: c.id, creatorPartyId: 'party_1', title: 'Launch reel', deliverableType: 'REEL', createdByUserId: 'u_owner' });
  assert.equal(d.status, 'OPEN');
  assert.equal(d.acceptsUnedited, false);
  assert.deepEqual(d.requirements, []);
  assert.equal(d.contentId, null);

  assert.equal(await commercial.attachDeliverableContent(OTHER, d.id, 'content_1'), null);
  assert.equal((await commercial.attachDeliverableContent(ORG, d.id, 'content_1'))?.contentId, 'content_1');
  assert.equal(await commercial.setDeliverableStatus(OTHER, d.id, 'COMPLETE'), null);
  assert.equal(prisma.campaignDeliverable.__rows[0].status, 'OPEN', 'nothing was written');

  const done = await commercial.setDeliverableStatus(ORG, d.id, 'COMPLETE');
  assert.equal(done?.status, 'COMPLETE');
  assert.ok(done?.completedAt instanceof Date);
  const same = await commercial.setDeliverableStatus(ORG, d.id, 'COMPLETE');
  assert.equal(same?.completedAt?.getTime(), done?.completedAt?.getTime(), 'restating a status does not move its stamp');
  const reopened = await commercial.setDeliverableStatus(ORG, d.id, 'OPEN');
  assert.equal(reopened?.status, 'OPEN');
  assert.equal(reopened?.completedAt, null, 'stamped both ways');
});
