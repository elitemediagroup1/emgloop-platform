// The observation verifier against a REAL Postgres: it reports the right PASS/FAIL AND its output
// carries no sensitive observation field. Local only (LOOP_TEST_POSTGRES_URL).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

import { SourceConnectionRepository } from '../src/repositories/source-connection.repository';
import { SourceObservationRepository } from '../src/repositories/source-observation.repository';
import { ConnectionSecretSealer } from '../src/services/connections/connection-secret-sealer';
import { verifyObservations } from '../src/verification/source-observation-verifier';
import type { ConversationEvent } from '@emgloop/shared';

const URL = process.env.LOOP_TEST_POSTGRES_URL ?? '';
const LOCAL = /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(URL);
const skip = !URL ? 'LOOP_TEST_POSTGRES_URL is not set' : !LOCAL ? 'refusing a non-local database' : false;

const NOW = new Date('2026-09-20T12:00:00Z');
const sealer = new ConnectionSecretSealer(randomBytes(32));

// Recognizable sensitive values we will assert never appear in the verifier's output.
const CONV_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const SENDER_KEY = 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe';
const OCCURRED_ISO = '2026-09-20T11:59:00.000Z';

async function reset(prisma: PrismaClient) {
  // These acceptance tests reason over the WHOLE table (the verifier is global, like staging with one
  // user), so start each from a clean slate. Safe: the Postgres tests are skipped in CI, and locally
  // each test file runs on its own.
  await prisma.sourceObservation.deleteMany({});
  await prisma.sourceConnection.deleteMany({});
}

async function seed(prisma: PrismaClient) {
  const organizationId = `org_ver_${randomUUID()}`;
  await prisma.organization.create({ data: { id: organizationId, name: 'VER', slug: organizationId } });
  const userId = `user_ver_${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, organizationId, email: `${userId}@example.test`, name: 'VER', status: 'ACTIVE', metadata: { systemRole: 'EMPLOYEE' } } });
  await prisma.organizationMembership.create({ data: { organizationId, userId, systemRole: 'EMPLOYEE', status: 'ACTIVE', effectiveFrom: new Date('2026-01-01T00:00:00Z') } });

  const connections = new SourceConnectionRepository(prisma);
  await connections.beginConnect(organizationId, userId, 'TELEGRAM', { actor: { userId }, now: NOW });
  const sealed = sealer.seal({ organizationId, userId, provider: 'TELEGRAM', credentialKind: 'MTPROTO_SESSION' }, 'session-string');
  await connections.storeCredential(organizationId, userId, 'TELEGRAM', { credentialKind: 'MTPROTO_SESSION', adapter: null, accountLabel: '@matt', backgroundObservation: 'OPERATIONAL', sealed, cursor: null, now: NOW }, { userId });
  await connections.recordCycle(organizationId, userId, 'TELEGRAM', { state: 'READY', backgroundObservation: 'OPERATIONAL', cursor: '42', now: NOW });

  const observations = new SourceObservationRepository(prisma);
  const event: ConversationEvent = {
    provider: 'TELEGRAM', conversationKey: CONV_KEY, providerEventId: `${CONV_KEY}:1`, participantKeys: [SENDER_KEY, 'aaaa'],
    senderKey: SENDER_KEY, direction: 'INBOUND', occurredAt: OCCURRED_ISO, observedAt: NOW.toISOString(), hadText: true, cursor: null,
  };
  await observations.append(organizationId, userId, 'TELEGRAM', [event]);
  return { organizationId, userId };
}

test('with a properly persisted observation, every acceptance criterion PASSES', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    await reset(prisma);
    await seed(prisma);
    const report = await verifyObservations(prisma, 'TELEGRAM');
    for (const r of report.results) assert.equal(r.pass, true, `expected PASS: ${r.criterion} -- ${r.detail}`);
    assert.equal(report.overall, 'PASS');
    assert.equal(report.counts.contentColumns, 0);
    assert.ok(report.counts.observations >= 1);
    assert.equal(report.counts.orphanOwners, 0);
    assert.equal(report.counts.distinctOwners >= 1, true);
  } finally {
    await prisma.$disconnect();
  }
});

test('the report emits NO sensitive observation field -- no keyed hash, id, timestamp value, or content', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    await reset(prisma);
    const { organizationId, userId } = await seed(prisma);
    const report = await verifyObservations(prisma, 'TELEGRAM');
    const serialized = JSON.stringify(report);
    // None of the seeded sensitive values may appear anywhere in the output.
    for (const secret of [CONV_KEY, SENDER_KEY, OCCURRED_ISO, organizationId, userId, 'session-string']) {
      assert.ok(!serialized.includes(secret), `the report leaked a sensitive value`);
    }
    // No long hex hash, no ISO timestamp anywhere in the serialized report.
    assert.doesNotMatch(serialized, /[a-f0-9]{32,}/i, 'a hash-like value leaked');
    assert.doesNotMatch(serialized, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'a timestamp value leaked');
    // Every counts field is a number; results are booleans + safe strings.
    for (const v of Object.values(report.counts)) assert.equal(typeof v, 'number');
    for (const r of report.results) assert.equal(typeof r.pass, 'boolean');
  } finally {
    await prisma.$disconnect();
  }
});

test('with no observations for a provider, the persistence criterion FAILS (not a false PASS)', { skip }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  try {
    await reset(prisma);
    const report = await verifyObservations(prisma, 'MICROSOFT_TEAMS'); // nothing seeded for Teams
    assert.equal(report.overall, 'FAIL');
    assert.equal(report.results.find((r) => /was persisted/.test(r.criterion))?.pass, false);
  } finally {
    await prisma.$disconnect();
  }
});
