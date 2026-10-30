import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { CREATOR_MAIL_SHARING_DECISION } from '@emgloop/shared';
import { CreatorBrandMailRepository } from '../src/creator/creator-brand-mail.repository';
import { CreatorRepository } from '../src/creator/creator.repository';
import { IamRepository } from '../src/repositories/iam.repository';
import { PartyService } from '../src/services/party.service';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';

const at = new Date('2026-10-29T18:00:00Z');
const scope = 'https://www.googleapis.com/auth/gmail.readonly';
async function world() {
  const fake = makeCognitivePrisma({ also: ['creatorProfile', 'creatorBrandMailShare', 'organizationMembership', 'invitation', 'workThread', 'googleConnection', 'sourceContentAuthorization'] });
  const db = fake as unknown as PrismaClient;
  const iam = new IamRepository(db); const people = new PartyService(db); const creators = new CreatorRepository(db);
  const repo = new CreatorBrandMailRepository(db);
  async function member(role: 'OWNER' | 'CREATOR' | 'EMPLOYEE', email: string, org = 'a') {
    const u = await iam.createUser({ organizationId: org, email, systemRole: role });
    await iam.activateUser(org, u.id); return u.id;
  }
  const owner = await member('OWNER', 'owner@example.test');
  const recipient = await member('CREATOR', 'creator@example.test');
  const secondRecipient = await member('CREATOR', 'other@example.test');
  const employee = await member('EMPLOYEE', 'employee@example.test');
  const foreignOwner = await member('OWNER', 'foreign@example.test', 'b');
  async function party(type: 'PERSON' | 'COMPANY', name: string) {
    const r = await people.create('a', owner, { partyType: type, displayName: name });
    if (r.outcome !== 'RECORDED') throw Error('fixture');
    await people.establish('a', owner, r.party.id, 'MANUAL'); return r.party.id;
  }
  const creatorParty = await party('PERSON', 'Creator Alpha');
  const brand = await party('COMPANY', 'Brand Bravo');
  const profile = await creators.createProfile({ organizationId: 'a', partyId: creatorParty, userId: recipient, displayName: 'Creator Alpha' });
  const principal = { organizationId: 'a', userId: owner };
  const thread = await db.workThread.create({ data: { ...principal, provider: 'GOOGLE', threadId: 'provider-private-thread', subject: 'private-subject-not-shared', labels: ['INBOX'], lastMessageAt: at } });
  const consent = await db.sourceContentAuthorization.create({ data: { ...principal, provider: 'GMAIL', authorizedAt: at, revokedAt: null } });
  await db.googleConnection.create({ data: { ...principal, googleSubject: 'g', emailAtLink: 'private@example.test', status: 'CONNECTED', grantedScopes: [scope], connectedAt: at } });
  const input = { threadProviderId: thread.threadId, creatorProfileId: profile.id, brandPartyId: brand, confirmed: true, decisionRef: CREATOR_MAIL_SHARING_DECISION };
  return { fake, db, iam, repo, creators, profile, principal, input, consent, brand, recipient, secondRecipient, employee, foreignOwner, thread };
}

test('an owner can share only their own explicitly confirmed, single-creator, canonical brand thread', async () => {
  const w = await world();
  assert.equal(await w.repo.share(w.principal, { ...w.input, confirmed: false }), 'CONSENT_REQUIRED');
  assert.equal(await w.repo.share(w.principal, { ...w.input, decisionRef: 'guess' }), 'CONSENT_REQUIRED');
  assert.equal(await w.repo.share({ organizationId: 'a', userId: w.employee }, w.input), 'NOT_ALLOWED');
  assert.equal(await w.repo.share({ organizationId: 'b', userId: w.foreignOwner }, w.input), 'NOT_FOUND');
  assert.equal(await w.repo.share(w.principal, w.input), 'SHARED');
  assert.equal(await w.repo.share(w.principal, w.input), 'SHARED');
  assert.equal(await w.db.creatorBrandMailShare.count(), 1);
  assert.equal(await w.db.auditLog.count({ where: { action: 'creator.mail.shared' } }), 1);
  const other = await w.creators.createProfile({ organizationId: 'a', partyId: 'another-person', userId: w.secondRecipient, displayName: 'Other Creator' });
  assert.equal(await w.repo.share(w.principal, { ...w.input, creatorProfileId: other.id }), 'SCOPE_CONFLICT');
});

test('only the bound recipient sees a minimized update, with no private identifiers, addresses or subjects', async () => {
  const w = await world(); await w.repo.share(w.principal, w.input);
  const due = await w.repo.due(new Date(Date.now() + 10)); assert.equal(due.length, 1);
  const row = await w.repo.claim(w.principal, due[0]!.id, new Date(Date.now() + 20)); assert.ok(row);
  const completed = new Date(Date.now() + 30);
  assert.equal(await w.repo.finish(row, { now: completed, fingerprint: 'one', evidenceAt: at, update: { publishable: true, stage: 'AWAITING_BRAND', summary: 'The brand is considering the proposed partnership.', nextStep: 'EMG is waiting for the brand to respond.', citations: ['mail_message:private-source:1'] } }), true);
  const own = await w.repo.forCreator({ organizationId: 'a', userId: w.recipient }, w.profile.id, completed);
  assert.equal(own.length, 1); assert.equal(own[0]?.brand, 'Brand Bravo'); assert.equal(own[0]?.current, true);
  const serialized = JSON.stringify(own);
  for (const forbidden of [w.thread.threadId, w.thread.subject!, 'private@example.test', 'mail_message:', 'ownerUserId', 'recipientUserId', 'sourceFingerprint']) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.deepEqual(await w.repo.forCreator({ organizationId: 'a', userId: w.secondRecipient }, w.profile.id, completed), []);
  assert.deepEqual(await w.repo.forCreator({ organizationId: 'b', userId: w.foreignOwner }, w.profile.id, completed), []);
  assert.deepEqual(await w.repo.forCreator(w.principal, w.profile.id, completed), []);
  assert.equal((await w.repo.forCreator({ organizationId: 'a', userId: w.recipient }, w.profile.id, new Date(completed.getTime() + 11 * 60_000)))[0]?.current, false);
});

test('withdrawing mid-flight removes the summary and refuses late completion; another owner cannot withdraw it', async () => {
  const w = await world(); await w.repo.share(w.principal, w.input);
  const target = (await w.repo.due(new Date(Date.now() + 10)))[0]!;
  const row = await w.repo.claim(w.principal, target.id, new Date(Date.now() + 20)); assert.ok(row);
  assert.equal(await w.repo.withdraw({ organizationId: 'b', userId: w.foreignOwner }, row.id), 'NOT_FOUND');
  assert.equal(await w.repo.withdraw(w.principal, row.id), 'WITHDRAWN');
  assert.equal(await w.repo.finish(row, { now: new Date(Date.now() + 30), fingerprint: 'late', update: { publishable: true, stage: 'CONFIRMED', summary: 'Must never appear.', nextStep: '', citations: [] } }), false);
  assert.deepEqual(await w.repo.forCreator({ organizationId: 'a', userId: w.recipient }, w.profile.id, new Date()), []);
});

test('revoked/reissued consent, profile rebinding, spam labels and disabled owners withdraw access', async () => {
  for (const scenario of ['revoke', 'reauthorize', 'rebind', 'spam', 'disable', 'deny'] as const) {
    const w = await world(); await w.repo.share(w.principal, w.input);
    const row = await w.repo.claim(w.principal, (await w.repo.due(new Date(Date.now() + 10)))[0]!.id, new Date(Date.now() + 20)); assert.ok(row);
    if (scenario === 'revoke') await w.db.sourceContentAuthorization.update({ where: { id: w.consent.id }, data: { revokedAt: new Date() } });
    if (scenario === 'reauthorize') await w.db.sourceContentAuthorization.update({ where: { id: w.consent.id }, data: { authorizedAt: new Date(at.getTime() + 1) } });
    if (scenario === 'rebind') await w.creators.bindUser('a', w.profile.id, w.secondRecipient);
    if (scenario === 'spam') await w.db.workThread.update({ where: { id: w.thread.id }, data: { labels: ['SPAM'] } });
    if (scenario === 'disable') {
      await w.db.user.update({ where: { id: w.principal.userId }, data: { status: 'DISABLED' } });
      await w.db.organizationMembership.updateMany({ where: { userId: w.principal.userId }, data: { status: 'DISABLED' } });
    }
    if (scenario === 'deny') await w.db.permission.create({ data: { organizationId: 'a', userId: w.principal.userId, resource: 'employeeIntelligence', action: 'view', effect: 'DENY' } });
    assert.equal(await w.repo.scope(row), null, scenario);
    assert.equal(await w.repo.finish(row, { now: new Date(Date.now() + 30), failure: 'AUTHORIZATION_ENDED' }), false, scenario);
    assert.equal(await w.db.creatorBrandMailShare.count(), 0, scenario);
  }
});

import { CreatorBrandMailService } from '../src/creator/creator-brand-mail.service';
import { parseCreatorBrandUpdate, CREATOR_BRAND_UPDATE_SCHEMA_ID } from '@emgloop/shared';
import type { AiRunResult } from '../src/services/ai-runtime/gateway';
const reading = { subject: 'PRIVATE_SUBJECT', messages: [{ direction: 'INBOUND' as const, occurredAt: at, fromLabel: 'PRIVATE_CONTACT', text: 'PRIVATE_BODY_READER_ONLY The brand would like the creator media kit.' }], truncated: false };
function answer(publishable = true): AiRunResult {
  return { outcome: 'ANSWERED', output: parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable, stage: 'AWAITING_EMG', summary: publishable ? 'The brand requested creator materials to consider the partnership.' : '', nextStep: publishable ? 'EMG is preparing the requested materials.' : '', citations: publishable ? ['mail_message:source:1'] : [] })!, provenance: { invocationId: 'invocation', requestedModel: { providerId: 'anthropic' } } } as unknown as AiRunResult;
}
test('refresh runs as the sharing owner, publishes only validated output, and does not re-invoke unchanged evidence', async () => {
  const w = await world(); await w.repo.share(w.principal, w.input);
  let now = new Date(Date.now() + 10); let invocations = 0;
  const service = new CreatorBrandMailService({ repository: w.repo, now: () => now,
    readThread: async (principal, id) => { assert.deepEqual(principal, w.principal); assert.equal(id, w.thread.id); return reading; },
    runtime: { run: async (principal, request) => { invocations++; assert.deepEqual(principal, w.principal); assert.equal(request.task.taskId, 'creator.brand.update'); assert.equal(request.context.viewerUserId, w.principal.userId); return answer(); } },
  });
  assert.deepEqual(await service.pass(), { PUBLISHED: 1 });
  now = new Date(now.getTime() + 301_000);
  assert.deepEqual(await service.pass(), { UNCHANGED: 1 }); assert.equal(invocations, 1);
  const rows = await w.db.creatorBrandMailShare.findMany();
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_BODY_READER_ONLY'));
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_SUBJECT'));
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_CONTACT'));
});
test('mixed/unsafe evidence withheld by the model is not retried while unchanged', async () => {
  const w = await world(); await w.repo.share(w.principal, w.input);
  let now = new Date(Date.now() + 10); let invocations = 0;
  const service = new CreatorBrandMailService({ repository: w.repo, now: () => now, readThread: async () => reading, runtime: { run: async () => { invocations++; return answer(false); } } });
  assert.deepEqual(await service.pass(), { WITHHELD: 1 });
  now = new Date(now.getTime() + 301_000);
  assert.deepEqual(await service.pass(), { UNCHANGED: 1 }); assert.equal(invocations, 1);
  const published = await w.repo.forCreator({ organizationId: 'a', userId: w.recipient }, w.profile.id, now);
  assert.equal(published[0]?.summary, null);
});
test('consent ending during model execution prevents publication, and an unavailable source removes the old summary', async () => {
  const w = await world(); await w.repo.share(w.principal, w.input);
  let now = new Date(Date.now() + 10);
  const service = new CreatorBrandMailService({ repository: w.repo, now: () => now, readThread: async () => reading, runtime: { run: async () => { await w.db.sourceContentAuthorization.update({ where: { id: w.consent.id }, data: { revokedAt: now } }); return answer(); } } });
  assert.deepEqual(await service.pass(), { WITHDRAWN: 1 });
  assert.equal(await w.db.creatorBrandMailShare.count(), 0);
  await w.db.sourceContentAuthorization.update({ where: { id: w.consent.id }, data: { revokedAt: null } });
  await w.repo.share(w.principal, w.input); now = new Date(Date.now() + 30);
  const available = new CreatorBrandMailService({ repository: w.repo, now: () => now, readThread: async () => reading, runtime: { run: async () => answer() } });
  assert.deepEqual(await available.pass(), { PUBLISHED: 1 });
  now = new Date(now.getTime() + 301_000);
  const unavailable = new CreatorBrandMailService({ repository: w.repo, now: () => now, readThread: async () => null, runtime: { run: async () => { throw Error('must not call'); } } });
  assert.deepEqual(await unavailable.pass(), { SOURCE_UNAVAILABLE: 1 });
  assert.equal((await w.repo.forCreator({ organizationId: 'a', userId: w.recipient }, w.profile.id, now))[0]?.summary, null);
});

test('the persistence boundary also refuses private financial output from an accidental unvalidated caller', async () => {
  const w = await world(); await w.repo.share(w.principal, w.input);
  const row = await w.repo.claim(w.principal, (await w.repo.due(new Date(Date.now() + 10)))[0]!.id, new Date(Date.now() + 20)); assert.ok(row);
  await w.repo.finish(row, { now: new Date(Date.now() + 30), fingerprint: 'not-accepted', evidenceAt: at, update: { publishable: true, stage: 'DISCUSSING', summary: 'The private commission is twenty percent.', nextStep: '', citations: ['mail_message:thread:1'] } });
  const published = await w.repo.forCreator({ organizationId: 'a', userId: w.recipient }, w.profile.id, new Date(Date.now() + 40));
  assert.equal(published[0]?.summary, null);
  assert.ok(!JSON.stringify(await w.db.creatorBrandMailShare.findMany()).includes('twenty percent'));
});
