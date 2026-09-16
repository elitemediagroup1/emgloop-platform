// The Case Explanation surface. Slice AI-5.
//
// WHAT THESE PROVE
//
// THE ACTION IS GUARDED ITSELF, and takes nothing but a Case id from the browser: the
// organization and the person come from the signed session, and the service
// re-decides the invoker, activation, kill switches and budget.
//
// THE BROWSER RECEIVES THE VALIDATED ANSWER OR A REASON -- never a prompt, a provider's
// words, provenance beyond ids and versions, or part of a rejected answer.
//
// OFF IS SAID, NOT HIDDEN. Each unavailable state has its own words, and the panel
// labels what it is: model-written, evidence-cited, not a finding or a decision.
//
// NOTHING ON THE CASE SURFACE NAMES A PROVIDER OR A MODEL, and the page never calls a
// model to decide what to show.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { ExplanationPanel } from '../src/app/app/admin/cases/explanation-panel';
import { explanationViewOf } from '../src/app/app/admin/cases/explanation-view';

const CASES = join(__dirname, '..', 'src', 'app', 'app', 'admin', 'cases');
const code = (file: string) =>
  readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ANSWERED = {
  outcome: 'ANSWERED',
  explanation: {
    summary: 'Revenue for one buyer fell.',
    claims: [
      { kind: 'OBSERVATION' as const, statement: 'Revenue moved by -42000 cents.', citations: ['decision-evidence:ev_1'], figures: [{ label: 'x', value: -42000 }] },
      { kind: 'SIGNIFICANCE' as const, statement: 'The finding is still developing.', citations: ['finding:fnd_1'], figures: [] },
      { kind: 'CONSIDERATION' as const, statement: 'It may be worth checking a second week.', citations: ['case:case_1'], figures: [] },
    ],
    limitations: ['Notes written by people were not supplied.'],
  },
  provenance: {
    invocationId: 'inv_1',
    taskVersion: '2.0.0',
    templateVersion: '2',
    routingPolicyVersion: 'routing.2026-09-16.2',
    requestedModel: { providerId: 'p', modelId: 'model-a' },
    servedModel: 'model-a',
    calls: 1,
    recordedAt: '2026-09-16T15:00:00.000Z',
  },
  manifest: [{ sourceRef: 'decision-evidence:ev_1' }],
  withheld: { HUMAN_REPORTED_EVIDENCE: 2, ENTITY_NAMES: 1, RECOMMENDATIONS: 0 },
  entityAliases: { 'buyer #1': { entityType: 'buyer', entityName: 'Acme Home Services' } },
};

describe('what reaches the browser', () => {
  it('an answer: the validated sections, ids and versions, withheld counts and the label key -- and nothing else', () => {
    const view = explanationViewOf(ANSWERED);
    assert.equal(view.state, 'ANSWERED');
    if (view.state !== 'ANSWERED') return;
    assert.deepEqual(Object.keys(view).sort(), ['aliases', 'claims', 'generatedAt', 'limitations', 'model', 'state', 'summary', 'versions', 'withheld']);
    assert.deepEqual(Object.keys(view.claims[0]!).sort(), ['citations', 'kind', 'statement'], 'figures are validation input, not display');
    assert.deepEqual(view.withheld, ['2 evidence people reported', '1 names of companies and people (shown as labels)']);
    assert.deepEqual(view.aliases, [{ alias: 'buyer #1', name: 'Acme Home Services' }]);
    assert.doesNotMatch(JSON.stringify(view), /inv_1|manifest|providerId/);
  });

  it('every other outcome is a reason, with no part of an answer', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ outcome: 'NOT_AUTHORIZED' }, /owners and admins/],
      [{ outcome: 'NOT_FOUND' }, /could not be found/],
      [{ outcome: 'REFUSED_BY_LOOP', refusals: ['NOT_ACTIVATED', 'ORGANIZATION_NOT_ENABLED'] }, /not enabled/],
      [{ outcome: 'REFUSED_BY_LOOP', refusals: ['KILL_SWITCH'] }, /paused/],
      [{ outcome: 'REFUSED_BY_LOOP', refusals: ['BUDGET_ORGANIZATION_EXHAUSTED'] }, /allowance/],
      [{ outcome: 'REFUSED_BY_LOOP', refusals: ['SOMETHING_NEW'] }, /did not send/],
      [{ outcome: 'REJECTED_OUTPUT', rejections: ['CITATION_NOT_SUPPLIED'], explanation: ANSWERED.explanation }, /evidence rules, so none of it is shown/],
      [{ outcome: 'REFUSED_BY_MODEL' }, /declined/],
      [{ outcome: 'FAILED', failure: 'UNAVAILABLE' }, /could not be produced/],
    ];
    for (const [result, reason] of cases) {
      const view = explanationViewOf(result as never);
      assert.equal(view.state, 'NOT_SHOWN', JSON.stringify(result));
      if (view.state === 'NOT_SHOWN') assert.match(view.reason, reason);
      assert.doesNotMatch(JSON.stringify(view), /Revenue|developing|second week/, 'no part of a rejected answer');
    }
  });
});

describe('the panel', () => {
  it('says which unavailable state applies, and offers no button', () => {
    const expected: Record<string, RegExp> = {
      NOT_AUTHORIZED: /owners and admins/,
      NOT_ENABLED: /not enabled/,
      PAUSED: /paused/,
      NOT_CONFIGURED: /no provider is configured/,
    };
    for (const [availability, text] of Object.entries(expected)) {
      const html = renderToStaticMarkup(<ExplanationPanel caseId="case_1" availability={availability as never} />);
      assert.match(html, text, availability);
      assert.doesNotMatch(html, /<button/, `${availability} offers nothing to press`);
    }
  });

  it('when available, offers the request and says what is and is not sent', () => {
    const html = renderToStaticMarkup(<ExplanationPanel caseId="case_1" availability="AVAILABLE" />);
    assert.match(html, /<button[^>]*type="button"[^>]*>Explain this investigation<\/button>/);
    assert.match(html, /Notes, names, contact details and who is involved are not sent/);
  });

  it('labels itself for what it is', () => {
    const html = renderToStaticMarkup(<ExplanationPanel caseId="case_1" availability="AVAILABLE" />);
    assert.match(html, /Written by an AI model/);
    assert.match(html, /Every statement cites what it rests on/);
    assert.match(html, /not a finding, a decision or a recommendation, and it changes nothing/);
    assert.doesNotMatch(html, /\d+\s?%/, 'no confidence number anywhere');
  });
});

describe('fences', () => {
  it('the action guards itself before anything, and takes only a Case id from the browser', () => {
    const src = code(join(CASES, 'explanation-actions.ts'));
    assert.match(src, /^'use server';/m);
    const guard = src.indexOf("await requireWorkspace('ADMIN')");
    const permission = src.indexOf("await requirePermission('commercialIntelligence', 'view')");
    const call = src.indexOf('await explainCase(');
    assert.ok(guard > -1 && permission > guard && call > permission, 'workspace, then permission, then the request');
    assert.match(src, /organizationId: session\.organizationId, userId: session\.userId/);
    assert.doesNotMatch(src, /formData|FormData/, 'no form fields: nothing else comes from the browser');
    assert.equal((src.match(/export async function/g) ?? []).length, 1);
  });

  it('nothing on the Case surface names a provider or a model, reads the environment, or calls out', () => {
    for (const file of ['explanation-actions.ts', 'explanation-panel.tsx', 'explanation-view.ts', '[id]/page.tsx']) {
      const src = code(join(CASES, file));
      assert.doesNotMatch(src, /anthropic|openai|claude-|gpt-|process\.env|API_KEY|fetch\(/i, file);
    }
  });

  it('the page asks only whether to offer an explanation; it never requests one', () => {
    const page = code(join(CASES, '[id]', 'page.tsx'));
    assert.match(page, /caseExplanationAvailability\(\{ organizationId: session\.organizationId, userId: session\.userId \}\)/);
    assert.doesNotMatch(page, /explainCase\(|explainCaseAction\(/);
    // Its own guard still comes first.
    assert.ok(page.indexOf("requirePermission('commercialIntelligence', 'view')") < page.indexOf('caseExplanationAvailability('));
  });

  it('the panel is a leaf that reaches the server only through the action', () => {
    const panel = code(join(CASES, 'explanation-panel.tsx'));
    assert.match(panel, /^'use client';/m);
    const imports = [...panel.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ['./explanation-actions', './explanation-view', 'react']);
  });

  it('the runtime assembly is server-only and reads the environment only through its boundary', () => {
    const assembly = code(join(__dirname, '..', 'src', 'ai', 'case-explanation.ts'));
    assert.match(assembly.trimStart(), /^import 'server-only';/);
    assert.doesNotMatch(assembly, /process\.env|API_KEY|LOOP_AI_/);
    assert.match(assembly, /aiEnvironment\(/);
    assert.doesNotMatch(assembly, /'(claude|gpt)-[\w.-]+'/, 'no model id outside the reviewed policy');
  });
});
