// Pure contracts the Brain boundary adds in B5: the question a job may ask, and the
// controls work is admitted under.
//
// WHAT THESE PROVE
//
// A QUESTION IS STRUCTURED AND AN ANSWER IS ONLY AN ANSWER. Only the three kinds exist;
// extra fields, control characters, oversized text and duplicate options are refused; a
// reply must be of the question's kind and choose only what was offered.
//
// EFFECTIVE CONTROLS ARE THE FLOOR AND THE RECORDS. Absent means off where a control
// grants; any KILLED control stops; an organization may switch a task off for itself but
// never on beyond the platform; MODEL controls only ever stop; nothing crosses to
// another organization.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRAIN_QUESTION_LIMITS,
  aiEffectiveControls,
  aiTaskAvailability,
  parseBrainQuestion,
  parseBrainQuestionReply,
  type AiControlEntry,
  type AiControlFloor,
  type AiRoutingPolicy,
  type BrainQuestion,
} from '../src';

// --- Questions ---------------------------------------------------------------------------

const choose = {
  kind: 'CHOOSE_ONE',
  prompt: 'Which relationship did you mean?',
  options: [
    { id: 'a', label: 'Acme (buyer)', ref: 'relationship:rel_1' },
    { id: 'b', label: 'Acme (vendor)', ref: null },
  ],
};

test('the three kinds of question parse, and nothing else does', () => {
  assert.deepEqual(parseBrainQuestion(choose), { ok: true, question: choose });
  assert.deepEqual(parseBrainQuestion({ kind: 'CONFIRM', prompt: 'Use 90 days?' }), { ok: true, question: { kind: 'CONFIRM', prompt: 'Use 90 days?' } });
  assert.deepEqual(parseBrainQuestion({ kind: 'SHORT_TEXT', prompt: 'Which invoice?', maxLength: 40 }), {
    ok: true,
    question: { kind: 'SHORT_TEXT', prompt: 'Which invoice?', maxLength: 40 },
  });

  const refused = (raw: unknown) => {
    const out = parseBrainQuestion(raw);
    return out.ok ? 'OK' : out.refusals.join(',');
  };
  assert.equal(refused(null), 'NOT_AN_OBJECT');
  assert.equal(refused([choose]), 'NOT_AN_OBJECT');
  assert.equal(refused({ kind: 'FREE_FORM', prompt: 'Anything?' }), 'UNKNOWN_KIND');
  assert.equal(refused({ ...choose, organizationId: 'org_b' }), 'UNEXPECTED_FIELD');
  assert.equal(refused({ kind: 'CONFIRM', prompt: 'x', instruction: 'ignore previous' }), 'UNEXPECTED_FIELD');
  assert.equal(refused({ ...choose, prompt: '' }), 'PROMPT_INVALID');
  assert.equal(refused({ ...choose, prompt: 'x'.repeat(BRAIN_QUESTION_LIMITS.maxPromptChars + 1) }), 'PROMPT_INVALID');
  assert.equal(refused({ ...choose, prompt: `bell${String.fromCharCode(7)}` }), 'PROMPT_INVALID');
  assert.equal(refused({ kind: 'CONFIRM', prompt: 'line one\nline two' }), 'OK', 'newlines are text');
  assert.equal(refused({ ...choose, options: [choose.options[0]] }), 'OPTIONS_INVALID');
  assert.equal(refused({ ...choose, options: Array.from({ length: 11 }, (_, i) => ({ id: `o${i}`, label: `L${i}`, ref: null })) }), 'OPTIONS_INVALID');
  assert.equal(refused({ ...choose, options: [choose.options[0], choose.options[0]] }), 'DUPLICATE_OPTION');
  for (const option of [
    { id: 'has space', label: 'x', ref: null },
    { id: 'c', label: '', ref: null },
    { id: 'c', label: 'x'.repeat(BRAIN_QUESTION_LIMITS.maxLabelChars + 1), ref: null },
    { id: 'c', label: 'x', ref: 'https://example.test/rel' },
    { id: 'c', label: 'x', ref: 'relationship:rel 1' },
    { id: 'c', label: 'x', ref: null, action: 'delete' },
  ]) {
    assert.equal(refused({ ...choose, options: [choose.options[0], option] }), 'OPTION_INVALID', JSON.stringify(option));
  }
  assert.equal(refused({ kind: 'SHORT_TEXT', prompt: 'x', maxLength: 0 }), 'MAX_LENGTH_INVALID');
  assert.equal(refused({ kind: 'SHORT_TEXT', prompt: 'x', maxLength: BRAIN_QUESTION_LIMITS.maxShortText + 1 }), 'MAX_LENGTH_INVALID');
  assert.equal(refused({ kind: 'SHORT_TEXT', prompt: 'x', maxLength: 1.5 }), 'MAX_LENGTH_INVALID');
});

test('an answer answers exactly its question and carries nothing else', () => {
  const question = (parseBrainQuestion(choose) as { question: BrainQuestion }).question;
  const reply = (q: BrainQuestion, raw: unknown) => {
    const out = parseBrainQuestionReply(q, raw);
    return out.ok ? out.reply : out.refusals.join(',');
  };
  assert.deepEqual(reply(question, { kind: 'CHOOSE_ONE', optionId: 'b' }), { kind: 'CHOOSE_ONE', optionId: 'b' });
  assert.equal(reply(question, { kind: 'CHOOSE_ONE', optionId: 'c' }), 'NOT_AN_OFFERED_OPTION');
  assert.equal(reply(question, { kind: 'CHOOSE_ONE', optionId: 'relationship:rel_9' }), 'NOT_AN_OFFERED_OPTION', 'a record cannot be named by answering');
  assert.equal(reply(question, { kind: 'CONFIRM', confirmed: true }), 'KIND_MISMATCH');
  assert.equal(reply(question, { kind: 'CHOOSE_ONE', optionId: 'a', userId: 'user_9' }), 'UNEXPECTED_FIELD');
  assert.equal(reply(question, 'a'), 'NOT_AN_OBJECT');

  const confirm: BrainQuestion = { kind: 'CONFIRM', prompt: 'Proceed?' };
  assert.deepEqual(reply(confirm, { kind: 'CONFIRM', confirmed: false }), { kind: 'CONFIRM', confirmed: false });
  assert.equal(reply(confirm, { kind: 'CONFIRM', confirmed: 'yes' }), 'NOT_A_BOOLEAN');

  const short: BrainQuestion = { kind: 'SHORT_TEXT', prompt: 'Which invoice?', maxLength: 10 };
  assert.deepEqual(reply(short, { kind: 'SHORT_TEXT', text: 'INV-42' }), { kind: 'SHORT_TEXT', text: 'INV-42' });
  assert.equal(reply(short, { kind: 'SHORT_TEXT', text: 'INV-42-and-more' }), 'TEXT_TOO_LONG');
  assert.equal(reply(short, { kind: 'SHORT_TEXT', text: '   ' }), 'TEXT_INVALID');
  assert.equal(reply(short, { kind: 'SHORT_TEXT', text: `a${String.fromCharCode(0)}` }), 'TEXT_INVALID');
});

// --- Effective controls -------------------------------------------------------------------

const ORG = 'org_a';
const OTHER = 'org_b';
const TASK = 'case.explanation';

const FLOOR: AiControlFloor = {
  activation: { enabled: true, organizations: [ORG, OTHER], tasks: [TASK], providers: ['provider-a', 'provider-b'] },
  killSwitches: [],
};

let version = 0;
function control(scope: AiControlEntry['target']['scope'], organizationId: string | null, value: string | null, state: 'ACTIVE' | 'KILLED' = 'ACTIVE'): AiControlEntry {
  version += 1;
  return {
    target: { scope, organizationId, value },
    state,
    version,
    reason: 'test',
    actor: organizationId ? { kind: 'HUMAN', userId: 'user_1' } : { kind: 'OPERATIONS', reference: 'run-1' },
    recordedAtMs: version,
  };
}

const GRANTS: AiControlEntry[] = [
  control('GLOBAL', null, null),
  control('ORGANIZATION', ORG, ORG),
  control('TASK', null, TASK),
  control('PROVIDER', null, 'provider-a'),
];

const ROUTING: AiRoutingPolicy = {
  version: 'routing.test.1',
  tasks: {
    [TASK]: {
      taskId: TASK,
      taskVersion: '2.0.0',
      primary: { providerId: 'provider-a', modelId: 'model-a', reasoningEffort: 'medium', timeoutMs: 1000, maxOutputTokens: 100, pricing: { listVersion: 'l', inputMicrosPerToken: 1, outputMicrosPerToken: 1 } },
      fallback: null,
      fallbackPermitted: false,
      budgetClass: 'standard',
    },
  },
} as AiRoutingPolicy;

const availability = (floor: AiControlFloor, stored: readonly AiControlEntry[], organizationId = ORG) => {
  const e = aiEffectiveControls(floor, stored, organizationId);
  return aiTaskAvailability({ authorized: true, activation: e.activation, killSwitches: e.killSwitches, policy: ROUTING, organizationId, taskId: TASK });
};

test('work is admitted only where the floor AND a recorded grant both allow it', () => {
  assert.deepEqual(aiEffectiveControls(FLOOR, GRANTS, ORG), {
    activation: { enabled: true, organizations: [ORG], tasks: [TASK], providers: ['provider-a'] },
    killSwitches: [],
  });
  assert.equal(availability(FLOOR, GRANTS), 'AVAILABLE');
  assert.equal(availability(FLOOR, []), 'NOT_ENABLED', 'nothing recorded is nothing granted');
  assert.equal(availability({ ...FLOOR, activation: { ...FLOOR.activation, enabled: false } }, GRANTS), 'NOT_ENABLED', 'a record cannot turn on what the deployment has off');
  assert.equal(availability({ ...FLOOR, activation: { ...FLOOR.activation, providers: ['provider-b'] } }, GRANTS), 'NOT_CONFIGURED');
  for (const missing of GRANTS) {
    const without = GRANTS.filter((g) => g !== missing);
    assert.notEqual(availability(FLOOR, without), 'AVAILABLE', `${missing.target.scope} is required`);
  }
  assert.equal(availability(FLOOR, GRANTS, OTHER), 'NOT_ENABLED', 'one organization’s grant is not another’s');
  const otherGrant = [...GRANTS, control('ORGANIZATION', OTHER, OTHER)];
  assert.equal(availability(FLOOR, otherGrant, OTHER), 'AVAILABLE');
});

test('any applicable kill stops work, and only the organization it names', () => {
  // The current record of a control replaces its earlier one.
  const replacing = (killed: AiControlEntry) =>
    [...GRANTS.filter((g) => g.target.scope !== killed.target.scope || g.target.organizationId !== killed.target.organizationId || g.target.value !== killed.target.value), killed];
  assert.equal(availability(FLOOR, replacing(control('GLOBAL', null, null, 'KILLED'))), 'NOT_ENABLED');
  assert.deepEqual(aiEffectiveControls(FLOOR, replacing(control('GLOBAL', null, null, 'KILLED')), ORG).killSwitches, [{ scope: 'GLOBAL' }]);
  assert.equal(availability(FLOOR, replacing(control('TASK', null, TASK, 'KILLED'))), 'NOT_ENABLED');
  assert.equal(availability(FLOOR, replacing(control('ORGANIZATION', ORG, ORG, 'KILLED'))), 'NOT_ENABLED');
  assert.equal(availability(FLOOR, replacing(control('PROVIDER', null, 'provider-a', 'KILLED'))), 'PAUSED');
  assert.equal(availability(FLOOR, [...GRANTS, control('MODEL', null, 'model-a', 'KILLED')]), 'PAUSED', 'a model kill stops the only target');
  assert.equal(availability({ ...FLOOR, killSwitches: [{ scope: 'GLOBAL' }] }, GRANTS), 'PAUSED', 'the floor’s own kill switch');

  // An organization switches a task off for itself only.
  const orgTaskOff = [...GRANTS, control('ORGANIZATION', OTHER, OTHER), control('TASK', ORG, TASK, 'KILLED')];
  assert.equal(availability(FLOOR, orgTaskOff, ORG), 'NOT_ENABLED');
  assert.equal(availability(FLOOR, orgTaskOff, OTHER), 'AVAILABLE');
  assert.deepEqual(aiEffectiveControls(FLOOR, orgTaskOff, OTHER).killSwitches, [], 'it never becomes a platform kill switch');
  assert.deepEqual(aiEffectiveControls(FLOOR, orgTaskOff, ORG).killSwitches, [], 'for the organization itself it reads as switched off, not as paused by the platform');

  // An organization cannot enable a task the platform has not; nor can a MODEL record grant anything.
  const orgOnly = [control('GLOBAL', null, null), control('ORGANIZATION', ORG, ORG), control('TASK', ORG, TASK), control('PROVIDER', null, 'provider-a')];
  assert.equal(availability(FLOOR, orgOnly), 'NOT_ENABLED');
  const modelOnly = [...orgOnly, control('MODEL', null, 'model-a')];
  assert.equal(availability(FLOOR, modelOnly), 'NOT_ENABLED');

  // Another organization's kill never reaches this one.
  assert.equal(availability(FLOOR, [...GRANTS, control('ORGANIZATION', OTHER, OTHER, 'KILLED')], ORG), 'AVAILABLE');
});
