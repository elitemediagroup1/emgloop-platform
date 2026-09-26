// Loop Intelligence Phase G: the Briefing's output contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AI_TASKS, BRIEFING_SCHEMA, BRIEFING_SCHEMA_ID, aiOutputContract, aiPortableSchemaViolations, type AiSupportedEvidence } from '../src';

const task = AI_TASKS.find((t) => t.taskId === 'loop.briefing.compose')!;
const contract = aiOutputContract(BRIEFING_SCHEMA_ID)!;
const REFS = new Set(['digest:mail', 'digest:work', 'situation:c1']);
const EVIDENCE: AiSupportedEvidence = { figures: new Map([['digest:mail', new Set([3])], ['digest:work', new Set([2])]]), dates: new Set() };

const answer = (patch: Record<string, unknown> = {}) => ({
  schemaId: BRIEFING_SCHEMA_ID,
  headline: 'Three threads wait on you, and two steps are overdue.',
  lines: [
    { kind: 'NEEDS_YOU', statement: 'Three mail threads are waiting on your reply.', citations: ['digest:mail'] },
    { kind: 'WATCH', statement: 'Two of your work steps are past due.', citations: ['digest:work'] },
  ],
  limitations: [],
  ...patch,
});
const check = (v: unknown) => {
  const parsed = contract.parse(v);
  return parsed ? contract.validate(parsed, task, REFS, EVIDENCE) : ['UNPARSED'];
};

test('the Briefing task is the person’s own, read-only, portable, and stored in their work_briefs', () => {
  assert.equal(task.resultOwner.authority, 'EMPLOYEE_INTELLIGENCE');
  assert.equal(task.resultOwner.subjectType, 'EMPLOYEE_BRIEFING');
  assert.equal(task.consequence, 'READ_ONLY');
  assert.deepEqual(aiPortableSchemaViolations(BRIEFING_SCHEMA), []);
});

test('a grounded Briefing passes; numbers written as words are not figures', () => {
  assert.deepEqual(check(answer()), []);
});

test('a Briefing cites only supplied artifacts, states only numbers they hold, never a cause, never an instruction', () => {
  assert.ok(check(answer({ lines: [{ kind: 'NEEDS_YOU', statement: 'Mail waits.', citations: [] }] })).includes('UNCITED_CLAIM'));
  assert.ok(check(answer({ lines: [{ kind: 'NEEDS_YOU', statement: 'Mail waits.', citations: ['digest:elsewhere'] }] })).includes('CITATION_NOT_SUPPLIED'));
  assert.ok(check(answer({ lines: [{ kind: 'NEEDS_YOU', statement: '7 threads wait on you.', citations: ['digest:mail'] }] })).includes('UNSUPPORTED_NUMBER_IN_TEXT'));
  assert.ok(check(answer({ lines: [{ kind: 'WATCH', statement: '3 steps are overdue.', citations: ['digest:work'] }] })).includes('UNSUPPORTED_NUMBER_IN_TEXT'), 'a figure from another artifact is not support');
  assert.ok(check(answer({ headline: 'Work slipped because mail piled up.' })).includes('CAUSAL_OVERREACH'));
  assert.ok(check(answer({ lines: [{ kind: 'LATER', statement: 'x', citations: ['digest:mail'] }] })).includes('WRONG_SCHEMA'));
  assert.ok(check(answer({ lines: [{ kind: 'NEEDS_YOU', statement: 'You should send the quote now.', citations: ['digest:mail'] }] })).length > 0);
  assert.ok(check(answer({ lines: Array.from({ length: 7 }, () => ({ kind: 'WATCH', statement: 'x', citations: ['digest:mail'] })) })).includes('ANSWER_TOO_LONG'));
});
