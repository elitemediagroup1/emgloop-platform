// The exact-window judge against a REAL Postgres (2026-09-30). OPT-IN AND LOCAL ONLY: LOOP_TEST_POSTGRES_URL.
//
// Real triage calls through the gateway and the DURABLE ledger (a RecordedModelProvider for Anthropic), then
// TelegramTriageWindowJudge: the ledger row the call left is found by the window's content-free manifest hash;
// an answer whose reading is stored is HANDLED at once; a rejected one is HANDLED; a failed one BACKS OFF and is
// NEW again after the backoff; another person's or another organization's identical window is theirs alone.
// No message text is stored anywhere: the ledger row carries identifiers and counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { RecordedModelProvider, aiCatalogCapabilities, AI_ROUTING_POLICY, AI_BUDGET_POLICY, AI_MAX_ATTEMPTS_PER_TARGET, type RecordedInvocation } from '@emgloop/providers';
import { telegramConversationSubjectRef, type AiProviderPolicy } from '@emgloop/shared';

import { AiRuntimeGateway } from '../src/services/ai-runtime/gateway';
import { DurableAiUsageLedger } from '../src/services/ai-usage-ledger.service';
import { TelegramContentTriageService } from '../src/services/ai-runtime/telegram-content-triage.service';
import { TelegramTriageWindowJudge, telegramTriageWindowManifestHash, TELEGRAM_TRIAGE_WINDOW_POLICY } from '../src/services/ai-runtime/telegram-triage-window';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL(URL) ? 'refusing a non-local database' : false;
const POLICY: readonly AiProviderPolicy[] = [{ providerId: 'anthropic', state: 'ACTIVE', ceiling: 'COMMUNICATION_CONTENT', version: 1, recordedAtMs: 0 }];
const BODY = 'Please send the signed contract back by Thursday';
const ANSWER = {
  schemaId: 'telegram-content-triage.v5',
  items: [],
  conversation: { relevance: 'BUSINESS', summary: 'A contract is waiting to be returned.', topics: ['Contract'], stateChange: null, signals: [], attention: { needed: false, reason: null }, confidence: 'MEDIUM' },
  limitations: [],
};

async function person(prisma: PrismaClient, organizationId: string) {
  const userId = `user_tw_${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'TW', status: 'ACTIVE', metadata: { systemRole: 'EMPLOYEE' } } });
  await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'EMPLOYEE', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  return userId;
}

function triageWith(prisma: PrismaClient, organizationId: string, recording: Omit<RecordedInvocation, 'modelId'>, now: () => Date) {
  const provider = new RecordedModelProvider('anthropic', [{ modelId: 'claude-opus-5', ...recording }], (m) => aiCatalogCapabilities('anthropic', m));
  const gateway = new AiRuntimeGateway(
    { activation: { enabled: true, organizations: [organizationId], tasks: ['telegram.content.triage'], providers: ['anthropic'] }, policy: AI_ROUTING_POLICY, budget: AI_BUDGET_POLICY, killSwitches: [], maxAttemptsPerTarget: AI_MAX_ATTEMPTS_PER_TARGET },
    { providers: [provider], ledger: new DurableAiUsageLedger(prisma), authorize: async () => true, now, newInvocationId: () => randomUUID(), providerPolicies: async () => POLICY },
  );
  return new TelegramContentTriageService({ runtime: gateway });
}

const result = (json: unknown) => ({ output: { json }, toolCalls: [], stopReason: 'END' as const, usage: { inputTokens: 400, outputTokens: 60 }, providerRequestId: 'req', reportedModel: 'claude-opus-5', latencyMs: 30 });

test('the judge finds the call the ledger holds for an exact window -- and only that person’s, in that organization', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  const organizationId = `0tw_${randomUUID()}`;
  const otherOrg = `0tw_other_${randomUUID()}`;
  try {
    for (const id of [organizationId, otherOrg]) await prisma.organization.create({ data: { id, name: 'TW', slug: id } });
    const alice = await person(prisma, organizationId);
    const bob = await person(prisma, organizationId);
    const carol = await person(prisma, otherOrg);
    const now = new Date();
    const key = `ck_${randomUUID().slice(0, 8)}`;
    const window = (n: number) => ({ conversationKey: key, messages: Array.from({ length: n }, (_, i) => ({ providerEventId: `${key}:${i + 1}`, direction: 'INBOUND' as const, occurredAt: new Date(now.getTime() - (10 - i) * 60_000), text: BODY })), truncated: false, evaluatedFloorProviderEventId: `${key}:1`, conversation: null });
    const identity = (userId: string, n: number, org = organizationId) => ({
      manifestHash: telegramTriageWindowManifestHash({ organizationId: org, viewerUserId: userId, ...window(n) }),
      subjectRef: telegramConversationSubjectRef(key),
      digestFingerprint: `fp_${key}_${n}`,
    });
    const judge = new TelegramTriageWindowJudge(prisma);

    // Alice's window is ANSWERED (the writes are the worker's; none here): asked once more at most.
    const first = await triageWith(prisma, organizationId, { result: result(ANSWER) }, () => now).triage({ organizationId, userId: alice }, window(2));
    assert.equal(first.outcome, 'TRIAGED', JSON.stringify(first));
    assert.deepEqual((await prisma.aiInvocation.findMany({ where: { organizationId, principalUserId: alice }, select: { outcome: true } })).map((x) => x.outcome), ['ANSWERED']);
    assert.equal(await judge.judge({ organizationId, userId: alice }, identity(alice, 2), now), 'NEW', 'answered once, reading not stored: finish the writes');
    // Its reading stored (the window's fingerprint on the person's CHATS digest): HANDLED.
    await prisma.intelligenceDigest.create({ data: { organizationId, scope: 'PRINCIPAL', userId: alice, domain: 'CHATS', subjectKind: 'CONVERSATION', subjectRef: telegramConversationSubjectRef(key), provider: 'TELEGRAM', content: {}, coverage: 'CONNECTED_SUFFICIENT', windowStart: now, windowEnd: now, evidenceCount: 2, lastEvidenceAt: now, provenance: {}, fingerprint: `fp_${key}_2`, status: 'CURRENT', generatedAt: now, expiresAt: new Date(now.getTime() + 864e5) } });
    assert.equal(await judge.judge({ organizationId, userId: alice }, identity(alice, 2), now), 'HANDLED');
    assert.equal(await judge.judge({ organizationId, userId: alice }, identity(alice, 3), now), 'NEW', 'a new message is a new window');
    // Bob, the same window in the same organization: nobody judged HIS window.
    assert.equal(await judge.judge({ organizationId, userId: bob }, identity(bob, 2), now), 'NEW');
    // Carol, another organization, the same ids: hers alone.
    assert.equal(await judge.judge({ organizationId: otherOrg, userId: carol }, identity(carol, 2, otherOrg), now), 'NEW');

    // Bob's window is REJECTED (too long): HANDLED, never re-sent.
    const tooLong = { ...ANSWER, limitations: ['x'.repeat(300)] };
    const r = await triageWith(prisma, organizationId, { result: result(tooLong) }, () => now).triage({ organizationId, userId: bob }, window(2));
    assert.equal(r.outcome, 'REJECTED_OUTPUT');
    assert.equal(await judge.judge({ organizationId, userId: bob }, identity(bob, 2), now), 'HANDLED');
    const row = await prisma.aiInvocation.findFirst({ where: { organizationId, principalUserId: bob }, select: { rejectionCodes: true, contextManifestHash: true } });
    assert.ok(row!.rejectionCodes.includes('TOO_LONG_LIMITATION'), 'the ledger names the field');
    assert.equal(row!.contextManifestHash, identity(bob, 2).manifestHash, 'the very hash the judge computes');

    // A FAILED window backs off, then is NEW again after the backoff; after the last attempt it is EXHAUSTED.
    const failing = triageWith(prisma, organizationId, { failure: { failure: 'TIMEOUT', message: 'slow' } }, () => now);
    await failing.triage({ organizationId, userId: alice }, window(4));
    assert.equal(await judge.judge({ organizationId, userId: alice }, identity(alice, 4), now), 'BACKED_OFF');
    const later = new Date(now.getTime() + TELEGRAM_TRIAGE_WINDOW_POLICY.failureBackoffMs + 60_000);
    assert.equal(await judge.judge({ organizationId, userId: alice }, identity(alice, 4), later), 'NEW');
    for (let i = 1; i < TELEGRAM_TRIAGE_WINDOW_POLICY.maxFailedAttempts; i += 1) await failing.triage({ organizationId, userId: alice }, window(4));
    assert.equal(await judge.judge({ organizationId, userId: alice }, identity(alice, 4), later), 'EXHAUSTED');

    // Nothing stored anywhere carries the body.
    const rows = await prisma.aiInvocation.findMany({ where: { organizationId } });
    assert.equal(JSON.stringify(rows).includes('signed contract'), false);
  } finally {
    await prisma.organization.deleteMany({ where: { id: { in: [organizationId, otherOrg] } } });
    await prisma.$disconnect();
  }
});
