import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { parseCreatorBrandUpdate, CREATOR_BRAND_UPDATE_SCHEMA_ID, type GmailThreadView, type AiModelRequest, type AiModelResult } from '@emgloop/shared';
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
  assert.equal(w.counts().modelCalls, 0);
  assert.deepEqual(await w.repo.updates(w.recipient, w.profile.id, T0), []);
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
  assert.equal(kept.length, 100);
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
