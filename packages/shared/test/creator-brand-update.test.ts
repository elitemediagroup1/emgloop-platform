import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AI_TASK_CREATOR_BRAND_UPDATE } from '../src/ai/intelligence-tasks';
import { aiTaskContractViolations } from '../src/ai/task';
import { CREATOR_BRAND_UPDATE_SCHEMA_ID, parseCreatorBrandUpdate, validateCreatorBrandUpdate } from '../src/ai/creator-brand-update';
import { aiOutputContract } from '../src/ai/output-contracts';
const ref = 'mail_message:thread:1';
const evidence = { figures: new Map(), dates: new Set<string>(), verbatimRuns: new Set<string>() };
const update = (patch: Record<string, unknown> = {}) => ({ schemaId: CREATOR_BRAND_UPDATE_SCHEMA_ID, publishable: true, stage: 'AWAITING_EMG', summary: 'The brand is reviewing the proposed collaboration. EMG is preparing the requested creator materials.', nextStep: 'EMG will respond with the requested information.', citations: [ref], ...patch });
function rejections(patch: Record<string, unknown>) {
  const output = parseCreatorBrandUpdate(update(patch)); assert.ok(output);
  return validateCreatorBrandUpdate(output, AI_TASK_CREATOR_BRAND_UPDATE, new Set([ref, 'creator_scope:a']), evidence);
}
test('dedicated creator publication task has an admitted ownership and its own output contract', () => {
  assert.deepEqual(aiTaskContractViolations(AI_TASK_CREATOR_BRAND_UPDATE), []);
  assert.ok(aiOutputContract(CREATOR_BRAND_UPDATE_SCHEMA_ID));
  assert.deepEqual(rejections({}), []);
});
test('withholding carries no prose and malformed/extra fields are rejected', () => {
  assert.equal(parseCreatorBrandUpdate(update({ extra: 'secret' })), null);
  assert.equal(parseCreatorBrandUpdate(update({ stage: 'GUESS' })), null);
  assert.deepEqual(rejections({ publishable: false, summary: '', nextStep: '', citations: [] }), []);
  assert.ok(rejections({ publishable: false }).includes('WRONG_SCHEMA'));
});
test('publication rejects private financial details, contact values, invented numbers and invalid citations', () => {
  for (const summary of ['They offered $500.', 'The commission is twenty percent.', 'Ask me@example.com.', 'The agreed rate is negotiable.', 'The fee is high.', 'Use https://secret.test.', 'The code is 12345678.']) assert.ok(rejections({ summary }).length, summary);
  assert.ok(rejections({ summary: 'They requested 32 videos.' }).includes('UNSUPPORTED_NUMBER_IN_TEXT'));
  assert.ok(rejections({ citations: [] }).includes('UNCITED_CLAIM'));
  assert.ok(rejections({ citations: ['creator_scope:a'] }).includes('CITATION_NOT_SUPPLIED'));
  assert.ok(rejections({ citations: ['mail_message:foreign:1'] }).includes('CITATION_NOT_SUPPLIED'));
  assert.ok(rejections({ summary: 'x'.repeat(601) }).includes('ANSWER_TOO_LONG'));
});

test('negotiating is an admitted stage distinct from a pitch or a confirmed agreement', () => {
  assert.ok(parseCreatorBrandUpdate(update({ stage: 'NEGOTIATING' })));
  assert.deepEqual(rejections({ stage: 'NEGOTIATING' }), []);
});
