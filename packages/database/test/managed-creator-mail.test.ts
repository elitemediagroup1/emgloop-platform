import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { parseCreatorBrandUpdate, CREATOR_BRAND_UPDATE_SCHEMA_ID, type GmailThreadView } from '@emgloop/shared';
import { IamRepository } from '../src/repositories/iam.repository';
import { PartyService } from '../src/services/party.service';
import { CreatorRepository } from '../src/creator/creator.repository';
import { ManagedCreatorMailRepository, captureReadings } from '../src/creator/managed-creator-mail.repository';
import { ManagedCreatorMailService } from '../src/creator/managed-creator-mail.service';
import { creatorMailAliases, creatorMailQuery, exactMailPhrase } from '../src/creator/creator-mail-matching';
import type { AiRunResult } from '../src/services/ai-runtime/gateway';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
const T0 = new Date('2026-11-02T18:00:00Z');
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
async function world() {
  const db = makeCognitivePrisma({ also: ['creatorProfile', 'managedGoogleMailbox', 'managedCreatorMailCapture', 'managedGoogleOAuthState', 'googleConnection', 'googleOAuthState', 'organizationMembership'] }) as unknown as PrismaClient;
  const iam = new IamRepository(db), creators = new CreatorRepository(db), people = new PartyService(db), repo = new ManagedCreatorMailRepository(db);
  async function member(role: string, email: string, org = 'a') { const u = await iam.createUser({ organizationId: org, email, systemRole: role }); await iam.activateUser(org, u.id); return { organizationId: org, userId: u.id }; }
  const owner = await member('OWNER', 'matt@elitemediagroup.io'), recipient = await member('CREATOR', 'trevon@example.test'), second = await member('CREATOR', 'other@example.test'), foreign = await member('OWNER', 'foreign@example.test', 'b');
  async function company(name: string) { const r = await people.create('a', owner.userId, { partyType: 'COMPANY', displayName: name }); if (r.outcome !== 'RECORDED') throw Error('fixture'); await people.establish('a', owner.userId, r.party.id, 'MANUAL'); return r.party.id; }
  const brand = await company('Brand Bravo');
  const profile = await creators.createProfile({ organizationId: 'a', partyId: 'creator-party', userId: recipient.userId, displayName: 'Trevon Hill', handle: 'trevonhill', preferences: { managedMailboxEmail: 'trevon@emgtalentgroup.com', socialHandles: { TIKTOK: '@trevonhill' } } });
  const other = await creators.createProfile({ organizationId: 'a', partyId: 'other-party', userId: second.userId, displayName: 'Other Creator' });
  async function source(email: string, creatorProfileId: string | null = null, status = 'CONNECTED') { return db.managedGoogleMailbox.create({ data: { organizationId: 'a', authorizedByUserId: owner.userId, kind: creatorProfileId ? 'CREATOR' : 'STAFF', creatorProfileId, expectedEmail: email, status, grantedScopes: [READ], revision: `revision:${email}`, googleSubject: email, refreshTokenSealed: Buffer.from('sealed-not-a-token'), sealVersion: 'v1', keyRef: 'fixture' } }); }
  const staff = await source('matt@elitemediagroup.io'), assigned = await source('trevon@emgtalentgroup.com', profile.id), charlie = await source('charlie@elitemediagroup.io'), fran = await source('francesca@elitemediagroup.io', null, 'PENDING');
  let now = T0, modelCalls = 0, searches = 0, reads = 0, mode = 'normal';
  let modelHook = async () => {};
  const thread = (): GmailThreadView => ({ threadId: 'PRIVATE_THREAD', messages: [
    { fact: { provider: 'GOOGLE', messageId: 'PRIVATE_MESSAGE_1', threadId: 'PRIVATE_THREAD', internalDate: new Date(T0.getTime() - 2000), labels: ['SENT'], from: { address: staff.expectedEmail, name: 'Matt' }, to: [{ address: 'rep@brand.example', name: 'Rep' }], cc: [{ address: assigned.expectedEmail, name: 'Trevon' }], subject: 'PRIVATE_SUBJECT Brand Bravo and Trevon Hill', headerMessageId: '<physical-pitch@example.test>', inReplyTo: null, references: [], fromSelf: true }, body: { messageId: 'PRIVATE_MESSAGE_1', text: `PRIVATE_BODY Trevon Hill would like to discuss a paid Brand Bravo partnership.${mode === 'mixed' ? ' Other Creator is included too.' : ''}`, html: null, attachments: [], truncated: false } },
    { fact: { provider: 'GOOGLE', messageId: 'PRIVATE_MESSAGE_2', threadId: 'PRIVATE_THREAD', internalDate: new Date(T0.getTime() - 1000), labels: ['INBOX'], from: { address: 'rep@brand.example', name: 'Rep' }, to: [{ address: staff.expectedEmail, name: 'Matt' }], cc: [{ address: assigned.expectedEmail, name: 'Trevon' }], subject: 'PRIVATE_SUBJECT Brand Bravo and Trevon Hill', headerMessageId: '<physical-reply@example.test>', inReplyTo: '<physical-pitch@example.test>', references: [], fromSelf: false, ...(mode === 'automated' ? { automationClass: 'AUTO_SUBMITTED' as const } : {}) }, body: { messageId: 'PRIVATE_MESSAGE_2', text: mode === 'unreadable' ? null : 'PRIVATE_REPLY We would like the creator portfolio to discuss the partnership.', html: null, attachments: [], truncated: false } },
  ] });
  const service = new ManagedCreatorMailService({ repository: repo, now: () => now, mailboxes: {
    searchThreads: async (principal, mailboxId, query) => { searches++; assert.deepEqual(principal, owner); assert.ok([staff.id, assigned.id].includes(mailboxId)); assert.match(query, /-in:spam/); if (mailboxId === staff.id) assert.match(query, /"trevon hill"/); return { ok: true, threadIds: [mailboxId === staff.id ? 'PRIVATE_STAFF_THREAD' : 'PRIVATE_CREATOR_THREAD'], nextPageToken: null }; },
    readThread: async principal => { reads++; assert.deepEqual(principal, owner); return { ok: true, thread: thread() }; },
  }, runtime: { run: async (principal, request) => {
    modelCalls++; assert.deepEqual(principal, owner); assert.equal(request.task.taskId, 'creator.brand.update'); assert.ok(request.context.items.every(i => i.readUnder.resource === 'managedMailboxes')); assert.match(request.instructions, /automatic exact-text match/);
    await modelHook();
    if (mode === 'budget') return { outcome: 'REFUSED_BY_LOOP', refusals: ['BUDGET_EXHAUSTED'] } as AiRunResult;
    const citation = request.context.items.find(i => i.sourceRef.startsWith('mail_message:'))!.sourceRef;
    return { outcome: 'ANSWERED', output: parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable: true, stage: mode === 'automated' ? 'OUTREACH' : 'DISCUSSING', summary: 'EMG and the brand are discussing a creator partnership.', nextStep: 'EMG is preparing the creator portfolio.', citations: [citation] }), provenance: {} } as unknown as AiRunResult;
  } } });
  async function start(ids = [staff.id, assigned.id]) { assert.equal(await repo.configure(owner, profile.id, ids, now), 'STARTED'); }
  async function drain() { for (let i = 0; i < 12; i++) if (!Object.keys(await service.pass()).length) return; throw Error('did not drain bounded initial pass'); }
  return { db, repo, service, iam, creators, owner, recipient, second, foreign, profile, other, brand, staff, assigned, charlie, fran, start, drain, thread, setMode: (v: string) => { mode = v; }, clock: (v: Date) => { now = v; }, modelHook: (v: () => Promise<void>) => { modelHook = v; }, counts: () => ({ modelCalls, searches, reads }) };
}

test('two selected mailboxes feed one creator, duplicate copied messages count once, and no source content escapes', async () => {
  const w = await world(); await w.start(); await w.drain();
  assert.equal(w.counts().modelCalls, 2);
  const rows = await w.repo.updates(w.recipient, w.profile.id, T0);
  assert.equal(rows.length, 1); assert.equal(rows[0]?.brandId, w.brand); assert.equal(rows[0]?.stage, 'DISCUSSING'); assert.equal(rows[0]?.current, true);
  assert.equal((await w.repo.updates(w.owner, w.profile.id, T0, true)).length, 1);
  assert.deepEqual(await w.repo.updates(w.second, w.profile.id, T0), []);
  assert.deepEqual(await w.repo.updates(w.foreign, w.profile.id, T0, true), []);
  assert.deepEqual(await w.repo.updates(w.owner, w.profile.id, T0), []);
  for (const text of [JSON.stringify(rows), JSON.stringify(await w.db.managedCreatorMailCapture.findMany())]) for (const forbidden of ['PRIVATE_BODY', 'PRIVATE_REPLY', 'PRIVATE_SUBJECT', 'rep@brand.example', '<physical-reply@']) assert.ok(!text.includes(forbidden), forbidden);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_STAFF_THREAD|PRIVATE_CREATOR_THREAD|mailboxId|ownerUserId|mail_message:/);
  const captures = await w.db.managedCreatorMailCapture.findMany();
  assert.deepEqual(captures.map(c => c.mailboxId).sort(), [w.staff.id, w.assigned.id].sort());
  assert.ok(captures.every(c => c.mailboxId !== w.charlie.id && c.mailboxId !== w.fran.id));
});

test('unchanged evidence skips a second model call; later readings remain timestamped and stale readings leave current totals', async () => {
  const w = await world(); await w.start(); await w.drain();
  w.clock(new Date(T0.getTime() + 301_000)); await w.drain();
  assert.equal(w.counts().modelCalls, 2); assert.equal(w.counts().searches, 4); assert.equal(w.counts().reads, 4);
  assert.equal((await w.repo.updates(w.recipient, w.profile.id, new Date(T0.getTime() + 1000_000)))[0]?.current, false);
});

test('mixed creators, unreadable latest mail and missing brand mappings withhold activity without inventing deals', async () => {
  for (const mode of ['mixed', 'unreadable', 'unmapped']) {
    const w = await world(); w.setMode(mode);
    if (mode === 'unmapped') await w.db.cognitiveIdentity.update({ where: { id: w.brand }, data: { archivedAt: T0 } });
    await w.start([w.staff.id]); await w.drain();
    assert.equal(w.counts().modelCalls, 0, mode);
    assert.deepEqual(await w.repo.updates(w.recipient, w.profile.id, T0), [], mode);
    const captures = await w.db.managedCreatorMailCapture.findMany();
    assert.ok(captureReadings(captures[0]?.readings).every(r => r.state !== 'CURRENT'), mode);
  }
});

test('automated replies are excluded from substantive conversation evidence', async () => {
  const w = await world(); w.setMode('automated'); await w.start([w.staff.id]); await w.drain();
  assert.equal((await w.repo.updates(w.recipient, w.profile.id, T0))[0]?.stage, 'OUTREACH');
});

test('pause during a model call clears public output and refuses late persistence', async () => {
  const w = await world(); await w.start([w.staff.id]);
  w.modelHook(async () => { await w.repo.pause(w.owner, w.profile.id); });
  await w.drain();
  assert.deepEqual(await w.repo.updates(w.recipient, w.profile.id, T0), []);
  assert.ok((await w.db.managedCreatorMailCapture.findMany()).every(c => !c.enabled && captureReadings(c.readings).length === 0));
});

test('reconnection, offboarding, denies and creator rebinding remove access immediately', async () => {
  for (const mode of ['reconnect', 'offboard', 'deny', 'rebind']) {
    const w = await world(); await w.start(); await w.drain();
    if (mode === 'reconnect') await w.db.managedGoogleMailbox.updateMany({ where: { organizationId: 'a' }, data: { revision: 'new-grant' } });
    if (mode === 'offboard') await w.iam.disableMember('a', w.owner.userId);
    if (mode === 'deny') await w.db.permission.create({ data: { organizationId: 'a', userId: w.owner.userId, resource: 'managedMailboxes', action: 'update', effect: 'DENY' } });
    if (mode === 'rebind') await w.creators.bindUser('a', w.profile.id, w.second.userId);
    assert.deepEqual(await w.repo.updates(w.recipient, w.profile.id, T0), [], mode);
    assert.deepEqual(await w.repo.updates(w.second, w.profile.id, T0), [], mode);
  }
});

test('a refused model leaves a visible pending source and backs off without repeated spend', async () => {
  const w = await world(); w.setMode('budget'); await w.start([w.staff.id]); await w.drain();
  assert.equal(w.counts().modelCalls, 1); assert.deepEqual(await w.service.pass(), {});
  const row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
  assert.equal(row.lastFailureClass, 'MODEL_UNAVAILABLE'); assert.equal(row.pendingThreadIds.length, 1); assert.ok(row.nextCheckAt > T0);
  const projected = await w.repo.updates(w.recipient, w.profile.id, T0);
  assert.ok(projected.every(r => !r.current && !r.summary));
});

test('selection is atomic, cannot include a pending/unrelated source, and only managers can enable capture', async () => {
  const w = await world();
  assert.equal(await w.repo.configure(w.recipient, w.profile.id, [w.staff.id], T0), 'NOT_ALLOWED');
  assert.equal(await w.repo.configure(w.foreign, w.profile.id, [w.staff.id], T0), 'NOT_ALLOWED');
  assert.equal(await w.repo.configure(w.owner, w.profile.id, [w.staff.id, w.fran.id], T0), 'NOT_ALLOWED');
  assert.equal(await w.repo.configure(w.owner, w.other.id, [w.assigned.id], T0), 'NOT_ALLOWED');
  assert.equal(await w.db.managedCreatorMailCapture.count(), 0);
});

test('matching uses whole full names or declared handles, never a first-name substring or a lookalike', () => {
  const p = { id: 'c', displayName: 'Trevon Hill', handle: null, preferences: { socialHandles: { TIKTOK: 'https://www.tiktok.com/@trevonhill' } }, socialAccounts: [] };
  assert.deepEqual(creatorMailAliases(p), ['trevon hill', 'trevonhill']);
  assert.equal(exactMailPhrase('Trevon Hills wrote', 'Trevon Hill'), false);
  assert.equal(exactMailPhrase('Hello @trevonhill!', 'trevonhill'), true);
  const q = creatorMailQuery(p, false, T0)!;
  assert.match(q, /"trevon hill"/); assert.doesNotMatch(creatorMailQuery(p, true, T0)!, /"trevon hill"/);
});
