// The Decision Event Contract, bound to the schema and to the engine.
//
// The contract itself (@emgloop/shared) is Prisma-free, so it cannot check two
// things that matter most: that its observation vocabulary matches the real enum,
// and that the engine actually publishes what it promises. That is this file.
//
// It also does something a prose contract never could: it checks that the
// NOT_BUILT guarantees are STILL not built. `EVENT_BUS.md` rotted because nothing
// noticed when reality moved. If somebody wires a drain and forgets to update the
// contract, this suite fails and tells them which line to change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  DECISION_EVENT_TYPE as CONTRACT_MAP,
  DECISION_EVENT_NAMES,
  OBSERVATION_TYPES,
  DELIVERY_GUARANTEES,
  isDecisionEventName,
} from '@emgloop/shared';

import { DECISION_EVENT_TYPE } from '../src/services/decision/decision-events';

const ROOT = join(__dirname, '..');
const SCHEMA = readFileSync(join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
const ENGINE = readFileSync(
  join(ROOT, 'src', 'services', 'decision', 'decision-engine.ts'),
  'utf8',
);

function enumMembers(name: string): string[] {
  const start = SCHEMA.indexOf(`enum ${name} {`);
  assert.notEqual(start, -1, `enum ${name} not found in schema`);
  const body = SCHEMA.slice(start, SCHEMA.indexOf('\n}', start));
  return body
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('///'))
    .map((l) => l.split(/\s+/)[0]!);
}

/** Every .ts file under a directory, excluding tests and generated output. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

// --- The schema binding -------------------------------------------------------

test('the contract vocabulary matches the Prisma enum, in both directions', () => {
  const prisma = enumMembers('OperationalObservationType');
  const contract = [...OBSERVATION_TYPES];

  // A member the contract does not map would publish `undefined` as an event.
  for (const member of prisma) {
    assert.ok(
      contract.includes(member as (typeof OBSERVATION_TYPES)[number]),
      `Prisma enum has ${member}, the contract does not. Add it to OBSERVATION_TYPES and DECISION_EVENT_TYPE.`,
    );
  }
  // A contract member with no column is a promise about a state that cannot occur.
  for (const member of contract) {
    assert.ok(
      prisma.includes(member),
      `The contract maps ${member}, which is not in the Prisma enum. Remove it or add the enum member.`,
    );
  }
  assert.equal(prisma.length, contract.length);
});

test('the database map IS the contract map, not a copy of it', () => {
  // Two tables that agree today drift tomorrow. The database file re-exports the
  // contract under a stricter key type; this asserts it never becomes a fork.
  assert.deepEqual(DECISION_EVENT_TYPE, CONTRACT_MAP);
  for (const type of enumMembers('OperationalObservationType')) {
    assert.equal(
      DECISION_EVENT_TYPE[type as keyof typeof DECISION_EVENT_TYPE],
      CONTRACT_MAP[type as keyof typeof CONTRACT_MAP],
    );
  }
});

// --- The engine binding -------------------------------------------------------

test('every event name the engine writes is in the vocabulary', () => {
  // The engine hardcodes a few names when reporting what it published. A typo
  // there produces an event no subscription will ever match, with no other signal.
  const literals = [...ENGINE.matchAll(/'(Decision[A-Za-z]+)'/g)].map((m) => m[1]!);
  assert.ok(literals.length > 0, 'expected the engine to name some events');
  for (const name of new Set(literals)) {
    assert.ok(
      isDecisionEventName(name),
      `the engine publishes "${name}", which is not in the contract vocabulary`,
    );
  }
});

test('there is exactly one place that enqueues a decision event', () => {
  // "Exactly one event per lifecycle operation" is only true while there is one
  // write path. A second enqueue site is how a change starts publishing twice.
  const sites = [...ENGINE.matchAll(/outbox\.enqueue\(/g)].length;
  assert.equal(sites, 1, `expected 1 enqueue site in the engine, found ${sites}`);
});

test('the engine builds its payload against the contract type', () => {
  // The payload was an untyped object literal until v1: a renamed field broke
  // every subscriber at runtime with no compile error. The annotation is the
  // enforcement, so its absence is a regression worth failing on.
  assert.match(
    ENGINE,
    /const payload:\s*DecisionEventPayloadV1\s*=/,
    'the engine payload must be annotated DecisionEventPayloadV1 so the compiler checks it',
  );
});

test('every declared event is reachable from a real enum member', () => {
  const prisma = new Set(enumMembers('OperationalObservationType'));
  for (const name of DECISION_EVENT_NAMES) {
    const reachable = [...prisma].some(
      (t) => CONTRACT_MAP[t as keyof typeof CONTRACT_MAP] === name,
    );
    assert.ok(reachable, `"${name}" is declared but no schema enum member produces it`);
  }
});

// --- The guarantees, checked against reality ----------------------------------

test('the delivery-execution guarantee tells the truth about the drain', () => {
  // The whole point of an executable contract. If someone builds the drain, this
  // fails until the contract is updated; if someone marks it GUARANTEED without
  // building it, this fails too.
  const callers = sourceFiles(join(ROOT, 'src'))
    .concat(sourceFiles(join(ROOT, '..', '..', 'apps', 'web', 'src')))
    .filter((f) => /new StateChangePublisher\s*\(/.test(readFileSync(f, 'utf8')));

  const declared = DELIVERY_GUARANTEES.find((g) => g.id === 'delivery-execution');
  assert.ok(declared, 'the delivery-execution guarantee must exist');

  if (callers.length === 0) {
    assert.equal(
      declared.status,
      'NOT_BUILT',
      'nothing constructs StateChangePublisher, so delivery-execution must stay NOT_BUILT',
    );
  } else {
    assert.notEqual(
      declared.status,
      'NOT_BUILT',
      `StateChangePublisher is now constructed in ${callers.join(', ')} — update the delivery-execution guarantee in packages/shared/src/decision-events.ts`,
    );
  }
});

test('the at-least-once caveat matches the claim implementation', () => {
  // The claim is a conditional update over PENDING|FAILED only. A delivery
  // abandoned in PROCESSING is therefore never reclaimed, which is why the
  // guarantee is PARTIAL rather than GUARANTEED. If a lease is added, this fails.
  const repo = readFileSync(
    join(ROOT, 'src', 'repositories', 'cognitive', 'delivery.repository.ts'),
    'utf8',
  );
  const claim = repo.slice(repo.indexOf('async claim('));
  const body = claim.slice(0, claim.indexOf('\n  }'));
  const reclaimsStale = /PROCESSING'/.test(body.split('data:')[0] ?? '');

  const declared = DELIVERY_GUARANTEES.find((g) => g.id === 'at-least-once');
  assert.ok(declared);
  if (!reclaimsStale) {
    assert.equal(
      declared.status,
      'PARTIAL',
      'claim() does not reclaim stale PROCESSING rows, so at-least-once must stay PARTIAL',
    );
  }
});
