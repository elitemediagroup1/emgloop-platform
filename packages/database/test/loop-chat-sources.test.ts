import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopChatSources } from '../src/services/intelligence-fabric/chat-sources';
import { IamRepository } from '../src/repositories/iam.repository';
import { MAIL_CONTENT_GOVERNANCE_DECISION_REF } from '@emgloop/shared';
import type { IntelligenceProducer } from '../src/services/intelligence-fabric/producer';
const principal = { organizationId: 'our-org', userId: 'our-user' };
const now = new Date('2026-10-15T19:00:00Z');
const options = {
  question: 'Give me a general update',
  since: new Date('2026-10-15T04:00:00Z'),
  until: now,
};
function database() {
  let active = true,
    consent = true;
  const scopes: any[] = [];
  return {
    scopes,
    revoke: () => {
      active = false;
    },
    revokeContent: () => {
      consent = false;
    },
    prisma: {
      user: {
        findFirst: async () => ({
          id: principal.userId,
          organizationId: principal.organizationId,
          status: 'ACTIVE',
          metadata: { systemRole: 'ADMIN' },
        }),
      },
      organizationMembership: {
        findFirst: async () =>
          active
            ? {
                id: 'membership',
                ...principal,
                status: 'ACTIVE',
                systemRole: 'ADMIN',
                effectiveFrom: new Date('2020-01-01'),
                effectiveTo: null,
              }
            : null,
      },
      googleConnection: { findFirst: async () => ({ status: 'CONNECTED' }) },
      sourceContentAuthorization: {
        findFirst: async (q: any) => {
          scopes.push(q.where);
          return consent ? { id: 'consent' } : null;
        },
      },
      workThread: {
        findMany: async (q: any) => {
          scopes.push(q.where);
          // Match the stored WorkProvider vocabulary, independent of the content-authorization provider.
          return q.where.provider === 'GOOGLE' ? ['a', 'b', 'c', 'd'].map((id) => ({ id })) : [];
        },
      },
    },
  };
}
function producer(domain: string, scope: string, seen: any[]): IntelligenceProducer<any> {
  return {
    id: `${domain.toLowerCase()}.domain@1`,
    domain,
    scope,
    subjectKinds: ['DOMAIN'],
    kind: 'RULE',
    taskId: null,
    gather: async (target: any) => {
      seen.push(target);
      return { status: 'READY', context: {}, fingerprint: 'current' };
    },
    read: async () => ({
      status: 'READ',
      digest: {
        domain,
        content: {
          reading: { statement: 'Stored record observation.', status: 'WATCH' },
          signals: [],
        },
        fingerprint: 'current',
        windowStart: options.since,
        windowEnd: now,
      },
    }),
  } as IntelligenceProducer<any>;
}
test('one retrieval path covers every available domain reader under the invoking person and organization', async (t) => {
  t.mock.method(IamRepository.prototype, 'can', async () => true);
  const db = database(),
    seen: any[] = [];
  const domains = ['CALLGRID', 'CAMPAIGNS', 'PIPELINE', 'CRM', 'CREATORS', 'WORK', 'WEBSITE'];
  const producers = [
    ...domains.map((d) => producer(d, 'ORGANIZATION', seen)),
    producer('CALENDAR', 'PRINCIPAL', seen),
    producer('WORK', 'PRINCIPAL', seen),
  ];
  const result = await new LoopChatSources(db.prisma as never, { producers }).gather(
    principal,
    now,
    options,
  );
  assert.equal(result.length, 9);
  assert.equal(seen.length, 9);
  assert.ok(
    seen.every(
      (s) =>
        s.organizationId === principal.organizationId &&
        (s.scope !== 'PRINCIPAL' || s.userId === principal.userId),
    ),
  );
  assert.ok(
    result.every(
      (r) =>
        r.coverage === 'CONNECTED_PARTIAL' &&
        r.limitations.some((l) => l.includes('upstream synchronization')),
    ),
  );
});
test('denied domain permissions prevent gathering those records; revocation discards captured records', async (t) => {
  t.mock.method(IamRepository.prototype, 'can', async () => false);
  const db = database(),
    seen: any[] = [];
  await new LoopChatSources(db.prisma as never, {
    producers: [producer('CALLGRID', 'ORGANIZATION', seen)],
  }).gather(principal, now, options);
  assert.equal(seen.length, 0);
  const own = producer('WORK', 'PRINCIPAL', seen);
  const read = own.read;
  own.read = async (...args) => {
    const result = await read(...args);
    db.revoke();
    return result;
  };
  assert.deepEqual(
    await new LoopChatSources(db.prisma as never, { producers: [own] }).gather(
      principal,
      now,
      options,
    ),
    [],
  );
});
test('Mail retrieval is bounded, scoped, transient, and discarded when content authorization is withdrawn', async (t) => {
  t.mock.method(IamRepository.prototype, 'can', async () => false);
  const db = database();
  let reads = 0;
  const ports = {
    producers: [],
    governanceDecision: MAIL_CONTENT_GOVERNANCE_DECISION_REF,
    readMailThread: async (p: typeof principal) => {
      assert.deepEqual(p, principal);
      reads++;
      return {
        subject: 'Partner message',
        messages: Array(10).fill({
          text: 'a'.repeat(5000),
          direction: 'INBOUND' as const,
          occurredAt: now.toISOString(),
          fromLabel: null,
        }),
        truncated: true,
      };
    },
  };
  const result = await new LoopChatSources(db.prisma as never, ports).gather(principal, now, {
    ...options,
    question: 'Check my emails today',
  });
  assert.equal(reads, 3);
  assert.equal(result.length, 3);
  assert.ok(
    db.scopes.every(
      (s) =>
        s.organizationId === principal.organizationId &&
        s.userId === principal.userId &&
        (s.lastMessageAt ? s.provider === 'GOOGLE' : s.provider === 'GMAIL'),
    ),
  );
  for (const artifact of result) {
    const data = JSON.parse(artifact.statement);
    assert.equal(data.messages.length, 3);
    assert.equal(data.messages[0].text.length, 1000);
  }
  ports.readMailThread = async () => {
    db.revokeContent();
    return { subject: 'Revoked content', messages: [], truncated: false };
  };
  assert.deepEqual(
    await new LoopChatSources(db.prisma as never, ports).gather(principal, now, {
      ...options,
      question: 'my emails',
    }),
    [],
  );
});

test('Mail content is never read without the exact governance record and personal authorization', async (t) => {
  t.mock.method(IamRepository.prototype, 'can', async () => false);
  const db = database();
  let reads = 0;
  const ports = {
    producers: [],
    governanceDecision: 'wrong-record',
    readMailThread: async () => {
      reads++;
      return null;
    },
  };
  const source = new LoopChatSources(db.prisma as never, ports);
  assert.deepEqual(await source.gather(principal, now, { ...options, question: 'my inbox' }), []);
  ports.governanceDecision = MAIL_CONTENT_GOVERNANCE_DECISION_REF;
  db.revokeContent();
  assert.deepEqual(await source.gather(principal, now, { ...options, question: 'my inbox' }), []);
  assert.equal(reads, 0);
});
