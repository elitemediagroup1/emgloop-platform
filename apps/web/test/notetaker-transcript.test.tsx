import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_TASK_MEETING_SUMMARY, aiOutputContract } from '@emgloop/shared';
import { formatRecallTranscript } from '../src/notetaker/transcript';

test('the full transcript preserves every speech segment and its relative time', () => {
  const artifact = [
    { participant: { name: 'Matt' }, words: [{ text: 'First', start_timestamp: { relative: 3 } }, { text: 'point.' }] },
    { participant: null, words: [{ text: 'Next point.', start_timestamp: { relative: 62.8 } }] },
    { participant: { name: 'Matt' }, words: [] },
    { participant: { name: 'Matt' }, words: [{ text: 'Final point.' }] },
  ];
  assert.equal(formatRecallTranscript(artifact), '[0:03] Matt: First point.\n\n[1:02] Unidentified speaker: Next point.\n\nMatt: Final point.');
  assert.equal(formatRecallTranscript([]), '');
  assert.throws(() => formatRecallTranscript({ error: 'invalid response' }));
});

test('the meeting summary contract accepts a bounded private recap', () => {
  const contract = aiOutputContract(AI_TASK_MEETING_SUMMARY.outputSchemaId);
  assert.ok(contract);
  const output = contract.parse({ schemaId: contract.schemaId, summary: 'Discussed launch timing.' });
  assert.ok(output);
  assert.deepEqual(contract.validate(output, AI_TASK_MEETING_SUMMARY, new Set(), { figures: new Map(), dates: new Set() }), []);
  assert.equal(contract.parse({ schemaId: contract.schemaId, summary: [] }), null);
  const blank = contract.parse({ schemaId: contract.schemaId, summary: '  ' });
  assert.ok(blank);
  assert.deepEqual(contract.validate(blank, AI_TASK_MEETING_SUMMARY, new Set(), { figures: new Map(), dates: new Set() }), ['EMPTY_ANSWER']);
});
