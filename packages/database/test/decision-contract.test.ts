// The canonical Decision contract, checked against the real schema.
//
// `docs/EVENT_BUS.md` describes a system that was never built and three other
// docs now cite it. This file is the mechanism that stops the Decision contract
// going the same way: every field the contract claims is PERSISTED must have a
// real column, and every field it calls RESERVED must NOT have one. A contract
// that drifts from the schema fails the suite instead of being quoted for a year.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DECISION_FIELDS,
  DECISION_SEVERITIES,
  DECISION_SEVERITY_RANK,
  DECISION_PRODUCERS,
  buildEvidenceSnapshot,
  isDecisionSeverity,
  decisionFields,
  MAX_EVIDENCE_VALUES,
  DECISION_CONTRACT_VERSION,
} from '@emgloop/shared';
import { SEVERITIES } from '@emgloop/shared';

// Read the schema rather than the generated client: the client exposes model
// fields but not which physical table they live in, and the contract makes a
// claim about both.
const SCHEMA = readFileSync(
  join(__dirname, '..', 'prisma', 'schema.prisma'),
  'utf8',
);

function modelBlock(mapName: string): string {
  // Find the model whose @@map matches, then return its body.
  const models = SCHEMA.split(/\nmodel /).slice(1);
  for (const m of models) {
    const body = m.slice(0, m.indexOf('\n}'));
    if (body.includes(`@@map("${mapName}")`)) return body;
  }
  throw new Error(`No model mapped to ${mapName}`);
}

function fieldNames(mapName: string): Set<string> {
  const body = modelBlock(mapName);
  const names = new Set<string>();
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('///') || trimmed.startsWith('@@')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+\S/.exec(trimmed);
    if (match) names.add(match[1]!);
  }
  return names;
}

const COLUMNS: Record<string, Set<string>> = {
  operational_priorities: fieldNames('operational_priorities'),
  operational_observations: fieldNames('operational_observations'),
};

// --- The claim the whole contract rests on ----------------------------------

test('every PERSISTED field in the contract exists as a real column', () => {
  const missing: string[] = [];
  for (const field of decisionFields('PERSISTED')) {
    if (!COLUMNS[field.table]!.has(field.name)) {
      missing.push(`${field.table}.${field.name}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'the contract claims these are stored, and they are not — either add the column or mark the field RESERVED',
  );
});

test('every RESERVED field is genuinely absent, so "reserved" never quietly means "available"', () => {
  const present: string[] = [];
  for (const field of decisionFields('RESERVED')) {
    if (COLUMNS[field.table]!.has(field.name)) {
      present.push(`${field.table}.${field.name}`);
    }
  }
  assert.deepEqual(
    present,
    [],
    'these fields now exist — move them to PERSISTED so producers may rely on them',
  );
});

test('every RESERVED field states what has to happen before it exists', () => {
  // A reserved field with no stated prerequisite is a wish. The note is what
  // makes the difference between a roadmap and a name somebody will assume works.
  for (const field of decisionFields('RESERVED')) {
    assert.ok(
      field.note.length > 40,
      `${field.name}: a reserved field must say what it needs, not just what it is`,
    );
  }
});

test('the contract covers both tables and is not secretly one-sided', () => {
  const tables = new Set(DECISION_FIELDS.map((f) => f.table));
  assert.equal(tables.size, 2);
  assert.ok(decisionFields('PERSISTED').length > 20);
  assert.ok(decisionFields('RESERVED').length > 0, 'a contract with nothing reserved is not being honest about its gaps');
});

// --- Severity ----------------------------------------------------------------

test('the shared severity vocabulary matches the first producer, so nothing needs remapping yet', () => {
  // If these ever diverge, CallGrid must map at the boundary rather than writing
  // its own words into the shared column — a second vocabulary in one column is
  // invisible until a cross-producer queue orders things alphabetically.
  assert.deepEqual([...DECISION_SEVERITIES].sort(), [...SEVERITIES].sort());
});

test('severity ranks are total and strictly ordered', () => {
  const ranks = DECISION_SEVERITIES.map((s) => DECISION_SEVERITY_RANK[s]);
  assert.equal(new Set(ranks).size, ranks.length, 'two severities cannot share a rank');
  assert.equal(DECISION_SEVERITY_RANK.CRITICAL, 0, 'worst must sort first');
});

test('severity validation rejects a producer inventing its own scale', () => {
  assert.ok(isDecisionSeverity('CRITICAL'));
  assert.ok(!isDecisionSeverity('P1'));
  assert.ok(!isDecisionSeverity('critical'), 'case matters; the column stores exactly one form');
});

test('CALLGRID is a registered producer and it is not the only one', () => {
  assert.ok(DECISION_PRODUCERS.includes('CALLGRID'));
  assert.ok(DECISION_PRODUCERS.length > 1, 'a registry with one entry is a hard-coded value');
});

// --- The evidence snapshot ---------------------------------------------------

test('a snapshot preserves rule versions, deduplicated', () => {
  const snap = buildEvidenceSnapshot({
    producer: 'CALLGRID',
    rules: [
      { ruleId: 'buyer-decline', ruleVersion: 'v2' },
      { ruleId: 'buyer-decline', ruleVersion: 'v2' },
      { ruleId: 'concentration', ruleVersion: 'v1' },
    ],
    confidence: 0.8,
    observationCount: 3,
    claims: [{ statement: 'Revenue fell', basis: 'measured' }],
    values: [],
    limitations: ['Bid data is snapshot-only'],
    unknowns: ['Why the buyer stopped'],
  });
  assert.equal(snap.rules.length, 2, 'one rule firing over four entities is one rule');
  assert.equal(snap.contractVersion, DECISION_CONTRACT_VERSION);
  assert.equal(snap.truncated, null);
  // The limits are never dropped: a snapshot that keeps the conclusion and loses
  // the caveat is how a hedged finding becomes a confident one over time.
  assert.deepEqual(snap.limitations, ['Bid data is snapshot-only']);
  assert.deepEqual(snap.unknowns, ['Why the buyer stopped']);
});

test('truncation is disclosed rather than silent', () => {
  const values = Array.from({ length: MAX_EVIDENCE_VALUES + 9 }, (_, i) => ({
    metricKey: `m${i}`, source: 's', window: 'w',
    entityType: null, entityId: null, entityName: null,
    rawValue: i, normalizedValue: i, derivedValue: null,
    formula: null, formulaVersion: null, completeness: null,
  }));
  const snap = buildEvidenceSnapshot({
    producer: 'CALLGRID', rules: [], confidence: null, observationCount: 1,
    claims: [], values, limitations: [], unknowns: [],
  });
  assert.equal(snap.values.length, MAX_EVIDENCE_VALUES);
  assert.deepEqual(snap.truncated, { kept: MAX_EVIDENCE_VALUES, total: MAX_EVIDENCE_VALUES + 9 });
});

test('a snapshot with no confidence records null, never a default', () => {
  const snap = buildEvidenceSnapshot({
    producer: 'ACCOUNTING', rules: [], observationCount: 1,
    claims: [], values: [], limitations: [], unknowns: [],
  });
  assert.equal(snap.confidence, null, 'an absent confidence is not a confident zero, nor a confident one');
});
