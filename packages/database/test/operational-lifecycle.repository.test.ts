// OperationalPriorityRepository — persistence behaviour proven against the
// in-memory Prisma double, which enforces the same @@unique constraints Postgres
// does. No database required.
//
// The first tests are cross-tenant access attempts, deliberately. This repo's
// worst production bugs were all cross-tenant writes introduced by people
// actively thinking about tenancy, and the lesson recorded in CLAUDE.md is that
// review cannot catch them because the safe call and the unsafe call look
// identical at the call site. So they are asserted, not reviewed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OperationalPriorityState,
  OperationalObservationType,
  OperationalOutcome,
  OperationalActorType,
} from '@prisma/client';
import {
  PRIORITY_STATES,
  OBSERVATION_TYPES,
  OPERATIONAL_OUTCOMES,
} from '@emgloop/shared';

import { makeCognitivePrisma } from './helpers/cognitive-prisma-fake';
import { OperationalPriorityRepository } from '../src/repositories/operational-priority.repository';

const ORG = 'org-alpha';
const OTHER_ORG = 'org-beta';

const T0 = new Date('2026-07-28T20:00:00.000Z');
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

function makeRepo() {
  const prisma = makeCognitivePrisma();
  return { prisma, repo: new OperationalPriorityRepository(prisma as never) };
}

function detection(overrides: Record<string, unknown> = {}) {
  return {
    sourceSystem: 'CALLGRID',
    recurrenceKey: 'buyer-decline::markytek',
    detectionKey: 'yesterday:2026-07-28',
    detectedAt: T0,
    title: 'Markytek stopped purchasing',
    summary: 'Revenue from this buyer fell to zero.',
    severity: 'CRITICAL',
    impactCents: 420_000,
    impactLabel: 'Measured decline',
    ...overrides,
  };
}

// --- Contract parity --------------------------------------------------------
//
// @emgloop/shared must stay Prisma-free, so the lifecycle vocabulary is declared
// in both places. That duplication is only safe if it is checked: a schema
// change that forgets the contract has to fail here rather than surface as a
// projection silently ignoring a state it has never heard of.

test('the shared lifecycle vocabulary matches the Prisma enums exactly', () => {
  assert.deepEqual([...PRIORITY_STATES].sort(), Object.values(OperationalPriorityState).sort());
  assert.deepEqual([...OBSERVATION_TYPES].sort(), Object.values(OperationalObservationType).sort());
  assert.deepEqual([...OPERATIONAL_OUTCOMES].sort(), Object.values(OperationalOutcome).sort());
  assert.deepEqual(['HUMAN', 'SYSTEM'].sort(), Object.values(OperationalActorType).sort());
});

// --- Tenant isolation -------------------------------------------------------

test('a priority from another organization is not-found, never touched', async () => {
  const { repo } = makeRepo();
  const { priority } = await repo.detect(ORG, detection());

  assert.equal(await repo.findById(OTHER_ORG, priority.id), null);
  assert.equal(await repo.findWithLog(OTHER_ORG, priority.id), null);
  assert.equal(
    await repo.recordObservation(OTHER_ORG, priority.id, {
      observationType: 'RESOLVED',
      occurredAt: day(1),
      actorType: 'HUMAN',
      actorUserId: 'attacker',
      source: 'operator',
      outcome: 'RECOVERED',
    }),
    null,
  );
  assert.equal(await repo.rebuildProjection(OTHER_ORG, priority.id), null);

  // And nothing was written for the write that did not happen.
  const after = await repo.findWithLog(ORG, priority.id);
  assert.equal(after!.priority.state, 'NEEDS_REVIEW');
  assert.equal(after!.observations.length, 1, 'no observation recorded for a refused write');
});

test('the same recurrence key in two organizations is two independent priorities', async () => {
  const { repo } = makeRepo();
  const a = await repo.detect(ORG, detection());
  const b = await repo.detect(OTHER_ORG, detection());

  assert.notEqual(a.priority.id, b.priority.id);
  assert.equal(a.effect, 'OPENED');
  assert.equal(b.effect, 'OPENED');

  await repo.recordObservation(ORG, a.priority.id, {
    observationType: 'RESOLVED',
    occurredAt: day(1),
    actorType: 'HUMAN',
    actorUserId: 'user-matt',
    source: 'operator',
    outcome: 'RECOVERED',
  });
  assert.equal((await repo.findById(OTHER_ORG, b.priority.id))!.state, 'NEEDS_REVIEW');
});

// --- Detection is idempotent per period -------------------------------------

test('re-rendering the page does not append a second sighting', async () => {
  const { repo } = makeRepo();
  const first = await repo.detect(ORG, detection());
  assert.equal(first.effect, 'OPENED');

  for (let i = 0; i < 25; i++) {
    const again = await repo.detect(ORG, detection());
    assert.equal(again.effect, 'ALREADY_RECORDED');
  }

  const log = await repo.listObservations(ORG, first.priority.id);
  assert.equal(log.length, 1, '25 refreshes, one observation');
  assert.equal((await repo.findById(ORG, first.priority.id))!.detectionCount, 1);
});

test('a new analysis period records exactly one re-sighting', async () => {
  const { repo } = makeRepo();
  const opened = await repo.detect(ORG, detection());
  const next = await repo.detect(
    ORG,
    detection({ detectionKey: 'yesterday:2026-07-29', detectedAt: day(1) }),
  );

  assert.equal(next.effect, 'RESIGHTED');
  assert.equal(next.priority.detectionCount, 2);
  assert.deepEqual(next.priority.lastDetectedAt, day(1));
  assert.deepEqual(next.priority.firstDetectedAt, T0);

  const log = await repo.listObservations(ORG, opened.priority.id);
  assert.deepEqual(log.map((o) => o.observationType), ['SITUATION_DETECTED', 'SITUATION_RESIGHTED']);
  assert.deepEqual(log.map((o) => o.sequence), [1, 2]);
});

test('re-sighting an assigned priority does not drag it back into the queue', async () => {
  const { repo } = makeRepo();
  const { priority } = await repo.detect(ORG, detection());
  await repo.recordObservation(ORG, priority.id, {
    observationType: 'ASSIGNED',
    occurredAt: day(0),
    actorType: 'HUMAN',
    actorUserId: 'user-matt',
    source: 'operator',
    assignedToUserId: 'user-sam',
  });

  const again = await repo.detect(
    ORG,
    detection({ detectionKey: 'yesterday:2026-07-29', detectedAt: day(1) }),
  );
  assert.equal(again.priority.state, 'ASSIGNED');
  assert.equal(again.priority.ownerUserId, 'user-sam');
});

// --- Reappearance -----------------------------------------------------------

test('a sighting AFTER a resolution reopens it and counts the relapse', async () => {
  const { repo } = makeRepo();
  const { priority } = await repo.detect(ORG, detection());
  await repo.recordObservation(ORG, priority.id, {
    observationType: 'RESOLVED',
    occurredAt: day(1),
    actorType: 'HUMAN',
    actorUserId: 'user-matt',
    source: 'operator',
    outcome: 'RECOVERED',
    measuredEffectCents: 198_000,
  });
  assert.equal((await repo.findById(ORG, priority.id))!.state, 'RESOLVED');

  const relapse = await repo.detect(
    ORG,
    detection({ detectionKey: 'yesterday:2026-08-10', detectedAt: day(13) }),
  );
  assert.equal(relapse.effect, 'REOPENED');
  assert.equal(relapse.priority.state, 'NEEDS_REVIEW');
  assert.equal(relapse.priority.reopenCount, 1);
  assert.equal(relapse.priority.resolvedAt, null);
  assert.equal(relapse.priority.outcome, null);
});

test('browsing BACK to an older period does not reopen a resolved priority', async () => {
  const { repo } = makeRepo();
  const { priority } = await repo.detect(
    ORG,
    detection({ detectionKey: 'yesterday:2026-08-01', detectedAt: day(4) }),
  );
  await repo.recordObservation(ORG, priority.id, {
    observationType: 'RESOLVED',
    occurredAt: day(5),
    actorType: 'HUMAN',
    actorUserId: 'user-matt',
    source: 'operator',
    outcome: 'RECOVERED',
  });

  // The operator opens last week to check what happened. That is reading, not
  // relapsing, and it must not corrupt the operational record.
  const historical = await repo.detect(
    ORG,
    detection({ detectionKey: 'day:2026-07-28', detectedAt: T0 }),
  );
  assert.equal(historical.effect, 'RESIGHTED');
  assert.equal(historical.priority.state, 'RESOLVED', 'still resolved');
  assert.equal(historical.priority.reopenCount, 0);
  assert.deepEqual(historical.priority.lastDetectedAt, day(4), 'last-seen never rewinds');
  assert.deepEqual(historical.priority.firstDetectedAt, T0, 'but first-seen can move earlier');
});

// --- The log is the truth ---------------------------------------------------

test('every state change leaves the fact that explains it', async () => {
  const { repo } = makeRepo();
  const { priority } = await repo.detect(ORG, detection());

  const steps = [
    { observationType: 'REVIEWED' as const, expect: 'NEEDS_REVIEW' },
    { observationType: 'ASSIGNED' as const, assignedToUserId: 'user-sam', expect: 'ASSIGNED' },
    { observationType: 'CONTACT_ATTEMPTED' as const, expect: 'ASSIGNED' },
    { observationType: 'WATCH_STARTED' as const, expect: 'WATCHING' },
    { observationType: 'RESOLVED' as const, outcome: 'RECOVERED' as const, expect: 'RESOLVED' },
  ];

  let i = 0;
  for (const step of steps) {
    i += 1;
    const { expect, ...input } = step;
    const result = await repo.recordObservation(ORG, priority.id, {
      occurredAt: day(i),
      actorType: 'HUMAN',
      actorUserId: 'user-matt',
      source: 'operator',
      ...input,
    });
    assert.equal(result!.priority.state, expect, `after ${step.observationType}`);
    assert.equal(result!.priority.observationCount, i + 1);
  }

  const log = await repo.listObservations(ORG, priority.id);
  assert.equal(log.length, 6);
  assert.deepEqual(log.map((o) => o.sequence), [1, 2, 3, 4, 5, 6]);
});

test('the stored columns are rebuildable from the log alone', async () => {
  const { prisma, repo } = makeRepo();
  const { priority } = await repo.detect(ORG, detection());
  await repo.recordObservation(ORG, priority.id, {
    observationType: 'ASSIGNED',
    occurredAt: day(1),
    actorType: 'HUMAN',
    actorUserId: 'user-matt',
    source: 'operator',
    assignedToUserId: 'user-sam',
  });
  const truth = await repo.findById(ORG, priority.id);

  // Corrupt the cache the way a bad migration or a stray write would.
  await prisma.operationalPriority.update({
    where: { id: priority.id },
    data: { state: 'DISMISSED', ownerUserId: null, reopenCount: 99, observationCount: 0 },
  });
  assert.equal((await repo.findById(ORG, priority.id))!.state, 'DISMISSED');

  const rebuilt = await repo.rebuildProjection(ORG, priority.id);
  assert.equal(rebuilt!.state, truth!.state);
  assert.equal(rebuilt!.ownerUserId, truth!.ownerUserId);
  assert.equal(rebuilt!.reopenCount, truth!.reopenCount);
  assert.equal(rebuilt!.observationCount, truth!.observationCount);
});

test('an observation is never editable — the repository exposes no update path', () => {
  const surface = Object.getOwnPropertyNames(OperationalPriorityRepository.prototype);
  for (const forbidden of ['updateObservation', 'deleteObservation', 'setState']) {
    assert.ok(!surface.includes(forbidden), `${forbidden} must not exist`);
  }
});

// --- Lanes ------------------------------------------------------------------

test('lane counts come from the projection and cover every lane', async () => {
  const { repo } = makeRepo();
  const keys = ['a', 'b', 'c', 'd'];
  const ids: string[] = [];
  for (const k of keys) {
    const { priority } = await repo.detect(ORG, detection({ recurrenceKey: k, detectionKey: `p:${k}` }));
    ids.push(priority.id);
  }

  await repo.recordObservation(ORG, ids[1]!, {
    observationType: 'ASSIGNED', occurredAt: day(1), actorType: 'HUMAN',
    actorUserId: 'u', source: 'operator', assignedToUserId: 'user-sam',
  });
  await repo.recordObservation(ORG, ids[2]!, {
    observationType: 'WATCH_STARTED', occurredAt: day(1), actorType: 'HUMAN',
    actorUserId: 'u', source: 'operator',
  });
  await repo.recordObservation(ORG, ids[3]!, {
    observationType: 'DISMISSED', occurredAt: day(1), actorType: 'HUMAN',
    actorUserId: 'u', source: 'operator', outcome: 'FALSE_POSITIVE',
  });

  const counts = await repo.countsByState(ORG, 'CALLGRID');
  assert.deepEqual(counts, {
    NEEDS_REVIEW: 1, ASSIGNED: 1, WATCHING: 1, RESOLVED: 0, DISMISSED: 1,
  });

  // Another organization's rows never appear in these counts.
  await repo.detect(OTHER_ORG, detection({ recurrenceKey: 'x', detectionKey: 'p:x' }));
  const stillOurs = await repo.countsByState(ORG, 'CALLGRID');
  assert.equal(stillOurs.NEEDS_REVIEW, 1);
});

test('history is derived for a priority and survives a relapse', async () => {
  const { repo } = makeRepo();
  const { priority } = await repo.detect(ORG, detection());
  await repo.recordObservation(ORG, priority.id, {
    observationType: 'ASSIGNED', occurredAt: day(1), actorType: 'HUMAN',
    actorUserId: 'user-matt', source: 'operator', assignedToUserId: 'user-sam',
  });
  await repo.recordObservation(ORG, priority.id, {
    observationType: 'CONTACT_COMPLETED', occurredAt: day(2), actorType: 'HUMAN',
    actorUserId: 'user-sam', source: 'operator',
  });
  await repo.recordObservation(ORG, priority.id, {
    observationType: 'RESOLVED', occurredAt: day(3), actorType: 'HUMAN',
    actorUserId: 'user-sam', source: 'operator', outcome: 'RECOVERED', measuredEffectCents: 198_000,
  });

  const withLog = await repo.findWithLog(ORG, priority.id);
  assert.equal(withLog!.history.msToFirstDecision, 86_400_000);
  assert.equal(withLog!.history.msToResolution, 3 * 86_400_000);
  assert.equal(withLog!.history.contactAttempts, 1);
  assert.deepEqual(withLog!.history.humanActors, ['user-matt', 'user-sam']);

  await repo.detect(ORG, detection({ detectionKey: 'later', detectedAt: day(20) }));
  const after = await repo.findWithLog(ORG, priority.id);
  assert.equal(after!.history.msToResolution, null, 'a resolution that did not hold is not one');
  assert.equal(after!.history.timesReopened, 1);
});
