import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { intakeTemplate, type IntakeContent } from '@emgloop/shared';
import { matrixAllows } from '@emgloop/database';
import { IntakeContentView } from '../src/intake/intake-content-view';
import { LOOP_NAV } from '../src/workspaces/config';
test('intake navigation and qualification authority are explicit and exclude creator and machine seats', () => {
  assert.ok(
    LOOP_NAV.nav
      .flatMap((g) => g.items)
      .some((i) => i.href === '/app/crm/intakes' && i.requires?.resource === 'intakes'),
  );
  for (const role of ['OWNER', 'ADMIN', 'MANAGER'])
    assert.equal(matrixAllows(role, 'intakes', 'approve'), true);
  assert.equal(matrixAllows('EMPLOYEE', 'intakes', 'create'), true);
  assert.equal(matrixAllows('EMPLOYEE', 'intakes', 'approve'), false);
  for (const role of ['CREATOR', 'AI_EMPLOYEE', 'unknown'])
    for (const action of ['view', 'create', 'update', 'approve'] as const)
      assert.equal(matrixAllows(role, 'intakes', action), false);
});
test('saved intake questions and closing details render as recorded', () => {
  const template = {
    ...intakeTemplate('CREATOR_ACTIVATION', 'CAMPAIGN')!,
    version: 7,
    fields: [
      {
        id: 'old_question',
        label: 'Original question',
        section: 'Original section',
        required: true,
      },
    ],
  };
  const content: IntakeContent = {
    opportunityId: null,
    title: 'Campaign',
    relationshipRoles: ['BRAND_CLIENT'],
    answers: { old_question: 'Original answer' },
    sourceNotes: 'Meeting notes',
    decisionMakerPartyId: 'person',
    nextActionOwnerUserId: 'user',
    unresolvedIssues: 'Usage duration',
    nextStep: 'Confirm rights',
    dueDate: '2026-11-24',
    checkpoint: 'Tuesday review',
  };
  const html = renderToStaticMarkup(
    <IntakeContentView
      template={template}
      content={content}
      names={[{ id: 'person', displayName: 'Decision maker' }]}
      owners={[{ id: 'user', name: 'Action owner' }]}
    />,
  );
  for (const text of [
    'Original question',
    'Original answer',
    'Usage duration',
    'Confirm rights',
    'Tuesday review',
    'Decision maker',
    'Action owner',
  ])
    assert.ok(html.includes(text));
});
