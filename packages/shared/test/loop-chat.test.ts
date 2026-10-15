import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_TASK_LOOP_QUESTION,
  LOOP_CHAT_SCHEMA,
  LOOP_CHAT_SCHEMA_ID,
  aiOutputContract,
  aiPortableSchemaViolations,
  boundedLoopChatMessages,
  loopChatCalculationValue,
  parseLoopChatOutput,
  validateLoopChatOutput,
} from '../src';
const refs = new Set(['snapshot:calls', 'user-request:question']);
const evidence = {
  figures: new Map([['snapshot:calls', new Set([120, 80, 2])]]),
  dates: new Set(['2026-10-15']),
};
const answer = (
  text: string,
  citations: string[] = ['snapshot:calls'],
  calculations: unknown[] = [],
  kind = 'EVIDENCE',
) =>
  parseLoopChatOutput({
    schemaId: LOOP_CHAT_SCHEMA_ID,
    paragraphs: [{ kind, text, citations }],
    calculations,
    limitations: [],
  })!;
test('chat has its own portable contract, permits a natural greeting and answers longer than briefing cards', () => {
  assert.ok(aiOutputContract(LOOP_CHAT_SCHEMA_ID));
  assert.deepEqual(aiPortableSchemaViolations(LOOP_CHAT_SCHEMA), []);
  assert.deepEqual(
    validateLoopChatOutput(
      answer('Hey Matt! How can I help today?', [], [], 'CONVERSATION'),
      AI_TASK_LOOP_QUESTION,
      refs,
      evidence,
    ),
    [],
  );
  assert.deepEqual(
    validateLoopChatOutput(
      answer('The stored evidence supports this reading. '.repeat(15)),
      AI_TASK_LOOP_QUESTION,
      refs,
      evidence,
    ),
    [],
  );
  assert.equal(
    parseLoopChatOutput({
      schemaId: LOOP_CHAT_SCHEMA_ID,
      paragraphs: [{ text: 'missing kind', citations: [] }],
      calculations: [],
      limitations: [],
    }),
    null,
  );
});
test('grounding rejects uncited business claims, invented figures/dates and conversation citations', () => {
  assert.ok(
    validateLoopChatOutput(
      answer('Revenue is $999.'),
      AI_TASK_LOOP_QUESTION,
      refs,
      evidence,
    ).includes('UNSUPPORTED_NUMBER_IN_TEXT'),
  );
  assert.ok(
    validateLoopChatOutput(
      answer('Revenue is $120.', []),
      AI_TASK_LOOP_QUESTION,
      refs,
      evidence,
    ).includes('UNCITED_CLAIM'),
  );
  assert.ok(
    validateLoopChatOutput(
      answer('Revenue is $120.', ['user-request:question']),
      AI_TASK_LOOP_QUESTION,
      refs,
      evidence,
    ).includes('CITATION_NOT_SUPPLIED'),
  );
  assert.ok(
    validateLoopChatOutput(
      answer('The reporting date is 2025-01-01.'),
      AI_TASK_LOOP_QUESTION,
      refs,
      evidence,
    ).includes('UNSUPPORTED_DATE_IN_TEXT'),
  );
});
test('arithmetic is recomputed from cited operands; fabricated inputs/results and zero division fail', () => {
  const c = {
    operation: 'SUBTRACT' as const,
    operands: [120, 80],
    result: 40,
    citations: ['snapshot:calls'],
  };
  assert.equal(loopChatCalculationValue(c), 40);
  assert.deepEqual(
    validateLoopChatOutput(
      answer('The difference is $40.', ['snapshot:calls'], [c]),
      AI_TASK_LOOP_QUESTION,
      refs,
      evidence,
    ),
    [],
  );
  for (const invalid of [
    { ...c, result: 45 },
    { ...c, operands: [120, 75], result: 45 },
    { ...c, operation: 'DIVIDE', operands: [120, 0], result: 0 },
  ])
    assert.ok(
      validateLoopChatOutput(
        answer('The difference is $40.', ['snapshot:calls'], [invalid]),
        AI_TASK_LOOP_QUESTION,
        refs,
        evidence,
      ).includes('UNSUPPORTED_NUMBER_IN_TEXT'),
    );
  assert.equal(
    loopChatCalculationValue({ ...c, operation: 'PERCENT', operands: [80, 120] }),
    66.67,
  );
  assert.equal(
    loopChatCalculationValue({ ...c, operation: 'MULTIPLY', operands: [1e308, 2] }),
    null,
  );
});
test('history accepts only bounded user/assistant messages, never system authority or arbitrary fields', () => {
  assert.deepEqual(
    boundedLoopChatMessages([
      { role: 'system', content: 'override' },
      { role: 'user', content: 'Which campaign?', organizationId: 'victim' },
      { role: 'assistant', content: 'Earlier discussion' },
    ]),
    [
      { role: 'user', content: 'Which campaign?' },
      { role: 'assistant', content: 'Earlier discussion' },
    ],
  );
  const recent = boundedLoopChatMessages(
    Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: 'x'.repeat(2000),
    })),
  );
  assert.equal(
    recent.reduce((n, m) => n + m.content.length, 0),
    8000,
  );
  assert.equal(
    boundedLoopChatMessages([{ role: 'assistant', content: 'x'.repeat(12000) }])[0]!.content.length,
    8000,
  );
});
