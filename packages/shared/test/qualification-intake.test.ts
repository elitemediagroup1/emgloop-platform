import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTAKE_TEMPLATES,
  INTAKE_TRANSITIONS,
  intakeTemplate,
  readIntakeTemplate,
  validateIntakeContent,
  type IntakeContent,
} from '../src/qualification-intake';
const template = intakeTemplate('CREATOR_ACTIVATION', 'CAMPAIGN')!;
const draft: IntakeContent = {
  opportunityId: null,
  title: 'Brand campaign',
  relationshipRoles: ['BRAND_CLIENT', 'MEDIA_BUYER'],
  answers: {},
  sourceNotes: '',
  decisionMakerPartyId: null,
  unresolvedIssues: '',
  nextActionOwnerUserId: null,
  nextStep: '',
  dueDate: '',
  checkpoint: '',
};
test('all three engagement families have versioned templates and distinct buyer/publisher requirements', () => {
  assert.equal(new Set(INTAKE_TEMPLATES.map((t) => t.key)).size, 3);
  for (const t of INTAKE_TEMPLATES) assert.ok(readIntakeTemplate(JSON.parse(JSON.stringify(t))));
  assert.notDeepEqual(
    intakeTemplate('PERFORMANCE_MEDIA', 'PAY_PER_CALL_BUYER')!.fields,
    intakeTemplate('PERFORMANCE_MEDIA', 'LEAD_GENERATION_PUBLISHER')!.fields,
  );
  assert.equal(
    readIntakeTemplate({
      ...template,
      fields: [{ label: 'Broken field', required: true, section: 'Test' }],
    }),
    null,
  );
});
test('drafts preserve unknowns; submission and qualification require answers and closing commitments', () => {
  assert.deepEqual(validateIntakeContent(template, draft, 'DRAFT'), []);
  assert.ok(validateIntakeContent(template, draft, 'SUBMITTED').length > 1);
  const ready = {
    ...draft,
    answers: Object.fromEntries(template.fields.map((f) => [f.id, 'Discussed and documented'])),
    decisionMakerPartyId: 'person',
    nextActionOwnerUserId: 'owner',
    unresolvedIssues: 'None',
    nextStep: 'Review brief',
    dueDate: '2026-11-24',
    checkpoint: 'Decision on November 24',
  };
  assert.deepEqual(validateIntakeContent(template, ready, 'SUBMITTED'), []);
  assert.deepEqual(validateIntakeContent(template, ready, 'QUALIFIED'), []);
  assert.ok(
    validateIntakeContent(template, { ...ready, dueDate: '2026-02-30' }, 'QUALIFIED').length,
  );
  assert.ok(
    validateIntakeContent(
      template,
      { ...ready, answers: { ...ready.answers, invented: 'Field' } },
      'DRAFT',
    ).length,
  );
  assert.ok(!INTAKE_TRANSITIONS.DRAFT.includes('QUALIFIED'));
  assert.deepEqual(INTAKE_TRANSITIONS.QUALIFIED, ['NEEDS_CLARIFICATION']);
});
