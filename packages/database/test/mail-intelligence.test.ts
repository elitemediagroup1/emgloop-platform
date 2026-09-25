// Loop Intelligence Phase D (2026-09-26): Mail intelligence -- built, gated, never commissioned by merging.
//
//   - the counterparty-consent governance gate closes every Mail content path while UNDECIDED;
//   - mail.thread@1: fingerprint from Loop's stored metadata (no Gmail read for an unchanged thread), bodies
//     read only in `read`, no body persisted, obligations and owed-by kept, and nothing without activation;
//   - mail.domain@1: the deterministic lanes stay the record (MEASURED counts); the model reading of the
//     thread readings is optional; the rule reading stands alone and honestly when the model is off.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_TASKS,
  AI_TASK_MAIL_CONTENT_TRIAGE,
  MAIL_CONTENT_GOVERNANCE_STATUS,
  aiOutputContract,
  aiPortableSchemaViolations,
  brainOwnershipRule,
  digestContentRefusals,
  mailContentGovernance,
} from '@emgloop/shared';
import { AI_BUDGET_POLICY, AI_ROUTING_POLICY } from '@emgloop/providers';

import { MailContentTriageService } from '../src/services/ai-runtime/mail-content-triage.service';
import { MAIL_CONTENT_TRIAGE_SCHEMA } from '../src/services/ai-runtime/templates/mail-content-triage';
import { mailDomainProducer, mailThreadProducer, type MailProducerPorts } from '../src/services/intelligence-fabric/domains/mail';

const NOW = new Date('2026-09-26T12:00:00Z');
const P = { organizationId: 'org_1', userId: 'u_1' };
const DECIDED = 'counterparty-consent:2026-10-15:legal/mail-consent-v1';
const BODY = 'Hi Matt, can you send the revised allocation for Premier by Friday? BODYMARKER-never-stored';

function fakePrisma(opts: { authorized?: boolean; thread?: boolean; laneCounts?: Record<string, number>; digests?: unknown[] } = {}) {
  let gmailReads = 0;
  const prisma = {
    sourceContentAuthorization: {
      async findFirst() {
        return opts.authorized === false ? null : { id: 'sca_1' };
      },
      async findMany() {
        return opts.authorized === false ? [] : [P];
      },
    },
    workThread: {
      async findFirst() {
        return opts.thread === false ? null : { id: 'th_1', subject: 'Premier allocation', lastMessageAt: NOW, lastMessageId: 'm9', messageCount: 3 };
      },
      async findMany() {
        return [{ id: 'th_1' }];
      },
    },
    workItem: {
      async groupBy() {
        return Object.entries(opts.laneCounts ?? { NEEDS_YOU: 2, WAITING_ON_THEM: 1 }).map(([cls, n]) => ({ class: cls, _count: { _all: n } }));
      },
    },
    intelligenceDigest: {
      async findMany() {
        return opts.digests ?? [];
      },
      async findFirst() {
        return null;
      },
    },
  };
  return { prisma: prisma as never, reads: () => gmailReads, bump: () => (gmailReads += 1) };
}

function ports(over: Partial<MailProducerPorts> = {}, prismaOpts: Parameters<typeof fakePrisma>[0] = {}) {
  const fp = fakePrisma(prismaOpts);
  const calls: unknown[] = [];
  const triage = new MailContentTriageService({
    async run(_p, request) {
      calls.push(request);
      return {
        outcome: 'ANSWERED',
        output: {
          schemaId: 'mail-content-triage.v1',
          summary: '',
          claims: [],
          limitations: [],
          chatsTriage: {
            items: [{ anchorOrdinal: 1, category: 'REQUEST', oneLineMeaning: 'Premier asked for the revised allocation', topic: 'allocation', nextStep: 'Send it', deadline: 'by Friday', owedBy: 'VIEWER', who: null }],
            conversation: {
              relevance: 'BUSINESS',
              summary: 'Premier is waiting on the revised allocation.',
              topics: ['Allocation'],
              stateChange: null,
              signals: [{ kind: 'STALLED', anchorOrdinal: 2, statement: 'Nobody answered the question about volume caps', severity: 'MEDIUM', owedBy: null, who: null }],
              attention: { needed: true, reason: 'Premier set a Friday deadline' },
              confidence: 'MEDIUM',
            },
          },
        },
        provenance: { invocationId: 'inv_m1', taskId: 'mail.content.triage', taskVersion: '1.0.0' } as never,
      };
    },
  });
  const p: MailProducerPorts = {
    prisma: fp.prisma,
    governanceDecision: DECIDED,
    readThread: async () => {
      fp.bump();
      return {
        subject: 'Premier allocation',
        truncated: false,
        messages: [
          { direction: 'INBOUND', occurredAt: new Date('2026-09-24T10:00:00Z'), fromLabel: 'Dana Reyes', text: BODY },
          { direction: 'INBOUND', occurredAt: new Date('2026-09-24T11:00:00Z'), fromLabel: 'Dana Reyes', text: 'Also what about volume caps?' },
          { direction: 'OUTBOUND', occurredAt: new Date('2026-09-24T12:00:00Z'), fromLabel: null, text: 'Looking at it' },
        ],
      };
    },
    triage,
    modelEnabled: (id) => id === 'mail.content.triage',
    now: () => NOW,
    ...over,
  };
  return { p, calls, reads: fp.reads };
}

const THREAD = { scope: 'PRINCIPAL', ...P, domain: 'MAIL', subjectKind: 'THREAD', subjectRef: 'work_thread:th_1' } as const;
const DOMAIN = { scope: 'PRINCIPAL', ...P, domain: 'MAIL', subjectKind: 'DOMAIN', subjectRef: 'domain' } as const;

test('the governance gate: UNRESOLVED in this repository, and nothing but a well-formed decision reference opens it', () => {
  assert.equal(MAIL_CONTENT_GOVERNANCE_STATUS, 'UNRESOLVED');
  for (const bad of [undefined, null, '', 'yes', 'approved', 'counterparty-consent:soon:x', 'counterparty-consent:2026-10-15:']) {
    assert.deepEqual(mailContentGovernance(bad as never), { state: 'UNDECIDED' }, String(bad));
  }
  assert.equal(mailContentGovernance(DECIDED).state, 'DECIDED');
});

test('mail.thread@1: closed while governance is undecided or the person has not consented -- no Gmail read, no call', async () => {
  const undecided = ports({ governanceDecision: null });
  const producer = mailThreadProducer(undecided.p);
  assert.deepEqual(await producer.gather(THREAD, NOW), { status: 'NOT_PERMITTED', reason: 'GOVERNANCE_UNDECIDED' });
  assert.deepEqual(await producer.discover!(NOW), [], 'nothing is even enqueued');
  const noConsent = ports({}, { authorized: false });
  assert.deepEqual(await mailThreadProducer(noConsent.p).gather(THREAD, NOW), { status: 'NOT_PERMITTED', reason: 'CONTENT_NOT_AUTHORIZED' });
  assert.equal(undecided.reads() + noConsent.reads(), 0);
  assert.equal(undecided.calls.length + noConsent.calls.length, 0);
  // An ORGANIZATION target is never a mail target.
  assert.deepEqual(await producer.gather({ scope: 'ORGANIZATION', organizationId: 'org_1', domain: 'MAIL', subjectKind: 'THREAD', subjectRef: 'work_thread:th_1' } as never, NOW), { status: 'NOT_PERMITTED', reason: 'PRINCIPAL_ONLY' });
});

test('mail.thread@1: the fingerprint is metadata only (no Gmail read); read() reads the body, stores no body, keeps who-owes-what', async () => {
  const w = ports();
  const producer = mailThreadProducer(w.p);
  const gathered = await producer.gather(THREAD, NOW);
  assert.equal(gathered.status, 'READY');
  assert.equal(w.reads(), 0, 'deciding whether anything changed never reads Gmail');
  if (gathered.status !== 'READY') return;
  const read = await producer.read(THREAD, gathered.context, gathered.fingerprint, NOW);
  assert.equal(read.status, 'READ');
  if (read.status !== 'READ') return;
  assert.equal(w.reads(), 1);
  const d = read.digest;
  assert.deepEqual([d.domain, d.subjectKind, d.subjectRef, d.provider, d.consentBasis], ['MAIL', 'THREAD', 'work_thread:th_1', 'GMAIL', 'CONTENT_AUTHORIZATION']);
  assert.equal(JSON.stringify(d).includes('BODYMARKER'), false, 'no body, anywhere in what is stored');
  assert.equal(JSON.stringify(d).includes('volume caps?'), false);
  assert.deepEqual(digestContentRefusals(d.content, { scope: 'PRINCIPAL', producerKind: 'MODEL' }), []);
  const sigs = d.content.signals ?? [];
  const owed = sigs.find((s) => s.kind === 'OBLIGATION');
  assert.ok(owed, 'the unanswered ask survives as an OBLIGATION signal');
  assert.equal(owed!.owedBy, 'VIEWER');
  assert.ok(sigs.some((s) => s.kind === 'STALLED'), 'the unanswered question: gone quiet');
  assert.equal(d.content.attention, 'Premier set a Friday deadline');
  assert.equal(d.content.label, 'Premier allocation');
  // The call sent the transient body to the governed runtime only.
  const request = w.calls[0] as { task: { taskId: string }; schema: unknown };
  assert.equal(request.task.taskId, 'mail.content.triage');
  assert.equal(request.schema, MAIL_CONTENT_TRIAGE_SCHEMA);
  // Not activated: nothing is read and nothing is called.
  const off = ports({ modelEnabled: () => false });
  const offRead = await mailThreadProducer(off.p).read(THREAD, gathered.context, gathered.fingerprint, NOW);
  assert.deepEqual(offRead, { status: 'NOT_READ', reason: 'AI_NOT_ACTIVATED', retryable: false });
  assert.equal(off.reads() + off.calls.length, 0);
});

test('mail.domain@1: the deterministic lanes are the record (MEASURED counts); rule-only when the model is off, and it says so only when it tried', async () => {
  const w = ports();
  const producer = mailDomainProducer(w.p, { modelEnabled: () => false, reader: null, principalFor: async () => P });
  const g = await producer.gather(DOMAIN, NOW);
  assert.equal(g.status, 'READY');
  if (g.status !== 'READY') return;
  const r = await producer.read(DOMAIN, g.context, g.fingerprint, NOW);
  assert.equal(r.status, 'READ');
  if (r.status !== 'READ') return;
  const c = r.digest.content;
  assert.equal(c.reading!.statement, '2 threads need your reply, and 1 is waiting on others.');
  assert.equal(c.reading!.status, 'ATTENTION');
  const needs = c.signals!.find((s) => s.key === 'needs-reply')!;
  assert.deepEqual([needs.knowledge, needs.metric], ['MEASURED', { name: 'needs_reply', value: 2, unit: 'count' }]);
  assert.equal((r.digest.provenance as { producerKind?: string }).producerKind, 'RULE');
  assert.deepEqual(digestContentRefusals(c, { scope: 'PRINCIPAL', producerKind: 'RULE' }), []);
  // Undecided governance closes the domain reading too.
  assert.deepEqual(await mailDomainProducer(ports({ governanceDecision: null }).p, { modelEnabled: () => true, reader: null, principalFor: async () => P }).gather(DOMAIN, NOW), { status: 'NOT_PERMITTED', reason: 'GOVERNANCE_UNDECIDED' });
});

test('the Mail tasks are defined, routed, budgeted and portable -- and activated by nothing', () => {
  const ids = AI_TASKS.map((t) => t.taskId);
  for (const id of ['mail.content.triage', 'mail.domain.reading']) {
    assert.ok(ids.includes(id), id);
    const route = AI_ROUTING_POLICY.tasks[id]!;
    assert.ok(route, `${id} is routed`);
    assert.equal(route.taskVersion, AI_TASKS.find((t) => t.taskId === id)!.version);
    assert.ok(AI_BUDGET_POLICY.classes[route.budgetClass], `${id} has a budget class`);
  }
  assert.equal(AI_ROUTING_POLICY.tasks['mail.content.triage']!.lane, 'FORWARD');
  assert.equal(AI_ROUTING_POLICY.tasks['mail.domain.reading']!.lane, 'BACKGROUND');
  assert.ok(aiOutputContract('mail-content-triage.v1'));
  assert.deepEqual(aiPortableSchemaViolations(MAIL_CONTENT_TRIAGE_SCHEMA), []);
  assert.equal(AI_TASK_MAIL_CONTENT_TRIAGE.sensitivityCeiling, 'COMMUNICATION_CONTENT');
  assert.ok(brainOwnershipRule(AI_TASK_MAIL_CONTENT_TRIAGE.resultType, AI_TASK_MAIL_CONTENT_TRIAGE.resultOwner));
});
