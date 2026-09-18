// The two narrow reads behind Home's review and the Mail dashboard: one person's own messages,
// counted or classified -- never anybody else's, and never more columns than the rules use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { WorkGraphRepository, type WorkPrincipal } from '../src/repositories/work-state';

const ALICE: WorkPrincipal = { organizationId: 'org_a', userId: 'alice' };
const BOB: WorkPrincipal = { organizationId: 'org_a', userId: 'bob' };
const ELSEWHERE: WorkPrincipal = { organizationId: 'org_b', userId: 'alice' };
const at = (iso: string) => new Date(iso);

function world() {
  const fake: any = makeCognitivePrisma({ also: ['workThread', 'workMessage', 'workCorrespondent'] });
  const graph = new WorkGraphRepository(fake as PrismaClient);
  return { fake, graph };
}

async function seed(graph: WorkGraphRepository, principal: WorkPrincipal) {
  const observedAt = at('2026-09-18T12:00:00Z');
  await graph.upsertMessage(principal, { provider: 'GOOGLE', messageId: 'm1', threadId: 't-out', internalDate: at('2026-09-18T09:00:00Z'), direction: 'OUTBOUND', observedAt, labels: ['SENT'] });
  await graph.upsertMessage(principal, { provider: 'GOOGLE', messageId: 'm2', threadId: 't-in', internalDate: at('2026-09-18T10:00:00Z'), direction: 'INBOUND', observedAt, labels: ['INBOX'], fromHash: 'h_ben', inReplyTo: '<x@y>' });
  await graph.upsertMessage(principal, { provider: 'GOOGLE', messageId: 'm3', threadId: 't-in', internalDate: at('2026-09-18T11:00:00Z'), direction: 'INBOUND', observedAt, labels: ['INBOX', 'CATEGORY_PROMOTIONS'], fromHash: 'h_ben' });
  await graph.upsertThread(principal, { provider: 'GOOGLE', threadId: 't-out', subject: 'Outreach', firstMessageAt: at('2026-09-18T09:00:00Z'), lastMessageAt: at('2026-09-18T09:00:00Z'), lastDirection: 'OUTBOUND', messageCount: 1 });
  await graph.recordCorrespondent(principal, { addressHash: 'h_ben', displayAddress: `ben@${principal.userId}.example`, displayName: 'Ben', seenAt: observedAt, direction: 'INBOUND' });
}

test('messageActivity reads one window of one person’s messages, with the first message of every outbound thread', async () => {
  const { graph } = world();
  await seed(graph, ALICE);
  await seed(graph, BOB);
  const activity = await graph.messageActivity(ALICE, { from: at('2026-09-18T00:00:00Z'), to: at('2026-09-18T10:30:00Z') });
  assert.deepEqual(activity.messages.map((m) => m.threadId), ['t-out', 't-in'], 'the window is half-open; the 11:00 message is outside');
  assert.equal(activity.firstMessageAt.get('t-out')!.toISOString(), '2026-09-18T09:00:00.000Z');
  assert.equal(activity.truncated, false);
  // An arrived message carries its sender's address -- this person's own record of it, nobody else's.
  assert.equal(activity.messages.find((m) => m.threadId === 't-in')!.fromAddress, 'ben@alice.example');
  assert.equal(activity.messages.find((m) => m.threadId === 't-out')!.fromAddress, null);
  assert.deepEqual((await graph.messageActivity(ELSEWHERE, { from: at('2026-09-18T00:00:00Z'), to: at('2026-09-19T00:00:00Z') })).messages, [], 'another organization holds nothing of hers');
});

test('threadEvidence reads only the threads asked for, only this person’s, oldest first', async () => {
  const { graph } = world();
  await seed(graph, ALICE);
  await seed(graph, BOB);
  const rows = await graph.threadEvidence(ALICE, ['t-in']);
  assert.deepEqual(rows.map((r) => r.internalDate.toISOString()), ['2026-09-18T10:00:00.000Z', '2026-09-18T11:00:00.000Z']);
  assert.equal(rows[0]!.fromHash, 'h_ben');
  assert.equal(rows[0]!.inReplyTo, '<x@y>');
  assert.equal(rows.length, 2, 'not Bob’s copy of the same thread');
  assert.deepEqual(await graph.threadEvidence(ALICE, []), []);
});

test('both reads name their columns: no subject, no address, no body -- and nothing a missing migration could break', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'repositories', 'work-state', 'work-graph.repository.ts'), 'utf8');
  for (const method of ['async messageActivity(', 'async threadEvidence(']) {
    const body = source.slice(source.indexOf(method), source.indexOf('\n  }\n', source.indexOf(method)));
    assert.match(body, /select: \{/, `${method} selects explicit columns`);
    for (const forbidden of ['subject: true', 'references: true', 'toHashes: true', 'ccHashes: true', 'displayName: true']) {
      assert.equal(body.includes(forbidden), false, `${method}: ${forbidden}`);
    }
  }
});
