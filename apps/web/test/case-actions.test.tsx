// The governed Case actions, tested on the properties that make them safe.
//
// WHAT THESE PROVE
//
// EVERY WRITE REUSES A MUTATION THAT ALREADY EXISTED. Not one new write path, no
// generic updateCase, and no Prisma query in the actions file at all. The
// authority stays with the service that owns each fact.
//
// AUTHORITY IS NEVER TAKEN FROM THE REQUEST. The organization comes from the
// signed session, the actor comes from the session, and a Case id in a form is
// an identifier rather than a grant.
//
// PERMISSION IS CHECKED SERVER-SIDE, EVERY TIME. Hiding a control is not access
// control, and these actions are reachable by anybody who can POST to them.
//
// THE THINGS A HUMAN MUST NOT BE ABLE TO DO. Rewrite a Finding's words. Overwrite
// Loop's sequence. Turn participation into work. Close a Case without saying
// what happened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  FORBIDDEN_RECOMMENDATION_VERBS,
  OPERATIONAL_OUTCOMES,
  RECOMMENDATION_VERBS,
  isOperationalOutcome,
  isRecommendationVerb,
} from '@emgloop/shared';

import {
  AddParticipantControl,
  FindingControls,
  EvidenceContextControl,
  ReportEvidenceControl,
  LifecycleControls,
  MonitoringControls,
  RecommendationControls,
  ReleaseParticipantControl,
} from '../src/app/app/admin/cases/case-controls';

const ACTIONS = readFileSync(
  new URL('../src/app/app/admin/cases/actions.ts', import.meta.url),
  'utf8',
);
const CODE = ACTIONS.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const PAGE = readFileSync(
  new URL('../src/app/app/admin/cases/[id]/page.tsx', import.meta.url),
  'utf8',
);

const render = (el: unknown) => renderToStaticMarkup(el as never);
const strip = (s: string) =>
  s.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"')
   .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const ACTION_NAMES = [
  'selectRecommendationAction',
  'dismissRecommendationAction',
  'reviseSequenceAction',
  'judgeFindingAction',
  'addParticipantAction',
  'releaseParticipantAction',
  'reviseMonitoringAction',
  'closeCaseAction',
  'reopenCaseAction',
];

// --- 1. Permission, tenancy, actor -------------------------------------------------------

test('1. every action checks the authoring permission server-side', () => {
  // Reachable by anybody who can POST. The control being hidden proves nothing.
  const guards = CODE.match(/requirePermission\(/g) ?? [];
  assert.ok(guards.length >= 1, 'the shared guard exists');
  assert.ok(
    CODE.includes("requirePermission('commercialIntelligence', 'update')"),
    'and it is the authoring grant, not the read one',
  );
  // Every exported action routes through it.
  for (const name of ACTION_NAMES) {
    const body = CODE.slice(CODE.indexOf('export async function ' + name));
    const end = body.indexOf('\nexport async function ');
    assert.ok(
      (end === -1 ? body : body.slice(0, end)).includes('actorFor()'),
      `${name} resolves its actor through the guard`,
    );
  }
});

test('1b. the organization is never read from the request', () => {
  // A field named organizationId would be the vulnerability the multi-tenant
  // rules exist to prevent.
  assert.equal(/formData\.get\(\s*['"]organizationId/.test(CODE), false);
  assert.equal(/searchParams|params\.organizationId/.test(CODE), false);
  assert.ok(CODE.includes('session.organizationId'), 'it comes from the signed session');
  // And every service call passes it first.
  const calls = CODE.match(/\.(select|dismiss|revise|accept|reject|add|release|start|resolve|ignore|reopen)\(\s*\n?\s*session\.organizationId/g) ?? [];
  assert.ok(calls.length >= 8, `every mutation is organization-scoped (found ${calls.length})`);
});

test('1c. the actor is the session user, never a form field', () => {
  // An action that could name its own actor would make every attributed row on
  // the Case log worthless.
  assert.equal(/formData\.get\(\s*['"](actorUserId|userId['"]\s*\)\s*as\s*actor)/.test(CODE), false);
  assert.ok(CODE.includes('userId: session.userId'), 'the actor is the session');
  assert.ok(CODE.includes("type: 'HUMAN' as const"), 'and a human click is never SYSTEM history');
  assert.equal(/type:\s*['"]SYSTEM['"]/.test(CODE), false, 'no action writes SYSTEM history');
});

test('1d. a cross-tenant id fails closed and reveals nothing', () => {
  // Every service resolves within the organization and returns not-found. The
  // messages are deliberately identical to a deleted row's.
  for (const msg of [
    'That option is no longer available.',
    'That claim is no longer available to judge.',
    'That person or investigation is no longer available.',
    'That investigation is no longer available.',
  ]) {
    assert.ok(ACTIONS.includes(msg), `not-found message: ${msg}`);
  }
  // Nothing the USER SEES says "forbidden", "not yours" or names another tenant.
  // Scanned over the messages IN THE CODE, comments stripped first: the header
  // and several inline notes explain at length that cross-org is not-found and
  // never forbidden, and forbidding the word would forbid the explanation.
  const messages = CODE.match(/backTo\([^)]*'([^']+)'/g) ?? [];
  for (const leak of ['forbidden', 'not yours', 'another organization', 'permission denied']) {
    assert.equal(
      messages.join(' ').toLowerCase().includes(leak),
      false,
      `no user-facing message may say "${leak}"`,
    );
  }
  assert.ok(messages.length >= 10, 'the messages were actually found');
});

// --- 2. No parallel write authority ---------------------------------------------------------

test('2. no generic mutation exists, under any name', () => {
  assert.equal(/updateCase|saveCase|editCase|patchCase|setCaseState|setStatus/.test(CODE), false);
});

test('2b. the actions file builds no query of its own', () => {
  for (const forbidden of ['prisma.', '$transaction', 'findFirst', 'findMany', 'updateMany', 'create(']) {
    assert.equal(CODE.includes(forbidden), false, `must not contain ${forbidden}`);
  }
});

test('2c. each capability calls the service that owns that fact', () => {
  const owners: [string, string][] = [
    ['selectRecommendationAction', 'CaseRecommendationService'],
    ['dismissRecommendationAction', 'CaseRecommendationService'],
    ['reviseSequenceAction', 'CaseRecommendationService'],
    ['judgeFindingAction', 'CaseFindingService'],
    ['addParticipantAction', 'CaseParticipationService'],
    ['releaseParticipantAction', 'CaseParticipationService'],
    ['reviseMonitoringAction', 'CaseMonitoringService'],
    ['closeCaseAction', 'createDecisionEngine'],
    ['reopenCaseAction', 'createDecisionEngine'],
  ];
  for (const [action, owner] of owners) {
    const body = CODE.slice(CODE.indexOf('export async function ' + action));
    const end = body.indexOf('\nexport async function ');
    assert.ok(
      (end === -1 ? body : body.slice(0, end)).includes(owner),
      `${action} goes through ${owner}`,
    );
  }
});

// --- 3. A Finding cannot be rewritten -------------------------------------------------------

test('3. nothing lets a person edit what a Finding says', () => {
  // A claim changes through evidence and supersession, not because somebody
  // disagrees. There is no field for the claim text anywhere.
  for (const field of ['claim', 'conclusion']) {
    assert.equal(
      new RegExp(`formData[^)]*['"]${field}['"]`).test(CODE),
      false,
      `no action reads a "${field}" field for a Finding`,
    );
  }
  // The only Finding mutation is a verdict, and it is one of exactly two values.
  const body = CODE.slice(CODE.indexOf('export async function judgeFindingAction'));
  assert.ok(body.includes("verdict !== 'ACCEPT' && verdict !== 'REJECT'"), 'two values, no default');
  assert.ok(body.includes('findings.accept(') && body.includes('findings.reject('));
});

test('3b. the control says a judgement is neither an edit nor evidence', () => {
  const out = strip(render(<FindingControls caseId="c1" findingId="f1" judgment={null} />));
  assert.ok(out.includes('does not change what the claim says'));
  assert.ok(out.includes('when the evidence does, or when a newer one supersedes it'));
  // The distinction that must never collapse, in both directions.
  assert.ok(out.includes('Accepting does not make it established'));
  assert.ok(out.includes('rejecting does not weaken it'));
  assert.ok(out.includes('still depends on the evidence'));
});

test('3c. a rejected Finding offers no further verdict, and is still the current claim', () => {
  const out = strip(render(<FindingControls caseId="c1" findingId="f1" judgment="REJECTED" />));
  assert.ok(out.includes('still the claim on this investigation'));
  assert.ok(out.includes('Loop keeps evaluating the evidence behind it'));
  assert.equal(out.includes('I accept this claim'), false);
  // AND IT IS NOT CALLED HISTORY. A rejected claim is not a superseded one.
  assert.equal(out.includes('stays here as history'), false);
});

test('3d. the judgement action is scoped to the Case, not just the organization', () => {
  // A finding id from another Case in the same tenant must not be judgeable from
  // this Case's form. The action passes the Case through, and the service
  // resolves the claim within it.
  const body = CODE.slice(CODE.indexOf('export async function judgeFindingAction'));
  assert.ok(/findings\.accept\(\s*session\.organizationId,\s*caseId,/.test(body));
  assert.ok(/findings\.reject\(\s*session\.organizationId,\s*caseId,/.test(body));
});

// --- 4. The machine sequence survives ---------------------------------------------------------

test('4. a revision is a new record, never an edit of the original', () => {
  // The service writes a NEW decision with author HUMAN and derivedFromDecisionId.
  // The action passes a replacement list and nothing else.
  const body = CODE.slice(CODE.indexOf('export async function reviseSequenceAction'));
  assert.ok(body.includes('.revise('), 'the governed mutation');
  assert.equal(/\.update\(|overwrite|replaceOption/.test(body), false, 'nothing overwrites');
});

test('4b. the revision form starts from the machine sequence and says it is kept', () => {
  const raw = render(
    <RecommendationControls
      caseId="c1"
      optionKey="protect-revenue"
      actions={[
        { position: 1, verb: 'Review', statement: 'Review the settlement feed.', intent: null },
        { position: 2, verb: 'Evaluate', statement: 'Evaluate the backup buyer.', intent: null },
      ]}
      selected={false}
      dismissed={false}
    />,
  );
  // THE MACHINE'S WORDING IS THE STARTING POINT, carried in the input values —
  // which live in attributes, so this reads the markup rather than the text.
  assert.ok(raw.includes('value="the settlement feed."'), "Loop's step 1 wording");
  assert.ok(raw.includes('value="the backup buyer."'), "Loop's step 2 wording");
  // And each keeps its own verb selected.
  assert.ok(raw.includes('name="step.0.verb"') && raw.includes('name="step.1.verb"'));
  assert.ok(strip(raw).includes("Loop's original stays recorded either way"));
});

test('4c. the form cannot submit a verb the contract refuses', () => {
  const out = render(
    <RecommendationControls
      caseId="c1"
      optionKey="k"
      actions={[{ position: 1, verb: 'Review', statement: 'Review it.', intent: null }]}
      selected={false}
      dismissed={false}
    />,
  );
  // Verbs come from a select over the shipped vocabulary.
  for (const v of RECOMMENDATION_VERBS) {
    assert.ok(out.includes('value="' + v + '"'), `${v} is offered`);
  }
  // And the ones that assert an outcome Loop cannot support are not there.
  for (const v of FORBIDDEN_RECOMMENDATION_VERBS) {
    assert.equal(out.includes('value="' + v + '"'), false, `${v} must not be offered`);
  }
  // The action re-checks anyway, because a form is not a guard.
  assert.ok(CODE.includes('isRecommendationVerb('));
});

test('4d. fields are indexed so removing a step removes the right one', () => {
  // An unchecked checkbox submits nothing. Parallel getAll arrays would
  // misalign, and a person would drop one step and watch a different one vanish.
  const out = render(
    <RecommendationControls
      caseId="c1"
      optionKey="k"
      actions={[
        { position: 1, verb: 'Review', statement: 'Review one.', intent: null },
        { position: 2, verb: 'Check', statement: 'Check two.', intent: null },
      ]}
      selected={false}
      dismissed={false}
    />,
  );
  assert.ok(out.includes('name="step.0.keep"') && out.includes('name="step.1.keep"'));
  assert.ok(out.includes('name="step.0.verb"') && out.includes('name="step.1.rest"'));
  assert.ok(out.includes('name="stepCount" value="2"'), 'the count bounds the read');
  assert.ok(CODE.includes("'step.' + i + '.keep'"), 'and the action reads them by index');
});

test('4e. an empty revision is refused rather than treated as a deletion', () => {
  assert.ok(CODE.includes('revised.length === 0'));
  assert.ok(ACTIONS.includes('To drop the option, set it aside'));
});

test('4f. selecting does not claim anything happened outside Loop', () => {
  assert.ok(ACTIONS.includes('Nothing has happened outside Loop'));
  const out = strip(render(
    <RecommendationControls caseId="c1" optionKey="k" actions={[]} selected={false} dismissed={false} />,
  ));
  assert.ok(out.includes('Pursue this'), 'the label says what the act is');
});

// --- 5. Participation is not work ----------------------------------------------------------------

test('5. asking somebody creates nothing executable', () => {
  const body = CODE.slice(CODE.indexOf('export async function addParticipantAction'));
  const end = body.indexOf('\nexport async function ');
  const scoped = end === -1 ? body : body.slice(0, end);
  for (const work of ['WorkRepository', 'workInstance', 'createWorkItem', 'assign', 'WorkExecution']) {
    assert.equal(scoped.includes(work), false, `participation must not touch ${work}`);
  }
});

test('5b. the form says asking is not assigning, and requires the reason', () => {
  const out = render(
    <AddParticipantControl caseId="c1" members={[{ id: 'u1', name: 'Matt', email: 'm@x' }]} />,
  );
  const text = strip(out);
  assert.ok(text.includes('not assigning them work'));
  assert.ok(text.includes('Nothing is created anywhere else'));
  // A participant with no stated reason is a name on a list.
  assert.ok(out.includes('name="request"') && out.includes('required'));
  assert.ok(CODE.includes("if (!request) redirect"), 'and the action enforces it too');
});

test('5c. releasing keeps what they were asked for', () => {
  assert.ok(ACTIONS.includes('What they were asked for is kept.'));
  const out = render(<ReleaseParticipantControl caseId="c1" userId="u1" contribution="DECIDE" />);
  assert.ok(out.includes('<button'), 'a real button');
  assert.ok(out.includes('name="contribution"'), 'and it names which ask it releases');
});

// --- 6. Monitoring uncertainty ---------------------------------------------------------------------

test('6. a plan is declared before the answer, and Loop proposes none of it', () => {
  const out = render(<MonitoringControls caseId="c1" existing={null} />);
  const text = strip(out);
  assert.ok(text.includes('before the answer is known'));
  // No suggested threshold and no default baseline: a proposed criterion would
  // be Loop marking its own homework.
  assert.equal(/name="successThreshold"[^>]*defaultValue="[^"]+"/.test(out), false);
  assert.ok(out.includes('placeholder="leave blank if unknown"'), 'the baseline may be absent');
});

test('6b. a correction is an append, and every earlier version is kept', () => {
  const out = strip(render(
    <MonitoringControls
      caseId="c1"
      existing={{
        condition: 'Buyer settlement',
        metric: 'MONETIZED_RATE',
        successThreshold: 0.55,
        failureThreshold: 0.35,
        observationStart: '2026-08-25T04:00:00.000Z',
        observationEnd: '2026-09-01T04:00:00.000Z',
      }}
    />,
  ));
  assert.ok(out.includes('Correct the monitoring plan'));
  assert.ok(out.includes('Every earlier version is kept in full'));
  assert.ok(out.includes('what you originally said would count stays readable'));
});

test('6c. the sufficiency gate is part of the form, not an afterthought', () => {
  const out = render(<MonitoringControls caseId="c1" existing={null} />);
  assert.ok(out.includes('name="minimumObservations"'));
  assert.ok(out.includes('name="minimumCoverage"'));
  assert.ok(out.includes('name="requiresCompleteWindow"'));
  // Coverage may be left blank, and blank means "not required" rather than zero.
  assert.ok(out.includes('placeholder="blank = not required"'));
});

test('6d. the action validates the window rather than accepting anything', () => {
  assert.ok(CODE.includes('Number.isNaN(Date.parse(start))'));
  assert.ok(CODE.includes('Date.parse(end) <= Date.parse(start)'));
  assert.ok(ACTIONS.includes('The window has to end after it starts.'));
});

// --- 7. Lifecycle ---------------------------------------------------------------------------------

test('7. closing requires what happened, not just that it was closed', () => {
  assert.ok(CODE.includes('isOperationalOutcome(outcome)'));
  assert.ok(ACTIONS.includes('Say what actually happened before closing this.'));
  assert.ok(ACTIONS.includes('Say why you are closing this.'));
  // Both are required with no default: the outcome is the whole content.
  assert.equal(/outcome\s*=\s*outcome\s*\|\|\s*['"]/.test(CODE), false, 'no defaulted outcome');
});

test('7b. acted and did-not-act are different closes', () => {
  // "Closed" alone says what the operator did and nothing about what was true,
  // and the false-positive rate depends on the distinction.
  assert.ok(CODE.includes('engine.resolve('));
  assert.ok(CODE.includes('engine.ignore('));
  const out = strip(render(<LifecycleControls caseId="c1" open reopenCount={0} />));
  assert.ok(out.includes('Yes — we acted'));
  assert.ok(out.includes('No — it did not need action'));
  // And every governed outcome is offered.
  const raw = render(<LifecycleControls caseId="c1" open reopenCount={0} />);
  for (const o of OPERATIONAL_OUTCOMES) {
    assert.ok(raw.includes('value="' + o + '"'), `${o} is offered`);
  }
});

test('7c. reopening keeps the earlier resolution, and says so', () => {
  const out = strip(render(<LifecycleControls caseId="c1" open={false} reopenCount={2} />));
  assert.ok(out.includes('reopened 2 times'));
  assert.ok(out.includes('Every close and every reopen is on the log'));
  assert.ok(out.includes('The earlier resolution stays on the log'));
  assert.ok(ACTIONS.includes('The earlier resolution is kept on the log.'));
  // A closed Case offers reopen, not close.
  assert.equal(out.includes('Close this investigation'), false);
});

test('7d. a second press is a real answer, not a duplicate close', () => {
  assert.ok(ACTIONS.includes('already closed'));
  assert.ok(ACTIONS.includes('already open'));
  // A redirect throws; catching it as a failure would break the happy path.
  assert.ok(CODE.includes('rethrowRedirect(e)'));
});

// --- 8. The page gates every control ---------------------------------------------------------------

test('8. a read-only member is offered nothing to press', () => {
  assert.ok(PAGE.includes("hasPermission('commercialIntelligence', 'update')"));
  assert.ok(PAGE.includes('canAct ?'), 'controls are conditional');
  // And the absence is explained rather than silent.
  assert.ok(PAGE.includes('needs permission to author'));
});

// --- 8a. Reporting: the one Case act a participant may do -------------------------------------

/** Just the reporting action's body -- the file's later actions use `actorFor`. */
function reportBody(): string {
  const from = CODE.indexOf('export async function reportEvidenceAction');
  const next = CODE.indexOf('export async function ', from + 10);
  return CODE.slice(from, next === -1 ? undefined : next);
}

test('8a. reporting is guarded by the READ grant, and the service decides the rest', () => {
  // THE ONE CASE ACTION THAT IS NOT `actorFor`. Somebody asked to contribute to
  // an investigation can answer it without organization-wide authoring
  // authority, so the action establishes a session and defers the decision to
  // CaseEvidenceService -- which resolves organization -> Case -> participation
  // against the database on every submission.
  const body = reportBody();
  assert.ok(body.includes("requirePermission('commercialIntelligence', 'view')"));
  assert.equal(body.includes('actorFor()'), false, 'it does not require the authoring grant');
  assert.ok(/new CaseEvidenceService\(prisma\)\.report\(\s*session\.organizationId,\s*caseId,/.test(body));
});

test('8a2. the reporter comes from the session, and no form field can name one', () => {
  const body = reportBody();
  assert.ok(/reportedByUserId:\s*session\.userId/.test(body));
  // No form field is read for the reporter, anywhere in the action or the form.
  assert.equal(/formData\.get\(['\`"]reportedBy/.test(CODE), false);
  const control = strip(render(<ReportEvidenceControl caseId="c1" />));
  assert.equal(/name="reportedBy/.test(render(<ReportEvidenceControl caseId="c1" />)), false);
  assert.ok(control.includes('attributed to you'));
});

test('8a3. the statement is read verbatim, not trimmed like an id', () => {
  // `text()` trims, which is right for an id and wrong for a person's words: the
  // statement IS the evidence, and tidying it edits the record.
  const body = reportBody();
  assert.ok(/verbatim\(formData, 'statement'\)/.test(body));
  assert.equal(/text\(formData, 'statement'\)/.test(CODE), false);
  // AND THE ONLY 'statement' FIELD IN THE FILE IS THIS ONE. A Finding's words are
  // still not editable from a form -- a report is evidence, not a claim being
  // rewritten.
  const statementReads = CODE.match(/formData, 'statement'/g) ?? [];
  assert.equal(statementReads.length, 1);
});

test('8a4. the report form offers no confidence, and no verification checkbox', () => {
  const html = render(<ReportEvidenceControl caseId="c1" />);
  const out = strip(html);
  for (const forbidden of ['confidence', 'verified', 'verify', '%', 'certain', 'probability']) {
    assert.equal(out.toLowerCase().includes(forbidden), false, `must not offer "${forbidden}"`);
  }
  assert.equal(/type="checkbox"/.test(html), false);
  // And it says what recording actually establishes.
  assert.ok(out.includes('you reported it'));
  assert.ok(out.includes('not that it is true'));
});

test('8a5. recording context is guarded like reporting, and scoped to the Case', () => {
  const from = CODE.indexOf('export async function addEvidenceContextAction');
  const next = CODE.indexOf('export async function ', from + 10);
  const body = CODE.slice(from, next === -1 ? undefined : next);
  assert.ok(body.includes("requirePermission('commercialIntelligence', 'view')"));
  assert.equal(body.includes('actorFor()'), false);
  assert.ok(/addContext\(\s*session\.organizationId,\s*caseId,/.test(body));
  assert.ok(/actorUserId:\s*session\.userId/.test(body), 'the actor is the session');
  // The relation is checked against the governed vocabulary before anything is
  // attempted, so an invented one never reaches the service.
  assert.ok(body.includes('isEvidenceRelation(relation)'));
  // The basis statement is evidence too, so it is read verbatim.
  assert.ok(/verbatim\(formData, 'basisStatement'\)/.test(body));
});

test('8a6. the context form says it cannot edit the evidence', () => {
  const out = strip(render(<EvidenceContextControl caseId="c1" evidenceId="ev_1" />));
  assert.ok(out.includes('does not change the evidence above'));
  // It offers exactly the governed relations and nothing else.
  assert.ok(out.includes('Corroborated by'));
  assert.ok(out.includes('No longer applicable'));
  assert.equal(out.includes('Superseded'), false, 'the member that lives elsewhere is not offered');
  // And no verification or confidence, here either.
  for (const forbidden of ['confidence', 'verified', '%', 'certain']) {
    assert.equal(out.toLowerCase().includes(forbidden), false, forbidden);
  }
});

test('8b. the page passes controls in; sections never build their own', () => {
  const sections = readFileSync(
    new URL('../src/app/app/admin/cases/case-sections.tsx', import.meta.url),
    'utf8',
  );
  // A section that built a form could offer authority the page never checked.
  assert.equal(sections.includes('action={'), false, 'sections post nothing');
  assert.equal(/from '\.\/actions'/.test(sections), false, 'and import no action');
  assert.ok(sections.includes('controls?:'), 'they take a slot instead');
});

test('8c. no external action and no model, in any of it', () => {
  for (const src of [CODE, PAGE, readFileSync(new URL('../src/app/app/admin/cases/case-controls.tsx', import.meta.url), 'utf8')]) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    for (const forbidden of [/\bfetch\s*\(/, /nodemailer/, /\bresend\b/i, /sendMail/, /\banthropic\b/i, /\bopenai\b/i]) {
      assert.equal(forbidden.test(code), false, `must not contain ${forbidden}`);
    }
  }
});

// --- 9. The guards the actions rely on ---------------------------------------------------------------

test('9. the vocabulary guards are real, and reject invented members', () => {
  assert.equal(isOperationalOutcome('RECOVERED'), true);
  assert.equal(isOperationalOutcome('DEFINITELY_FINE'), false);
  assert.equal(isRecommendationVerb('Review'), true);
  // The verbs that assert an outcome Loop cannot support.
  for (const v of FORBIDDEN_RECOMMENDATION_VERBS) {
    assert.equal(isRecommendationVerb(v), false, `${v} is refused`);
  }
});
