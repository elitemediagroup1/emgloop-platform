// Intake Record provenance, pure. Intake slice, part 2.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  INGESTION_PROVENANCE_SEGMENTS,
  INTAKE_PROVENANCE_LABELS,
  INTAKE_PROVENANCE_SEGMENTS,
  intakeProvenanceSegment,
} from '../src/intake-provenance';

const seg = (externalId: string | null, tags: string[] | null, metadata: unknown) =>
  intakeProvenanceSegment({ externalId, tags, metadata });

test('classification follows the approved marks, top-down', () => {
  assert.equal(seg('web-visitor:v1', [], { createdFrom: 'website' }), 'INGESTION_WEB_VISITOR', 'a visitor mark wins over createdFrom');
  assert.equal(seg('web-visitor:v1', [], { createdFrom: 'callgrid' }), 'INGESTION_WEB_VISITOR', 'whatever createdFrom says');
  assert.equal(seg(null, ['Anonymous-Visitor'], {}), 'INGESTION_WEB_VISITOR', 'tags compare case-insensitively');
  assert.equal(seg(null, [], { createdFrom: 'callgrid' }), 'INGESTION_CALL');
  assert.equal(seg(null, [], { createdFrom: 'website' }), 'INGESTION_WEB_LEAD');
  assert.equal(seg('sic-demo-1', [], { createdFrom: 'zapier' }), 'INGESTION_OTHER_SOURCE', 'createdFrom wins over a demo prefix');
  for (const ext of ['sic-demo-1', 'demo-2', 'E2E-3', 'test-4', 'qa-5', 'hotfix-verify-6']) {
    assert.equal(seg(ext, [], {}), 'SEED_OR_DEMO', ext);
  }
  assert.equal(seg('simc-123', [], {}), 'EXTERNAL_IMPORT');
  assert.equal(seg(null, null, null), 'UNMARKED');
  assert.equal(seg('', [], { createdFrom: '   ' }), 'UNMARKED', 'blank marks are no marks');
  assert.equal(seg(null, [], ['callgrid']), 'UNMARKED', 'metadata that is not an object carries no mark');
});

test('every segment has a label; ingestion segments are exactly the automatic ones', () => {
  assert.deepEqual(Object.keys(INTAKE_PROVENANCE_LABELS).sort(), [...INTAKE_PROVENANCE_SEGMENTS].sort());
  assert.deepEqual([...INGESTION_PROVENANCE_SEGMENTS].sort(), INTAKE_PROVENANCE_SEGMENTS.filter((s) => s.startsWith('INGESTION_')).sort());
  for (const label of Object.values(INTAKE_PROVENANCE_LABELS)) {
    assert.doesNotMatch(label, /callgrid|servicesinmycity|person|people|identity/i, label);
  }
});

test('fence: pure, and a segment never reads a contact value', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'intake-provenance.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /email|phone|firstName|lastName|Date\.now|new Date\(|process\.env|prisma/i);
});
