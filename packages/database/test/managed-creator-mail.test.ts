import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, type PrismaClient } from '@prisma/client';
import { validateCreatorBrandUpdate, AI_TASK_CREATOR_BRAND_UPDATE, parseCreatorBrandUpdate, CREATOR_BRAND_UPDATE_SCHEMA_ID, type GmailThreadView, type AiModelRequest, type AiModelResult } from '@emgloop/shared';
import { IamRepository } from '../src/repositories/iam.repository';
import { PartyService } from '../src/services/party.service';
import { CreatorRepository } from '../src/creator/creator.repository';
import { ManagedCreatorMailRepository, captureReadings } from '../src/creator/managed-creator-mail.repository';
import { ManagedCreatorMailService } from '../src/creator/managed-creator-mail.service';
import { creatorMailAliases, creatorMailQuery, exactMailPhrase, mailEvidenceHash, companyMailDomainMatch } from '../src/creator/creator-mail-matching';
import { AI_ROUTING_POLICY, AI_BUDGET_POLICY } from '@emgloop/providers';
import { AiRuntimeGateway, InMemoryAiUsageLedger, type AiRunRequest } from '../src/services/ai-runtime/gateway';
import type { AiRunResult } from '../src/services/ai-runtime/gateway';
import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { creatorCapturePolicyFailure, creatorCapturePolicyReasons, creatorCaptureOutputFailure, creatorCaptureOutputReasons } from '../src/creator/creator-capture-failure';
import { creatorMailText, creatorMailAttributionText } from '../src/creator/creator-mail-text';
const T0 = new Date('2026-11-02T18:00:00Z');
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
async function world(realRuntime?: { run(principal: { organizationId: string; userId: string }, request: AiRunRequest): Promise<AiRunResult> }) {
  const db = makeCognitivePrisma({ also: ['aiControl', 'aiControlCurrent', 'creatorMailEvidence', 'creatorMailRelationship', 'creatorProfile', 'managedGoogleMailbox', 'managedCreatorMailCapture', 'managedGoogleOAuthState', 'googleConnection', 'googleOAuthState', 'organizationMembership'] }) as unknown as PrismaClient;
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
  let threadHook = (value: GmailThreadView, _threadId?: string) => value;
  let searchIds: string[] | null = null;
  const thread = (): GmailThreadView => ({ threadId: 'PRIVATE_THREAD', messages: [
    { fact: { provider: 'GOOGLE', messageId: 'PRIVATE_MESSAGE_1', threadId: 'PRIVATE_THREAD', internalDate: new Date(T0.getTime() - 2000), labels: ['SENT'], from: { address: staff.expectedEmail, name: 'Matt' }, to: [{ address: 'rep@brand.example', name: 'Rep' }], cc: [{ address: assigned.expectedEmail, name: 'Trevon' }], subject: 'PRIVATE_SUBJECT Brand Bravo and Trevon Hill', headerMessageId: '<physical-pitch@example.test>', inReplyTo: null, references: [], fromSelf: true }, body: { messageId: 'PRIVATE_MESSAGE_1', text: `PRIVATE_BODY Trevon Hill would like to discuss a paid Brand Bravo partnership.${mode === 'mixed' ? ' Other Creator is included too.' : ''}`, html: null, attachments: [], truncated: false } },
    { fact: { provider: 'GOOGLE', messageId: 'PRIVATE_MESSAGE_2', threadId: 'PRIVATE_THREAD', internalDate: new Date(T0.getTime() - 1000), labels: ['INBOX'], from: { address: 'rep@brand.example', name: 'Rep' }, to: [{ address: staff.expectedEmail, name: 'Matt' }], cc: [{ address: assigned.expectedEmail, name: 'Trevon' }], subject: 'PRIVATE_SUBJECT Brand Bravo and Trevon Hill', headerMessageId: '<physical-reply@example.test>', inReplyTo: '<physical-pitch@example.test>', references: [], fromSelf: false, ...(mode === 'automated' ? { automationClass: 'AUTO_SUBMITTED' as const } : {}) }, body: { messageId: 'PRIVATE_MESSAGE_2', text: mode === 'unreadable' ? null : 'PRIVATE_REPLY We would like the creator portfolio to discuss the partnership.', html: null, attachments: [], truncated: false } },
  ] });
  const service = new ManagedCreatorMailService({ repository: repo, now: () => now, mailboxes: {
    searchThreads: async (principal, mailboxId, query) => { searches++; assert.deepEqual(principal, owner); assert.ok([staff.id, assigned.id].includes(mailboxId)); assert.match(query, /-in:spam/); if (mailboxId === staff.id) assert.match(query, /"trevon hill"/); return { ok: true, threadIds: searchIds ?? [mailboxId === staff.id ? 'PRIVATE_STAFF_THREAD' : 'PRIVATE_CREATOR_THREAD'], nextPageToken: null }; },
    readThread: async (principal, _mailboxId, threadId) => { reads++; assert.deepEqual(principal, owner); return { ok: true, thread: threadHook(thread(), threadId) }; },
  }, runtime: realRuntime ?? { run: async (principal, request) => {
    modelCalls++; assert.deepEqual(principal, owner); assert.equal(request.task.taskId, 'creator.brand.update'); assert.ok(request.context.items.every(i => i.readUnder.resource === 'managedMailboxes')); assert.match(request.instructions, /provisional automatic candidate/);
    await modelHook();
    if (mode === 'budget') return { outcome: 'REFUSED_BY_LOOP', refusals: ['TASK_NOT_ENABLED', 'BUDGET_BACKGROUND_DEFERRED'] } as AiRunResult;
    if (mode === 'rejected') return { outcome: 'REJECTED_OUTPUT', rejections: ['UNSUPPORTED_NUMBER_IN_TEXT'] } as unknown as AiRunResult;
    if (mode === 'withheld') return { outcome: 'ANSWERED', output: parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable: false, stage: 'PAUSED', summary: '', nextStep: '', citations: [] }), provenance: {} } as unknown as AiRunResult;
    const citation = request.context.items.find(i => i.sourceRef.startsWith('mail_message:'))!.sourceRef;
    return { outcome: 'ANSWERED', output: parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable: true, stage: mode === 'automated' ? 'OUTREACH' : 'DISCUSSING', summary: 'EMG and the brand are discussing a creator partnership.', nextStep: 'EMG is preparing the creator portfolio.', citations: [citation] }), provenance: {} } as unknown as AiRunResult;
  } } });
  async function start(ids = [staff.id, assigned.id]) { assert.equal(await repo.configure(owner, profile.id, ids, now), 'STARTED'); }
  async function drain() { for (let i = 0; i < 12; i++) if (!Object.keys(await service.pass()).length) return; throw Error('did not drain bounded initial pass'); }
  return { searchIds: (ids: string[]) => { searchIds = ids; }, db, repo, service, iam, creators, owner, recipient, second, foreign, profile, other, brand, staff, assigned, charlie, fran, start, drain, thread, setMode: (v: string) => { mode = v; }, clock: (v: Date) => { now = v; }, threadHook: (v: typeof threadHook) => { threadHook = v; }, modelHook: (v: () => Promise<void>) => { modelHook = v; }, counts: () => ({ modelCalls, searches, reads }) };
}

test('an ordinary body word cannot become the canonical brand Going in a Trevon Cashion conversation', async () => {
  const w = await world();
  await w.db.cognitiveIdentity.update({ where: { id: w.brand }, data: { displayName: 'Going' } });
  w.threadHook(t => ({ ...t, messages: t.messages.map(m => ({ ...m, fact: { ...m.fact, subject: 'Trevon Hill x Cashion Rods Partnership' }, body: { ...m.body, text: 'Trevon Hill: I am going to have to pass at this time.' } })) }));
  await w.start(); await w.drain();
  assert.ok((await w.repo.updates(w.recipient, w.profile.id, T0)).every(r => r.brandId !== w.brand && r.brand !== 'Going'));
});

test('HTML-only sent messages reach governed summarization without publishing source HTML', async () => {
  const w = await world();
  w.threadHook(t => ({ ...t, messages: t.messages.map(m => ({ ...m, body: { ...m.body, text: null, html: '<p>Trevon Hill and Brand Bravo are discussing a partnership.</p><img src="https://tracker.invalid/PRIVATE_TRACKER"><div class="gmail_quote">PRIVATE_QUOTED_HISTORY</div>' } })) }));
  await w.start(); await w.drain();
  assert.equal(w.counts().modelCalls, 2);
  assert.equal((await w.repo.updates(w.recipient, w.profile.id, T0))[0]?.stage, 'DISCUSSING');
  const stored = JSON.stringify(await w.db.managedCreatorMailCapture.findMany());
  assert.doesNotMatch(stored, /<p>|PRIVATE_TRACKER|PRIVATE_QUOTED_HISTORY|discussing a partnership/);
  assert.ok((await w.db.managedCreatorMailCapture.findMany()).every(c => captureReadings(c.readings).every(r => r.incomplete)));
});

test('a shortened subject brand needs an exact whole-company external domain match, not body words', async () => {
  const w = await world();
  await w.db.cognitiveIdentity.update({ where: { id: w.brand }, data: { displayName: 'BRUNT Workwear' } });
  w.threadHook(t => ({ ...t, messages: t.messages.map(m => ({ ...m, fact: { ...m.fact, subject: 'Trevon Hill x BRUNT', from: m.fact.fromSelf ? m.fact.from : { address: 'rep@bruntworkwear.com', name: 'Rep' }, to: m.fact.fromSelf ? [{ address: 'rep@bruntworkwear.com', name: 'Rep' }] : m.fact.to }, body: { ...m.body, text: null, html: '<p>Trevon Hill and BRUNT are discussing a partnership.</p>' } })) }));
  await w.start([w.staff.id]); await w.drain();
  assert.equal(w.counts().modelCalls, 1);
  assert.equal((await w.repo.updates(w.recipient, w.profile.id, T0))[0]?.brandId, w.brand);
  assert.equal(companyMailDomainMatch('Going', ['rep@notgoing.com', 'rep@going.com.attacker.invalid', 'going@gmail.com']), false);
  assert.equal(companyMailDomainMatch('Gmail', ['rep@gmail.com']), false);
  assert.equal(companyMailDomainMatch('BRUNT Workwear', ['rep@news.bruntworkwear.com']), true);
});

test('HTML fallback extracts visible text, strips quotes and active content, and prefers supplied plain text', () => {
  const html = '<html><head><title>PRIVATE_TITLE</title></head><body><p>Brand &amp; creator</p><p>Next step<br>Follow up</p><script>PRIVATE_SCRIPT</script><style>PRIVATE_STYLE</style><img src="https://tracker.invalid/PRIVATE_IMAGE"><a href="https://private.invalid/PRIVATE_LINK">Visible link</a><blockquote>PRIVATE_QUOTE</blockquote><div class="gmail_quote">PRIVATE_HISTORY</div><div class="gmail_signature">PRIVATE_SIGNATURE</div><div hidden>PRIVATE_HIDDEN</div></body></html>';
  const result = creatorMailText({ text: null, html });
  assert.match(result!, /Brand & creator/); assert.match(result!, /Next step\nFollow up/); assert.match(result!, /Visible link/);
  assert.doesNotMatch(result!, /PRIVATE_|https:|<[^>]+>/);
  assert.equal(creatorMailText({ text: 'Plain version', html }), 'Plain version');
  assert.equal(creatorMailText({ text: '', html: '<script>PRIVATE_SCRIPT</script><img src="x">' }), null);
  assert.ok(creatorMailText({ text: null, html: '<p>' + 'word '.repeat(100_000) + '</p>' })!.length <= 4000);
});

test('unaccepted candidate brands never appear in the creator view or manager preview', async () => {
  const w = await world(); w.setMode('budget'); await w.start([w.staff.id]); await w.drain();
  assert.equal(w.counts().modelCalls, 1);
  for (const state of ['MODEL_UNAVAILABLE', 'WITHHELD', 'SOURCE_UNAVAILABLE']) {
    const row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
    await w.db.managedCreatorMailCapture.update({ where: { id: row.id }, data: { readings: [{ ...captureReadings(row.readings)[0], state }] } });
    await w.db.creatorMailEvidence.updateMany({ where: { captureId: row.id }, data: { reading: { ...captureReadings(row.readings)[0], state } } });
    assert.deepEqual(await w.repo.updates(w.recipient, w.profile.id, T0), [], state);
    assert.deepEqual(await w.repo.updates(w.owner, w.profile.id, T0, true), [], state);
  }
});

test('Hope Going subject plus a Trevon footer is not automatic staff attribution', async () => {
  const w = await world();
  await w.db.cognitiveIdentity.update({ where: { id: w.brand }, data: { displayName: 'Going' } });
  w.threadHook(t => ({ ...t, messages: t.messages.map(m => ({ ...m, fact: { ...m.fact, subject: 'Hope Holcer x Going partnership' }, body: { ...m.body, text: 'Discussing Hope Holcer and Going.\n\nOur roster also includes Trevon Hill.' } })) }));
  await w.start([w.staff.id]); await w.drain();
  assert.equal(w.counts().modelCalls, 0);
  assert.deepEqual(await w.repo.updates(w.recipient, w.profile.id, T0), []);
});

test('assigned-mailbox discovery needs no creator keyword; staff attribution needs the creator in subject or body', async () => {
  for (const assigned of [false, true]) {
    const w = await world();
    w.threadHook(t => ({ ...t, messages: t.messages.map(m => ({ ...m, fact: { ...m.fact, subject: 'Brand Bravo partnership' }, body: { ...m.body, text: 'We would like to discuss the partnership.' } })) }));
    await w.start([assigned ? w.assigned.id : w.staff.id]); await w.drain();
    assert.equal(w.counts().modelCalls, assigned ? 1 : 0);
    const row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
    assert.equal(row.query.includes('"trevon hill"'), !assigned);
    assert.equal((await w.repo.updates(w.recipient, w.profile.id, T0)).length, assigned ? 1 : 0);
  }
});

test('withheld and rejected AI results expose no candidate; validation failure is distinct from a Gmail problem', async () => {
  for (const mode of ['withheld', 'rejected']) {
    const w = await world(); w.setMode(mode); await w.start([w.staff.id]); await w.drain();
    assert.deepEqual(await w.repo.updates(w.recipient, w.profile.id, T0), []);
    const row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
    assert.equal(row.lastFailureClass, mode === 'rejected' ? 'MODEL_OUTPUT_REJECTED:UNSUPPORTED_NUMBER_IN_TEXT' : null);
  }
});

test('pre-fix capture scope cannot display cached accepted readings or read another message', async () => {
  const w = await world(); await w.start(); await w.drain();
  assert.equal((await w.repo.updates(w.recipient, w.profile.id, T0)).length, 1);
  const reads = w.counts().reads;
  const oldScopeHash = mailEvidenceHash(JSON.stringify({ version: 1, aliases: creatorMailAliases(w.profile) }));
  await w.db.managedCreatorMailCapture.updateMany({ where: { organizationId: 'a' }, data: { scopeHash: oldScopeHash } });
  assert.deepEqual(await w.repo.updates(w.recipient, w.profile.id, T0), []);
  w.clock(new Date(T0.getTime() + 301_000)); await w.service.pass();
  assert.equal(w.counts().reads, reads);
});

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
    if (mode === 'unmapped') {
      await w.db.cognitiveIdentity.update({ where: { id: w.brand }, data: { archivedAt: T0 } });
      w.threadHook(t => ({ ...t, messages: t.messages.map(m => ({ ...m, fact: { ...m.fact, from: m.fact.fromSelf ? m.fact.from : { address: 'person@gmail.com' }, to: m.fact.fromSelf ? [{ address: 'person@gmail.com' }] : m.fact.to } })) }));
    }
    await w.start([w.staff.id]); await w.drain();
    assert.equal(w.counts().modelCalls, mode === 'unmapped' ? 1 : 0, mode);
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
  assert.equal(row.lastFailureClass, 'MODEL_POLICY_REFUSED:TASK_NOT_ENABLED,BUDGET_BACKGROUND_DEFERRED'); assert.equal(row.pendingThreadIds.length, 1); assert.ok(row.nextCheckAt > T0);
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

test('capture policy diagnostics accept only known admission codes, never arbitrary prose', () => {
  const failure = creatorCapturePolicyFailure(['PRIVATE_PROVIDER_ERROR', 'TASK_NOT_ENABLED', 'TASK_NOT_ENABLED', 'CONTEXT_REFUSED']);
  assert.equal(failure, 'MODEL_POLICY_REFUSED:TASK_NOT_ENABLED,CONTEXT_REFUSED');
  assert.deepEqual(creatorCapturePolicyReasons(failure), ['TASK_NOT_ENABLED', 'CONTEXT_REFUSED']);
  assert.deepEqual(creatorCapturePolicyReasons('MODEL_POLICY_REFUSED:PRIVATE_PROVIDER_ERROR'), []);
  assert.equal(creatorCapturePolicyFailure(['PRIVATE_PROVIDER_ERROR']), 'MODEL_POLICY_REFUSED');
});

test('real gateway task refusal survives capture storage without a provider call or creator publication', async () => {
  let calls = 0;
  const ledger = new InMemoryAiUsageLedger();
  const gateway = new AiRuntimeGateway({
    activation: { enabled: true, organizations: ['a'], tasks: [], providers: ['anthropic', 'openai'] },
    policy: AI_ROUTING_POLICY, budget: AI_BUDGET_POLICY, killSwitches: [], maxAttemptsPerTarget: 1,
  }, {
    providers: ['anthropic', 'openai'].map(providerId => ({ providerId, invoke: async () => { calls++; throw Error('must not call'); } })),
    ledger, authorize: async () => true, now: () => T0, newInvocationId: () => 'fixture',
    providerPolicies: async () => ['anthropic', 'openai'].map(providerId => ({ providerId, state: 'ACTIVE' as const, ceiling: 'COMMUNICATION_CONTENT' as const, version: 1, recordedAtMs: T0.getTime() })),
  });
  const w = await world(gateway);
  await w.start([w.staff.id]); await w.drain();
  const row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
  assert.equal(row.lastFailureClass, 'MODEL_POLICY_REFUSED:TASK_NOT_ENABLED');
  assert.equal(calls, 0); assert.equal(ledger.calls.length, 0);
  assert.equal(row.nextCheckAt.getTime(), T0.getTime() + 3600_000);
  assert.deepEqual(await w.repo.updates(w.recipient, w.profile.id, T0), []);
});

function validatingRuntime(reply: (request: AiModelRequest, ordinal: number) => Promise<AiModelResult>) {
  const ledger = new InMemoryAiUsageLedger();
  const requests: AiModelRequest[] = [];
  let invocation = 0;
  const gateway = new AiRuntimeGateway({
    activation: { enabled: true, organizations: ['a'], tasks: ['creator.brand.update'], providers: ['anthropic', 'openai'] },
    policy: AI_ROUTING_POLICY, budget: AI_BUDGET_POLICY, killSwitches: [], maxAttemptsPerTarget: 1,
  }, {
    providers: ['anthropic', 'openai'].map(providerId => ({ providerId, invoke: async (request: AiModelRequest) => { requests.push(request); return reply(request, requests.length); } })),
    ledger, authorize: async () => true, now: () => T0, newInvocationId: () => `fixture-${++invocation}`,
    providerPolicies: async () => ['anthropic', 'openai'].map(providerId => ({ providerId, state: 'ACTIVE' as const, ceiling: 'COMMUNICATION_CONTENT' as const, version: 1, recordedAtMs: T0.getTime() })),
  });
  return { gateway, ledger, requests };
}
function modelReply(request: AiModelRequest, summary: string, stopReason: AiModelResult['stopReason'] = 'END'): AiModelResult {
  const ref = request.input.find(item => item.sourceRef.startsWith('mail_message:'))!.sourceRef;
  return { output: { json: { schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable: true, stage: 'DISCUSSING', summary, nextStep: '', citations: [ref] } },
    toolCalls: [], stopReason, usage: { inputTokens: 100, outputTokens: 100 }, providerRequestId: 'fixture-request', reportedModel: request.model.modelId, latencyMs: 1 };
}

test('real gateway repairs a rejected summary once and publishes only the newly validated paraphrase', async () => {
  const runtime = validatingRuntime(async (request, ordinal) => modelReply(request, ordinal === 1 ? 'PRIVATE_REJECTED_SUMMARY costs $500.' : 'EMG is discussing a collaboration with the brand.'));
  const w = await world(runtime.gateway); await w.start([w.staff.id]); await w.drain();
  assert.equal(runtime.requests.length, 2);
  assert.match(runtime.requests[1]!.instructions, /VERBATIM_CONTENT/);
  assert.doesNotMatch(JSON.stringify(runtime.requests[1]), /PRIVATE_REJECTED_SUMMARY/);
  assert.deepEqual(runtime.requests[1]!.input, runtime.requests[0]!.input);
  assert.deepEqual(runtime.ledger.calls.map(c => c.reconciliation?.outcome), ['REJECTED_BY_LOOP', 'ANSWERED']);
  const rows = await w.repo.updates(w.recipient, w.profile.id, T0);
  assert.equal(rows[0]?.summary, 'EMG is discussing a collaboration with the brand.');
  assert.doesNotMatch(JSON.stringify(await w.db.managedCreatorMailCapture.findMany()), /PRIVATE_REJECTED_SUMMARY/);
});

test('two rejected outputs stop at two calls and retain a per-thread validation cooldown', async () => {
  const runtime = validatingRuntime(async request => modelReply(request, 'PRIVATE_REJECTED_SUMMARY costs $500.'));
  const w = await world(runtime.gateway); await w.start([w.staff.id]); await w.drain();
  assert.equal(runtime.requests.length, 2);
  const row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
  assert.deepEqual(creatorCaptureOutputReasons(row.lastFailureClass!), ['UNSUPPORTED_NUMBER_IN_TEXT', 'VERBATIM_CONTENT']);
  assert.equal(row.pendingThreadIds.length, 0);
  assert.equal(row.nextCheckAt.getTime(), T0.getTime() + 300_000);
  assert.equal(captureReadings(row.readings)[0]!.retryAfter, new Date(T0.getTime() + 3600_000).toISOString());
  assert.deepEqual(await w.repo.updates(w.recipient, w.profile.id, T0), []);
  assert.equal(creatorCaptureOutputFailure(['PRIVATE_ERROR_TEXT']), 'MODEL_OUTPUT_REJECTED');
  assert.deepEqual(creatorCaptureOutputReasons('MODEL_OUTPUT_REJECTED:PRIVATE_ERROR_TEXT'), []);
});

test('model refusal is final and never triggers a repair or provider shopping', async () => {
  const runtime = validatingRuntime(async request => modelReply(request, '', 'REFUSAL'));
  const w = await world(runtime.gateway); await w.start([w.staff.id]); await w.drain();
  assert.equal(runtime.requests.length, 1);
  assert.equal((await w.db.managedCreatorMailCapture.findMany())[0]!.lastFailureClass, 'MODEL_REFUSED');
  assert.deepEqual(await w.repo.updates(w.recipient, w.profile.id, T0), []);
});

test('scope withdrawal after rejection prevents the repair and any late publication', async () => {
  let w: Awaited<ReturnType<typeof world>>;
  const runtime = validatingRuntime(async request => { await w.repo.pause(w.owner, w.profile.id); return modelReply(request, 'PRIVATE_REJECTED_SUMMARY costs $500.'); });
  w = await world(runtime.gateway); await w.start([w.staff.id]); await w.drain();
  assert.equal(runtime.requests.length, 1);
  assert.deepEqual(await w.repo.updates(w.recipient, w.profile.id, T0), []);
});

test('a rejected thread cannot block a healthy thread or retry early during later search cycles', async () => {
  const runtime = validatingRuntime(async (request, ordinal) => modelReply(request,
    ordinal <= 2 ? 'Unsupported 2027 claim.' : 'EMG is discussing a collaboration with the brand.'));
  const w = await world(runtime.gateway);
  w.searchIds(['PRIVATE_BAD_THREAD', 'PRIVATE_HEALTHY_THREAD']);
  await w.start([w.staff.id]); await w.drain();
  assert.equal(runtime.requests.length, 3, 'two failed attempts for one thread, then one accepted healthy thread');
  let row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
  let failed = captureReadings(row.readings).find(r => r.threadId === 'PRIVATE_BAD_THREAD')!;
  assert.equal(failed.state, 'MODEL_UNAVAILABLE');
  assert.deepEqual(failed.rejections, ['UNSUPPORTED_NUMBER_IN_TEXT']);
  assert.equal(failed.retryAfter, new Date(T0.getTime() + 3600_000).toISOString());
  assert.equal((await w.repo.updates(w.recipient, w.profile.id, T0))[0]?.summary, 'EMG is discussing a collaboration with the brand.');
  const readsBefore = w.counts().reads;
  for (const minute of [5, 10]) {
    w.clock(new Date(T0.getTime() + minute * 60_000)); await w.drain();
    assert.equal(runtime.requests.length, 3, 'no model retry during the rejected thread cooldown');
    row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
    const kept = captureReadings(row.readings).find(r => r.threadId === 'PRIVATE_BAD_THREAD')!;
    assert.equal(kept.retryAfter, failed.retryAfter, 'skipping a queued cooldown never extends it');
    assert.equal(kept.checkedAt, failed.checkedAt, 'actual failed-attempt time remains accurate');
  }
  assert.equal(w.counts().reads, readsBefore + 2, 'cooling thread is skipped before Gmail reads; healthy thread still checked');
  w.clock(new Date(T0.getTime() + 3600_000)); await w.drain();
  assert.equal(runtime.requests.length, 4, 'failed thread becomes eligible again at its own deadline');
  row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
  failed = captureReadings(row.readings).find(r => r.threadId === 'PRIVATE_BAD_THREAD')!;
  assert.equal(failed.state, 'CURRENT');
  assert.equal(failed.retryAfter, undefined);
  assert.equal(failed.rejections, undefined);
});

test('the bounded reading cache retains validation cooldowns when other source checks fill it', async () => {
  const runtime = validatingRuntime(async request => modelReply(request, 'Unsupported 2027 claim.'));
  const w = await world(runtime.gateway); await w.start([w.staff.id]); await w.drain();
  const at = new Date(T0.getTime() + 300_000);
  w.clock(at);
  let row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
  const failed = captureReadings(row.readings)[0]!;
  for (let i = 0; i < 101; i++) {
    const claimed = await w.repo.claim(w.owner, row.id, at);
    assert.ok(claimed);
    assert.equal(await w.repo.finish(claimed!, at, { reading: { ...failed, threadId: `other-${i}`, state: 'SOURCE_UNAVAILABLE', retryAfter: undefined, rejections: undefined }, delayMs: 0 }), true);
  }
  row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
  const kept = captureReadings(row.readings);
  assert.equal(kept.length, 102);
  assert.equal((await w.repo.durableReadings(row)).length, 102);
  assert.equal(kept.find(r => r.threadId === failed.threadId)?.retryAfter, failed.retryAfter);
  assert.equal(runtime.requests.length, 2);
});

test('staff body-only creator names and saved handles reach AI even with a generic subject', async () => {
  for (const identity of ['Trevon Hill', '@trevonhill']) {
    const w = await world();
    w.threadHook(t => ({ ...t, messages: t.messages.map(m => ({ ...m, fact: { ...m.fact, subject: 'Brand Bravo partnership' }, body: { ...m.body, text: `We are discussing a collaboration with ${identity}.` } })) }));
    await w.start([w.staff.id]); await w.drain();
    assert.equal(w.counts().modelCalls, 1, identity);
    assert.equal((await w.repo.updates(w.recipient, w.profile.id, T0))[0]?.stage, 'DISCUSSING');
  }
});

test('a name found only in signatures, roster footer or quoted history cannot bind staff mail', async () => {
  for (const body of [
    'We are discussing a partnership.\n\nBest,\nTrevon Hill',
    'We are discussing a partnership.\n\nOur roster:\nTrevon Hill',
    'We are discussing a partnership.\n\nOur roster also includes Trevon Hill.',
    'We are discussing a partnership.\nOn Monday someone wrote:\nTrevon Hill',
    'We are discussing a partnership.\n> Trevon Hill',
  ]) {
    const w = await world();
    w.threadHook(t => ({ ...t, messages: t.messages.map(m => ({ ...m, fact: { ...m.fact, subject: 'Brand Bravo partnership' }, body: { ...m.body, text: body } })) }));
    await w.start([w.staff.id]); await w.drain();
    assert.equal(w.counts().modelCalls, 0, body);
    assert.deepEqual(await w.repo.updates(w.recipient, w.profile.id, T0), []);
  }
  assert.match(creatorMailAttributionText('Thanks for considering Trevon Hill for this partnership.'), /Trevon Hill/);
});

test('body-only mixed creator discussions are withheld before AI', async () => {
  const w = await world();
  w.threadHook(t => ({ ...t, messages: t.messages.map(m => ({ ...m, fact: { ...m.fact, subject: 'Brand Bravo partnership' }, body: { ...m.body, text: 'We are discussing Trevon Hill and Other Creator for the partnership.' } })) }));
  await w.start([w.staff.id]); await w.drain();
  assert.equal(w.counts().modelCalls, 0);
  assert.equal(captureReadings((await w.db.managedCreatorMailCapture.findMany())[0]!.readings)[0]?.state, 'MIXED_CREATORS');
});

test('explicit staff keywords replace inferred aliases and accept exactly the three requested Trevon variations', async () => {
  for (const identity of ['Trevon Hill', 'Trevon', 'trevonbassmaster']) {
    for (const location of ['subject', 'body']) {
      const w = await world();
      w.threadHook(t => ({ ...t, messages: t.messages.map(m => ({ ...m, fact: { ...m.fact, subject: `Brand Bravo partnership${location === 'subject' ? ` with ${identity}` : ''}` }, body: { ...m.body, text: location === 'body' ? `A collaboration with ${identity} is being discussed.` : 'A collaboration is being discussed.' } })) }));
      assert.equal(await w.repo.configure(w.owner, w.profile.id, [w.staff.id], T0, ['Trevon Hill', 'Trevon', 'trevonbassmaster']), 'STARTED');
      const saved = await w.db.creatorProfile.findFirst({ where: { id: w.profile.id } });
      assert.deepEqual(creatorMailAliases(saved!), ['trevon', 'trevon hill', 'trevonbassmaster']);
      assert.equal(creatorMailQuery(saved!, true, T0)!.includes('trevon'), false);
      assert.equal(exactMailPhrase('Trevonhill', 'trevon'), false);
      assert.equal(exactMailPhrase('Trevonbassmasters', 'trevonbassmaster'), false);
      await w.drain();
      assert.equal(w.counts().modelCalls, 1, `${identity} in ${location}`);
      assert.equal((await w.repo.updates(w.recipient, w.profile.id, T0)).length, 1);
    }
  }
});

test('keyword changes are scoped, validated and atomic with source authorization', async () => {
  const w = await world();
  const before = await w.repo.staffKeywords(w.owner, w.profile.id);
  assert.equal(await w.repo.configure(w.foreign, w.profile.id, [w.staff.id], T0, ['Trevon']), 'NOT_ALLOWED');
  assert.equal(await w.repo.configure(w.recipient, w.profile.id, [w.staff.id], T0, ['Trevon']), 'NOT_ALLOWED');
  assert.equal(await w.repo.configure(w.owner, w.profile.id, [w.staff.id, w.fran.id], T0, ['Trevon']), 'NOT_ALLOWED');
  for (const words of [[], [''], ['Trevon" OR after:0'], Array.from({ length: 21 }, (_, i) => `name${i}`)]) {
    assert.equal(await w.repo.configure(w.owner, w.profile.id, [w.staff.id], T0, words), 'INVALID');
  }
  assert.deepEqual(await w.repo.staffKeywords(w.owner, w.profile.id), before);
  assert.equal(await w.repo.staffKeywords(w.foreign, w.profile.id), null);
  assert.equal(await w.repo.configure(w.owner, w.profile.id, [w.staff.id, w.assigned.id], T0, ['Trevon Hill', 'Trevon', 'trevonbassmaster']), 'STARTED');
  const rows = await w.db.managedCreatorMailCapture.findMany();
  assert.match(rows.find(r => r.mailboxId === w.staff.id)!.query, /\{"trevon" "trevon hill" "trevonbassmaster"\}/);
  assert.doesNotMatch(rows.find(r => r.mailboxId === w.assigned.id)!.query, /trevon/);
  assert.deepEqual(await w.repo.staffKeywords(w.owner, w.other.id), creatorMailAliases(w.other));
  assert.deepEqual(await w.service.pass(), { CAPTURE_LISTED: 1 });
  await w.drain();
  assert.equal(w.counts().modelCalls, 2);
});

test('creator refresh queues only their bound sources, coalesces clicks and preserves backfill/cooldown', async () => {
  const w = await world(); await w.start();
  const rows = await w.db.managedCreatorMailCapture.findMany();
  for (const row of rows) await w.db.managedCreatorMailCapture.update({ where: { id: row.id }, data: { nextPageToken: 'historical-page', pendingThreadIds: ['historical-thread'], lastFailureClass: 'MODEL_CALL_FAILED', nextCheckAt: new Date(T0.getTime() + 3600_000) } });
  assert.equal(await w.repo.requestRefresh(w.second, w.profile.id, T0, true), false);
  assert.equal(await w.repo.requestRefresh(w.foreign, w.profile.id, T0, true), false);
  assert.equal(await w.repo.requestRefresh(w.recipient, w.profile.id, T0, true), true);
  assert.equal(await w.repo.requestRefresh(w.recipient, w.profile.id, T0, true), true);
  for (const row of await w.db.managedCreatorMailCapture.findMany()) {
    assert.equal(row.refreshActive, true); assert.equal(row.nextPageToken, 'historical-page');
    assert.deepEqual(row.pendingThreadIds, ['historical-thread']); assert.equal(row.nextCheckAt.getTime(), T0.getTime() + 3600_000);
  }
});

test('7am America/New_York daily refresh handles daylight saving and queues once per local day', async () => {
  for (const [before, after] of [['2026-11-05T11:59:00Z', '2026-11-05T12:00:00Z'], ['2026-07-05T10:59:00Z', '2026-07-05T11:00:00Z']]) {
    const w = await world(); await w.start();
    await w.repo.morningRefresh(new Date(before!));
    assert.ok((await w.db.managedCreatorMailCapture.findMany()).every(r => !r.refreshActive));
    await w.repo.morningRefresh(new Date(after!));
    const rows = await w.db.managedCreatorMailCapture.findMany();
    assert.ok(rows.every(r => r.refreshActive));
    await w.repo.morningRefresh(new Date(new Date(after!).getTime() + 60_000));
    assert.deepEqual((await w.db.managedCreatorMailCapture.findMany()).map(r => r.refreshStartedAt), rows.map(r => r.refreshStartedAt));
  }
});

test('incremental refresh drains its cursor and resumes the original historical queue', async () => {
  const w = await world(); await w.start([w.staff.id]);
  let row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
  await w.db.managedCreatorMailCapture.update({ where: { id: row.id }, data: { pendingThreadIds: ['historical-next'], nextPageToken: 'older-page' } });
  assert.equal(await w.repo.requestRefresh(w.recipient, w.profile.id, T0, true), true);
  await w.service.pass(); await w.service.pass();
  w.clock(new Date(T0.getTime() + 301_000)); await w.service.pass();
  row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
  assert.equal(row.refreshActive, false); assert.equal(row.nextPageToken, 'older-page');
  assert.deepEqual(row.pendingThreadIds, ['historical-next']); assert.equal(row.lastRefreshAt?.toISOString(), T0.toISOString());
});

async function distinctRelationshipConversation(w: Awaited<ReturnType<typeof world>>) {
  const row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
  const reading = (await w.repo.durableReadings(row))[0]!;
  await w.db.creatorMailEvidence.create({ data: { id: 'distinct-conversation', captureId: row.id, generation: row.generation, threadId: 'distinct-conversation', reading: { ...reading, threadId: 'distinct-conversation', evidenceKey: 'distinct-message', fingerprint: 'distinct-version' } } });
}

test('single conversations and duplicate mailbox copies use existing summaries without synthesis calls', async () => {
  const { CreatorRelationshipService } = await import('../src/creator/creator-relationship.service');
  for (const copies of [false, true]) {
    const w = await world(); await w.start(copies ? undefined : [w.staff.id]); await w.drain();
    let calls = 0;
    const service = new CreatorRelationshipService(w.db, { run: async () => { calls++; throw Error('unnecessary synthesis'); } }, () => T0);
    assert.deepEqual(await service.pass(), {});
    assert.equal(calls, 0);
    assert.equal((await w.repo.updates(w.recipient, w.profile.id, T0)).length, 1);
    assert.deepEqual(await service.projections(w.recipient, w.profile.id), []);
    assert.equal((await w.db.creatorMailRelationship.findMany()).length, 0);
  }
});

test('cross-mailbox relationship synthesis publishes one version and revocation invalidates it', async () => {
  const { CreatorRelationshipService } = await import('../src/creator/creator-relationship.service');
  const w = await world(); await w.start(); await w.drain();
  await distinctRelationshipConversation(w);
  let calls = 0;
  const service = new CreatorRelationshipService(w.db, { run: async (_actor, request) => {
    calls++; assert.equal(request.templateId, 'creator-relationship-synthesis');
    assert.ok(request.context.items.every(i => i.readUnder.resource === 'managedMailboxes'));
    const ref = request.context.items.find(i => i.sourceRef.startsWith('mail_message:'))!.sourceRef;
    return { outcome: 'ANSWERED', output: parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable: true, stage: 'AWAITING_BRAND', summary: 'EMG has shared the portfolio and is awaiting the brand response.', nextStep: 'Await the brand response.', citations: [ref] })!, provenance: {} } as AiRunResult;
  } }, () => T0);
  assert.deepEqual(await service.pass(), { SYNTHESIZED: 1 });
  const updates = await service.projections(w.recipient, w.profile.id);
  assert.equal(updates.length, 1); assert.equal(updates[0]?.synthesized, true);
  assert.deepEqual(await service.pass(), {}); assert.equal(calls, 1);
  assert.deepEqual(await service.projections(w.second, w.profile.id), []);
  await w.db.managedGoogleMailbox.update({ where: { id: w.staff.id }, data: { status: 'DISCONNECTED' } });
  assert.deepEqual(await service.projections(w.recipient, w.profile.id), []);
});

test('relationship synthesis refusal remains private and backs off without repeated spend', async () => {
  const { CreatorRelationshipService } = await import('../src/creator/creator-relationship.service');
  const w = await world(); await w.start(); await w.drain(); await distinctRelationshipConversation(w); let calls = 0;
  const service = new CreatorRelationshipService(w.db, { run: async () => { calls++; return { outcome: 'REFUSED_BY_LOOP', refusals: ['BUDGET_BACKGROUND_DEFERRED'] }; } }, () => T0);
  assert.deepEqual(await service.pass(), { NOT_PUBLISHED: 1 });
  assert.deepEqual(await service.projections(w.recipient, w.profile.id), []);
  assert.deepEqual(await service.pass(), {}); assert.equal(calls, 1);
});

test('historical pagination resumes beyond 500 without skipping the rest of a Gmail page', async () => {
  const w = await world(); await w.start([w.staff.id]);
  let clock = T0; const read: string[] = [], pages: string[] = [];
  const ids = Array.from({ length: 551 }, (_, i) => `thread-${i}`);
  const service = new ManagedCreatorMailService({ repository: w.repo, now: () => clock, runtime: { run: async () => { throw Error('unreadable sources cannot call AI'); } }, mailboxes: {
    searchThreads: async (_principal, _mailbox, query, token) => {
      assert.doesNotMatch(query, /after:/); const offset = token ? Number(token) : 0; pages.push(String(offset));
      return { ok: true, threadIds: ids.slice(offset, offset + 87), nextPageToken: offset + 87 < ids.length ? String(offset + 87) : null };
    },
    readThread: async (_principal, _mailbox, id) => { read.push(id); return { ok: false, failure: 'UNAVAILABLE' }; },
  } });
  for (let step = 0; step < 600 && read.length < ids.length; step++) {
    await service.pass(); clock = new Date(clock.getTime() + 1000); w.clock(clock);
    const row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
    if (row.nextCheckAt > clock) { clock = row.nextCheckAt; w.clock(clock); }
  }
  assert.deepEqual(read, ids); assert.equal(new Set(read).size, 551);
  assert.deepEqual(pages, ['0', '87', '174', '261', '348', '435', '522']);
});

test('multi-batch synthesis remains private until all evidence is folded, and new versions invalidate it', async () => {
  const { CreatorRelationshipService } = await import('../src/creator/creator-relationship.service');
  const w = await world(); await w.start([w.staff.id]); await w.drain();
  const row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
  const reading = (await w.repo.durableReadings(row))[0]!;
  for (let i = 0; i < 20; i++) await w.db.creatorMailEvidence.create({ data: { id: `extra-${i}`, captureId: row.id, generation: row.generation, threadId: `extra-${i}`, reading: { ...reading, threadId: `extra-${i}`, evidenceKey: `physical-${i}`, fingerprint: `version-${i}` } } });
  let calls = 0;
  const service = new CreatorRelationshipService(w.db, { run: async (_actor, request) => {
    calls++; assert.ok(request.context.items.filter(i => i.sourceRef.startsWith('mail_message:')).length <= 17);
    const ref = request.context.items.find(i => i.sourceRef.startsWith('mail_message:'))!.sourceRef;
    return { outcome: 'ANSWERED', output: parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable: true, stage: 'DISCUSSING', summary: 'The brand and EMG are discussing a collaboration.', nextStep: '', citations: [ref] })!, provenance: {} } as AiRunResult;
  } }, () => T0);
  assert.deepEqual(await service.pass(), { SYNTHESIS_PROGRESS: 1 });
  assert.deepEqual(await service.projections(w.recipient, w.profile.id), []);
  assert.deepEqual(await service.pass(), { SYNTHESIZED: 1 });
  assert.equal((await service.projections(w.recipient, w.profile.id)).length, 1); assert.equal(calls, 2);
  // A later distinct conversation folds only the new reading plus the prior aggregate.
  await w.db.creatorMailEvidence.create({ data: { id: 'later', captureId: row.id, generation: row.generation, threadId: 'later', reading: { ...reading, threadId: 'later', evidenceKey: 'later-message', fingerprint: 'later-version', evidenceAt: '2026-11-06T12:00:00.000Z' } } });
  const incremental = new CreatorRelationshipService(w.db, { run: async (_actor, request) => {
    assert.equal(request.context.items.filter(i => i.sourceRef.startsWith('mail_message:')).length, 2);
    const ref = request.context.items.find(i => i.sourceRef.startsWith('mail_message:'))!.sourceRef;
    return { outcome: 'ANSWERED', output: parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable: true, stage: 'DISCUSSING', summary: 'EMG and the brand continue discussing a collaboration.', nextStep: '', citations: [ref] })!, provenance: {} } as AiRunResult;
  } }, () => T0);
  assert.deepEqual(await incremental.pass(), { SYNTHESIZED: 1 });
  assert.equal((await incremental.projections(w.recipient, w.profile.id)).length, 1);
  await w.db.creatorMailEvidence.update({ where: { id: 'extra-0' }, data: { reading: { ...reading, threadId: 'extra-0', evidenceKey: 'physical-0', fingerprint: 'new-version' } } });
  assert.deepEqual(await service.projections(w.recipient, w.profile.id), []);
});

test('AI resolves an advertiser named in partnership evidence instead of publishing its agency domain', async () => {
  const w = await world({ run: async (_principal, request) => {
    const ref = request.context.items.find(i => i.sourceRef.startsWith('mail_message:'))!.sourceRef;
    return { outcome: 'ANSWERED', output: parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable: true, brandName: 'River Tackle', stage: 'DISCUSSING', summary: 'The brand and EMG are exploring a collaboration.', nextStep: '', citations: [ref] })!, provenance: {} } as AiRunResult;
  } });
  w.threadHook(t => ({ ...t, messages: t.messages.map(m => ({ ...m, fact: { ...m.fact, subject: 'Trevon Hill partnership', from: m.fact.fromSelf ? m.fact.from : { address: 'rep@agencyhouse.com' }, to: m.fact.fromSelf ? [{ address: 'rep@agencyhouse.com' }] : m.fact.to }, body: { ...m.body, text: 'Trevon Hill partnership with River Tackle: could EMG send the creator portfolio?' } })) }));
  await w.start(); await w.drain();
  const rows = await w.repo.updates(w.recipient, w.profile.id, T0);
  assert.equal(rows.length, 1); assert.equal(rows[0]?.brand, 'River Tackle');
  assert.doesNotMatch(JSON.stringify(rows), /agencyhouse|rep@|PRIVATE_/);
});

test('a personal-address representative can identify an explicit advertiser, but hallucinated names are withheld', async () => {
  for (const actual of ['River Tackle', 'Invented Advertiser']) {
    const w = await world({ run: async (_principal, request) => {
      const ref = request.context.items.find(i => i.sourceRef.startsWith('mail_message:'))!.sourceRef;
      return { outcome: 'ANSWERED', output: parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable: true, brandName: actual, stage: 'DISCUSSING', summary: 'A creator collaboration is being discussed.', nextStep: '', citations: [ref] })!, provenance: {} } as AiRunResult;
    } });
    w.threadHook(t => ({ ...t, messages: t.messages.map(m => ({ ...m, fact: { ...m.fact, subject: 'Trevon Hill partnership', from: m.fact.fromSelf ? m.fact.from : { address: 'rep@gmail.com' }, to: m.fact.fromSelf ? [{ address: 'rep@gmail.com' }] : m.fact.to }, body: { ...m.body, text: 'Trevon Hill partnership with River Tackle: please send the creator portfolio.' } })) }));
    await w.start(); await w.drain();
    const rows = await w.repo.updates(w.recipient, w.profile.id, T0);
    assert.equal(rows.length, actual === 'River Tackle' ? 1 : 0);
  }
});

test('migration rollout preserves existing creator summaries while new queues report not ready', async () => {
  const w = await world(); await w.start(); await w.drain();
  const evidenceDelegate = w.db.creatorMailEvidence;
  const original = evidenceDelegate.findMany;
  evidenceDelegate.findMany = async () => { throw new Prisma.PrismaClientKnownRequestError('table absent', { code: 'P2021', clientVersion: '5.22.0' }); };
  assert.equal((await w.repo.updates(w.recipient, w.profile.id, T0)).length, 1);
  evidenceDelegate.findMany = original;
  const captures = w.db.managedCreatorMailCapture, originalFind = captures.findMany;
  captures.findMany = async () => { throw new Prisma.PrismaClientKnownRequestError('column absent', { code: 'P2022', clientVersion: '5.22.0' }); };
  assert.equal(await w.repo.ready(), false);
  captures.findMany = originalFind;
});

test('legacy domain-only agency readings cannot publish or enter synthesis without an advertiser resolution', async () => {
  const w = await world(); await w.start([w.staff.id]); await w.drain();
  const capture = (await w.db.managedCreatorMailCapture.findMany())[0]!;
  const reading = captureReadings(capture.readings)[0]!;
  const legacy = { ...reading, brandId: null, candidateBrandName: 'agencyhouse' };
  await w.db.managedCreatorMailCapture.update({ where: { id: capture.id }, data: { readings: [legacy] } });
  await w.db.creatorMailEvidence.updateMany({ where: { captureId: capture.id }, data: { reading: legacy } });
  assert.deepEqual(await w.repo.updates(w.recipient, w.profile.id, T0), []);
  const { CreatorRelationshipService } = await import('../src/creator/creator-relationship.service');
  const service = new CreatorRelationshipService(w.db, { run: async () => { throw Error('unresolved legacy advertiser cannot call synthesis'); } }, () => T0);
  assert.deepEqual(await service.pass(), {});
});

test('incremental synthesis reuses only an unchanged chronological and authorized prefix', async () => {
  const { relationshipBasis, relationshipContinuation, relationshipVersion } = await import('../src/creator/creator-relationship');
  const w = await world(); await w.start([w.staff.id]); await w.drain();
  const row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
  const reading = (await w.repo.durableReadings(row))[0]!;
  const first = { captureId: row.id, generation: row.generation, scopeHash: row.scopeHash, reading };
  const second = { ...first, reading: { ...reading, threadId: 'second', fingerprint: 'second', evidenceKey: 'second', evidenceAt: '2026-11-04T12:00:00Z' } };
  const old = [first, second];
  const fingerprint = relationshipVersion(old);
  const record = { fingerprint, processed: 2, history: [{ fingerprint, ...relationshipBasis(old) }] };
  const later = { ...first, reading: { ...reading, threadId: 'later', fingerprint: 'later', evidenceKey: 'later', evidenceAt: '2026-11-06T12:00:00Z' } };
  assert.equal(relationshipContinuation(record, [...old, later]), 2);
  assert.equal(relationshipContinuation(record, [second, later]), 0, 'withdrawn source cannot reuse its summary');
  assert.equal(relationshipContinuation(record, [{ ...first, generation: 'reassigned' }, second, later]), 0);
  assert.equal(relationshipContinuation(record, [{ ...first, scopeHash: 'revoked' }, second, later]), 0);
  assert.equal(relationshipContinuation(record, [{ ...first, reading: { ...reading, fingerprint: 'changed' } }, second, later]), 0);
  assert.equal(relationshipContinuation(record, [...old, { ...later, reading: { ...later.reading, evidenceAt: '2020-01-01T12:00:00Z' } }]), 0, 'older backfill must rebuild chronology');
  assert.equal(relationshipContinuation({ ...record, history: [{ fingerprint }] }, [...old, later]), 0, 'legacy aggregates have no verifiable reuse basis');
});

test('new recorded budgets wake old quota retries once, preserving cursors, leases and unrelated backoffs', async () => {
  const { AI_OPERATING_BUDGET_INITIAL } = await import('@emgloop/shared');
  const w = await world(); await w.start();
  const rows = await w.db.managedCreatorMailCapture.findMany();
  const changedAt = new Date(T0.getTime() + 120_000), wakeAt = new Date(changedAt.getTime() + 60_000);
  for (const row of rows) await w.db.managedCreatorMailCapture.update({ where: { id: row.id }, data: { lastCheckedAt: T0, lastFailureClass: 'MODEL_POLICY_REFUSED:BUDGET_TASK_EXHAUSTED', nextCheckAt: new Date(T0.getTime() + 3600_000), pendingThreadIds: ['kept-thread'], nextPageToken: 'kept-page' } });
  await w.repo.resumeAfterBudgetChange(wakeAt);
  assert.ok((await w.db.managedCreatorMailCapture.findMany()).every(r => r.nextCheckAt > wakeAt), 'no recorded budget never wakes retries');
  await w.db.aiControl.create({ data: { id: 'budget-change', controlKey: 'BUDGET|-|operating', version: 1, scope: 'BUDGET', value: 'operating', state: 'ACTIVE', reason: 'Authorized capacity increase', actorKind: 'OPERATIONS', settings: AI_OPERATING_BUDGET_INITIAL as unknown as Prisma.InputJsonValue, recordedAt: changedAt } });
  await w.db.aiControlCurrent.create({ data: { controlKey: 'BUDGET|-|operating', version: 1, scope: 'BUDGET', value: 'operating' } });
  await w.db.creatorMailRelationship.create({ data: { id: 'waiting-fold', organizationId: 'a', creatorProfileId: w.profile.id, brandId: w.brand, fingerprint: 'unchanged', updatedAt: T0, nextCheckAt: new Date(T0.getTime() + 3600_000), lastFailureClass: 'REFUSED_BY_LOOP' } });
  await w.repo.resumeAfterBudgetChange(new Date(changedAt.getTime() + 59_000));
  assert.ok((await w.db.managedCreatorMailCapture.findMany()).every(r => r.nextCheckAt > wakeAt), 'wait for gateway cache expiry');
  await w.db.managedCreatorMailCapture.update({ where: { id: rows[1]!.id }, data: { leaseToken: 'active', leaseUntil: new Date(wakeAt.getTime() + 60_000) } });
  await w.repo.resumeAfterBudgetChange(wakeAt);
  assert.equal((await w.db.creatorMailRelationship.findMany())[0]!.nextCheckAt.getTime(), wakeAt.getTime());
  let live = (await w.db.managedCreatorMailCapture.findMany()).find(r => r.id === rows[0]!.id)!;
  assert.equal(live.nextCheckAt.getTime(), wakeAt.getTime()); assert.deepEqual(live.pendingThreadIds, ['kept-thread']); assert.equal(live.nextPageToken, 'kept-page');
  assert.ok((await w.db.managedCreatorMailCapture.findMany()).find(r => r.id === rows[1]!.id)!.nextCheckAt > wakeAt, 'active lease untouched');
  // An admission refusal after the new budget must retain its own cooldown.
  await w.db.managedCreatorMailCapture.update({ where: { id: live.id }, data: { lastCheckedAt: wakeAt, nextCheckAt: new Date(wakeAt.getTime() + 3600_000) } });
  await w.repo.resumeAfterBudgetChange(new Date(wakeAt.getTime() + 1000));
  live = (await w.db.managedCreatorMailCapture.findMany()).find(r => r.id === live.id)!;
  assert.ok(live.nextCheckAt > wakeAt);
  await w.db.managedCreatorMailCapture.update({ where: { id: live.id }, data: { lastCheckedAt: T0, lastFailureClass: 'MODEL_CALL_FAILED' } });
  await w.repo.resumeAfterBudgetChange(wakeAt);
  assert.ok((await w.db.managedCreatorMailCapture.findMany()).find(r => r.id === live.id)!.nextCheckAt > wakeAt, 'provider/model errors keep backoff');
  await w.db.aiControl.update({ where: { id: 'budget-change' }, data: { settings: { invalid: true } } });
  await w.db.managedCreatorMailCapture.update({ where: { id: live.id }, data: { lastFailureClass: 'MODEL_POLICY_REFUSED:BUDGET_TASK_EXHAUSTED' } });
  await w.repo.resumeAfterBudgetChange(wakeAt);
  assert.ok((await w.db.managedCreatorMailCapture.findMany()).find(r => r.id === live.id)!.nextCheckAt > wakeAt, 'unreadable control never wakes work');
});

test('a pending draft never hides sent history or enters AI evidence, including other excluded labels', async () => {
  for (const label of ['DRAFT', 'SPAM', 'TRASH']) {
    let calls = 0;
    const w = await world({ run: async (_actor, request) => {
      calls++;
      assert.doesNotMatch(JSON.stringify(request.context), /EXCLUDED_PRIVATE_MESSAGE/);
      const ref = request.context.items.find(i => i.sourceRef.startsWith('mail_message:'))!.sourceRef;
      return { outcome: 'ANSWERED', output: parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable: true, stage: 'DISCUSSING', summary: 'The brand requested more information about the partnership.', nextStep: '', citations: [ref] })!, provenance: {} } as AiRunResult;
    } });
    w.threadHook(t => ({ ...t, messages: [...t.messages, { ...t.messages[0]!, fact: { ...t.messages[0]!.fact, messageId: 'excluded', headerMessageId: '<excluded@example.test>', labels: [label], internalDate: T0 }, body: { ...t.messages[0]!.body, text: 'EXCLUDED_PRIVATE_MESSAGE Other Creator confirmed a deal.' } }] }));
    await w.start([w.staff.id]); await w.drain();
    assert.equal(calls, 1, label);
    const reading = (await w.repo.durableReadings((await w.db.managedCreatorMailCapture.findMany())[0]!))[0]!;
    assert.equal(reading.messageCount, 2); assert.equal(reading.evidenceAt, new Date(T0.getTime() - 1000).toISOString());
    assert.equal((await w.repo.updates(w.recipient, w.profile.id, T0)).length, 1);
    assert.doesNotMatch(JSON.stringify(reading), /EXCLUDED_PRIVATE_MESSAGE/);
  }
});

test('draft-only conversations never invoke a model or publish', async () => {
  const w = await world();
  w.threadHook(t => ({ ...t, messages: t.messages.map(m => ({ ...m, fact: { ...m.fact, labels: ['DRAFT'] } })) }));
  await w.start([w.staff.id]); await w.drain();
  assert.equal(w.counts().modelCalls, 0); assert.deepEqual(await w.repo.updates(w.recipient, w.profile.id, T0), []);
});


test('unqualified historic deals stay visible as conversations until the stricter review is accepted', async () => {
  const w = await world(); await w.start([w.staff.id]); await w.drain();
  const capture = (await w.db.managedCreatorMailCapture.findMany())[0]!;
  const reading = captureReadings(capture.readings)[0]!;
  const legacy = { ...reading, update: { ...reading.update!, stage: 'NEGOTIATING' as const } };
  await w.db.creatorMailEvidence.updateMany({ where: { captureId: capture.id }, data: { reading: legacy } });
  const published = await w.repo.updates(w.recipient, w.profile.id, T0);
  assert.ok(published.length > 0);
  assert.ok(published.every(r => r.stage === 'DISCUSSING'));
  const qualified = { ...legacy, update: { ...legacy.update, stage: 'CONFIRMED' as const, dealQualification: 'ACCEPTED_PAID_PARTNERSHIP' as const } };
  await w.db.creatorMailEvidence.updateMany({ where: { captureId: capture.id }, data: { reading: qualified } });
  assert.ok((await w.repo.updates(w.recipient, w.profile.id, T0)).every(r => r.stage === 'CONFIRMED'));
});

test('cross-thread synthesis cannot invent paid-deal qualification from unqualified accepted conversations', async () => {
  const w = await world();
  w.searchIds(['THREAD_ONE', 'THREAD_TWO']);
  w.threadHook((thread, id) => ({ ...thread, messages: thread.messages.map(m => ({ ...m, fact: { ...m.fact, headerMessageId: `<${id}-${m.fact.messageId}@brand.example>` } })) }));
  await w.start([w.staff.id]); await w.drain();
  const { CreatorRelationshipService } = await import('../src/creator/creator-relationship.service');
  const output = parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable: true, stage: 'CONFIRMED', dealQualification: 'ACCEPTED_PAID_PARTNERSHIP', brandName: 'Brand Bravo', summary: 'The brand and EMG are discussing a collaboration.', nextStep: '', citations: ['mail_message:fixture:1'] });
  assert.ok(output);
  const service = new CreatorRelationshipService(w.db, { run: async () => ({ outcome: 'ANSWERED', output, provenance: {} } as AiRunResult) }, () => T0);
  await service.pass(w.owner, w.profile.id);
  const rows = await service.projections(w.recipient, w.profile.id);
  assert.deepEqual(rows, [], 'unsupported consolidated prose is withheld, not merely relabeled');
  assert.ok((await w.repo.updates(w.recipient, w.profile.id, T0)).every(r => r.stage === 'DISCUSSING'));
  const stored = await w.db.creatorMailRelationship.findMany();
  assert.equal(stored[0]?.lastFailureClass, 'UNSUPPORTED_DEAL_QUALIFICATION');
  assert.equal(parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, ...(stored[0]?.update as object) }), null);
});


test('a newer known-brand conversation awaiting validation holds an older qualified active deal without erasing its history', async () => {
  const w = await world(); await w.start(); await w.drain();
  const captures = await w.db.managedCreatorMailCapture.findMany();
  const first = captures[0]!, second = captures[1]!;
  const reading = captureReadings(first.readings)[0]!;
  const qualified = { ...reading, update: { ...reading.update!, stage: 'CONFIRMED' as const, dealQualification: 'ACCEPTED_PAID_PARTNERSHIP' as const } };
  await w.db.creatorMailEvidence.updateMany({ where: { captureId: first.id }, data: { reading: qualified } });
  await w.db.creatorMailEvidence.updateMany({ where: { captureId: second.id }, data: { reading: { ...qualified, threadId: 'NEWER_THREAD', evidenceKey: 'newer-distinct-message', fingerprint: 'newer-source-fingerprint', state: 'MODEL_UNAVAILABLE', evidenceAt: new Date(T0.getTime() + 60_000).toISOString() } } });
  const updates = await w.repo.updates(w.recipient, w.profile.id, new Date(T0.getTime() + 120_000));
  assert.ok(updates.length > 0, 'accepted history remains visible');
  assert.ok(updates.every(r => r.stage === 'DISCUSSING' && r.dealQualification === 'NONE'));
  await w.db.creatorMailEvidence.updateMany({ where: { captureId: second.id }, data: { reading: { ...qualified, threadId: 'NEWER_THREAD', evidenceKey: 'newer-distinct-message', state: 'WITHHELD', evidenceAt: new Date(T0.getTime() + 60_000).toISOString() } } });
  const afterScreening = await w.repo.updates(w.recipient, w.profile.id, new Date(T0.getTime() + 120_000));
  assert.ok(afterScreening.some(r => r.stage === 'CONFIRMED'), 'an unrelated or un-attributable withheld discovery does not erase accepted paid-deal evidence');
});


test('relationship synthesis can reuse approved creator-safe wording; copying raw email still fails', async () => {
    const { CreatorRelationshipService } = await import('../src/creator/creator-relationship.service');
    const { buildMailTriageContext } = await import('../src/services/ai-runtime/mail-content-triage-context');
    const w = await world({ run: async (_actor, request) => {
            const ref = request.context.items.find(i => i.sourceRef.startsWith('mail_message:'))!.sourceRef;
            return { outcome: 'ANSWERED', output: parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable: true, stage: 'DISCUSSING', summary: 'EMG and the brand are discussing a creator partnership and reviewing content ideas.', nextStep: '', citations: [ref] })!, provenance: {} } as AiRunResult;
        } });
    await w.start([w.staff.id]);
    await w.drain();
    await distinctRelationshipConversation(w);
    const capture = (await w.db.managedCreatorMailCapture.findMany())[0]!;
    const approved = (await w.repo.durableReadings(capture))[0]!.update!;
    let callbackError: unknown;
    const service = new CreatorRelationshipService(w.db, { run: async (_actor, request) => {
            try {
                const refs = request.context.items.filter(i => i.sourceRef.startsWith('mail_message:')).map(i => i.sourceRef);
                const output = parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, ...approved, citations: [refs[0]!] })!;
                assert.doesNotMatch(JSON.stringify(request.context), /PRIVATE_BODY|PRIVATE_REPLY/);
                assert.deepEqual(validateCreatorBrandUpdate(output, request.task, new Set(refs), request.evidence), [], 'approved summary wording is not a copied private email');
                const raw = buildMailTriageContext({ organizationId: 'a', viewerUserId: w.owner.userId, threadId: 'raw-private', subject: null, messages: [{ direction: 'OUTBOUND', occurredAt: T0, fromLabel: null, text: approved.summary }], truncated: false, lane: null });
                const rawRef = raw.context.items.find(i => i.sourceRef.startsWith('mail_message:'))!.sourceRef;
                const copied = parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, ...approved, citations: [rawRef] })!;
                assert.ok(validateCreatorBrandUpdate(copied, AI_TASK_CREATOR_BRAND_UPDATE, new Set([rawRef]), raw.evidence).includes('VERBATIM_CONTENT'));
                const confidential = parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, ...approved, summary: 'The commission is confidential.', citations: [refs[0]!] })!;
                assert.ok(validateCreatorBrandUpdate(confidential, request.task, new Set(refs), request.evidence).includes('VERBATIM_CONTENT'));
                return { outcome: 'ANSWERED', output, provenance: {} } as AiRunResult;
            }
            catch (error) {
                callbackError = error;
                throw error;
            }
        } }, () => T0);
    const outcome = await service.pass();
    if (callbackError)
        throw callbackError;
    assert.deepEqual(outcome, { SYNTHESIZED: 1 });
});
test('a valid withheld relationship is not purchased again for unchanged evidence', async () => {
    const { CreatorRelationshipService } = await import('../src/creator/creator-relationship.service');
    const w = await world();
    await w.start([w.staff.id]);
    await w.drain();
    await distinctRelationshipConversation(w);
    const capture = (await w.db.managedCreatorMailCapture.findMany())[0]!;
    const basis = (await w.repo.durableReadings(capture))[0]!;
    for (let i = 0; i < 20; i++)
        await w.db.creatorMailEvidence.create({ data: { id: `withheld-extra-${i}`, captureId: capture.id, generation: capture.generation, threadId: `withheld-extra-${i}`, reading: { ...basis, threadId: `withheld-extra-${i}`, evidenceKey: `withheld-physical-${i}`, fingerprint: `withheld-version-${i}` } } });
    let calls = 0, now = T0;
    const service = new CreatorRelationshipService(w.db, { run: async () => { calls++; return { outcome: 'ANSWERED', output: parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable: false, stage: 'PAUSED', summary: '', nextStep: '', citations: [] })!, provenance: {} } as AiRunResult; } }, () => now);
    assert.deepEqual(await service.pass(), { NOT_PUBLISHED: 1 });
    assert.equal((await w.db.creatorMailRelationship.findMany())[0]!.processed, 16, 'unseen evidence must not be counted as processed');
    now = new Date(+T0 + 2 * 3600000);
    assert.deepEqual(await service.pass(), {});
    assert.equal(calls, 1);
    assert.deepEqual(await service.projections(w.recipient, w.profile.id), []);
    const row = (await w.db.managedCreatorMailCapture.findMany())[0]!;
    const reading = (await w.repo.durableReadings(row))[0]!;
    await w.db.creatorMailEvidence.create({ data: { id: 'changed-after-withheld', captureId: row.id, generation: row.generation, threadId: 'changed-after-withheld', reading: { ...reading, threadId: 'changed-after-withheld', evidenceKey: 'new-message', fingerprint: 'new-fingerprint' } } });
    assert.deepEqual(await service.pass(), { NOT_PUBLISHED: 1 });
    assert.equal(calls, 2);
});
test('legacy synthesis rejection gets one corrected retry; a live circuit still blocks publication and backs off', async () => {
    const { CreatorRelationshipService } = await import('../src/creator/creator-relationship.service');
    const { relationshipVersion } = await import('../src/creator/creator-relationship');
    const w = await world();
    await w.start([w.staff.id]);
    await w.drain();
    await distinctRelationshipConversation(w);
    let calls = 0, now = T0;
    const service = new CreatorRelationshipService(w.db, { run: async (_actor, request) => {
            calls++;
            if (calls === 1)
                return { outcome: 'REFUSED_BY_LOOP', refusals: ['TASK_CIRCUIT_OPEN'] } as AiRunResult;
            const ref = request.context.items.find(i => i.sourceRef.startsWith('mail_message:'))!.sourceRef;
            return { outcome: 'ANSWERED', output: parseCreatorBrandUpdate({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable: true, stage: 'DISCUSSING', summary: 'The brand is considering a creator collaboration.', nextStep: '', citations: [ref] })!, provenance: {} } as AiRunResult;
        } }, () => now);
    const [brandId, sources] = [...(await service.evidence('a', w.profile.id))][0]!;
    const id = mailEvidenceHash(`a:${w.profile.id}:${brandId}`);
    await w.db.creatorMailRelationship.create({ data: { id, organizationId: 'a', creatorProfileId: w.profile.id, brandId, fingerprint: relationshipVersion(sources), lastFailureClass: 'REJECTED_OUTPUT', nextCheckAt: new Date(+T0 + 3600000) } });
    assert.deepEqual(await service.pass(), { NOT_PUBLISHED: 1 });
    assert.equal(calls, 1);
    assert.deepEqual(await service.projections(w.recipient, w.profile.id), []);
    assert.deepEqual(await service.pass(), {});
    assert.equal(calls, 1);
    now = new Date(+T0 + 301000);
    assert.deepEqual(await service.pass(), { SYNTHESIZED: 1 });
    assert.equal(calls, 2);
    assert.equal((await service.projections(w.recipient, w.profile.id)).length, 1);
});
