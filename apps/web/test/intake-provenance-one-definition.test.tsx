// Intake Record provenance has one definition -- Intake slice, part 2.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

describe('Intake provenance has one definition', () => {
  it('the People population audit uses the shared classifier rather than its own copy', () => {
    const audit = code(read('../../../packages/database/src/repositories/people-population-audit.repository.ts'));
    assert.match(audit, /provenanceClass: \(c: ProvenanceInput\) => ProvenanceClass = intakeProvenanceSegment/);
    assert.doesNotMatch(audit, /web-visitor:|createdFrom === 'callgrid'/);
  });
});
