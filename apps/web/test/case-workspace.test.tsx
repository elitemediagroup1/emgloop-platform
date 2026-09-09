// The Case Workspace, tested on what it must never say.
//
// WHAT THESE PROVE
//
// DEVELOPING AND ESTABLISHED ARE VISIBLY DIFFERENT, and neither is "accepted".
// A human accepting a claim is a decision; establishment is what the evidence
// currently supports, and it can weaken on its own.
//
// HISTORY IS NEVER REWRITTEN. A superseded finding keeps its own words. A
// human revision appears BESIDE what Loop proposed, never instead of it.
//
// AN EMPTY WHY IS A SUCCESSFUL STATE, and the screen says why it is empty rather
// than rendering a blank that reads as complete.
//
// NOTHING INVENTS A CAUSE, A MANAGER, OR A CONFIDENCE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  CASE_KNOWN,
  CASE_WITH_UNCERTAINTY,
  OUTCOME_RECOVERED_NO_CAUSE,
  OUTCOME_UNESTABLISHED,
  WORK_BLOCKED,
  WORK_ESCALATION_ELIGIBLE,
  WORK_IN_PROGRESS,
  WORK_NOT_MEASURED,
  WORK_REFERENCE_DANGLING,
  type CaseFindingView,
  type CaseParticipationView,
} from '@emgloop/shared';

import {
  FindingSection,
  FiveWs,
  OutcomeSection,
  ParticipationSection,
  RecommendationsSection,
  TimelineSection,
  WorkSection,
} from '../src/app/app/admin/cases/case-sections';

const render = (el: unknown) => renderToStaticMarkup(el as never);
const strip = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

function finding(over: Partial<CaseFindingView> = {}): CaseFindingView {
  return {
    findingId: 'fnd_1',
    caseId: 'case_cem',
    claim: "CEM's settlement rate fell because their qualification criteria tightened.",
    conclusion: null,
    claimKind: 'MEASUREMENT_BACKED',
    state: 'DEVELOPING',
    generatedBy: 'MACHINE',
    establishedBy: null,
    establishedByUserId: null,
    establishedAt: null,
    establishment: {
      ruleVersion: 'case-finding-establishment.v1',
      eligible: false,
      basis: null,
      reasons: ['EVIDENCE_INCOMPLETE'],
      readinessWithholdings: [],
    },
    reasoning: { supports: [], contradicts: [], missing: [], statement: '' } as never,
    supporting: [{ id: 'ev_1' } as never],
    createdAt: '2026-08-23T14:00:00.000Z',
    supportingWindowStart: '2026-08-15T04:00:00.000Z',
    supportingWindowEnd: '2026-08-22T04:00:00.000Z',
    ruleVersion: 'case-finding-establishment.v1',
    lineage: [],
    ...over,
  };
}

// --- 1. Developing vs Established vs Accepted -------------------------------------------

test('1. a developing finding is visibly not an established one', () => {
  const dev = strip(render(<FindingSection finding={finding()} />));
  const est = strip(render(
    <FindingSection
      finding={finding({
        state: 'ESTABLISHED',
        establishedBy: 'DETERMINISTIC_POLICY',
        establishment: { ruleVersion: 'v1', eligible: true, basis: 'DETERMINISTIC_POLICY', reasons: [], readinessWithholdings: [] },
      })}
    />,
  ));
  assert.ok(dev.includes('Developing'));
  assert.ok(est.includes('Established'));
  assert.notEqual(dev, est);
  assert.equal(dev.includes('Established'), false);
});

test('1b. established is never rendered as "accepted"', () => {
  // A human accepting a claim is a decision. Establishment is what the evidence
  // supports. They must never share a word.
  const policy = strip(render(
    <FindingSection
      finding={finding({
        state: 'ESTABLISHED',
        establishedBy: 'DETERMINISTIC_POLICY',
        establishment: { ruleVersion: 'v1', eligible: true, basis: 'DETERMINISTIC_POLICY', reasons: [], readinessWithholdings: [] },
      })}
    />,
  ));
  assert.ok(policy.includes('evidence meets the governed standard on its own'));
  assert.equal(policy.toLowerCase().includes('accepted'), false);

  const human = strip(render(
    <FindingSection
      finding={finding({
        state: 'ESTABLISHED',
        establishedBy: 'HUMAN_ACCEPTANCE',
        establishment: { ruleVersion: 'v1', eligible: true, basis: 'HUMAN_ACCEPTANCE', reasons: [], readinessWithholdings: [] },
      })}
    />,
  ));
  // When a person DID accept it, that is said — and it is a different sentence.
  assert.ok(human.includes('A person accepted this claim'));
  assert.notEqual(policy, human);
});

test('1c. establishment is described as re-derived, never as permanent', () => {
  const out = strip(render(
    <FindingSection
      finding={finding({
        state: 'ESTABLISHED',
        establishedBy: 'DETERMINISTIC_POLICY',
        establishment: { ruleVersion: 'v1', eligible: true, basis: 'DETERMINISTIC_POLICY', reasons: [], readinessWithholdings: [] },
      })}
    />,
  ));
  assert.ok(out.includes('re-derived on every read'), 'a person is told it can weaken');
});

test('1d. a developing finding names what stands between it and establishment', () => {
  const out = strip(render(<FindingSection finding={finding()} />));
  assert.ok(out.includes('What stands between this and being established'));
  assert.ok(out.includes('Part of the evidence population did not report'));
  // The governed reason is still reachable for an operator.
  const raw = render(<FindingSection finding={finding()} />);
  assert.ok(raw.includes('case-finding-establishment.v1'));
});

test('1e. no finding renders a confidence percentage', () => {
  const out = strip(render(<FindingSection finding={finding()} />));
  for (const forbidden of ['confidence', '%', 'likely', 'probability']) {
    assert.equal(out.toLowerCase().includes(forbidden), false, `must not say "${forbidden}"`);
  }
});

test('1f. no finding at all is "still developing", never "no issue found"', () => {
  const out = strip(render(<FindingSection finding={null} />));
  assert.ok(out.includes('still developing a finding'));
  for (const wrong of ['no issue', 'nothing wrong', 'all clear', 'healthy']) {
    assert.equal(out.toLowerCase().includes(wrong), false, `must not say "${wrong}"`);
  }
});

test('1g. a superseded finding keeps its own words', () => {
  const out = strip(render(
    <FindingSection
      finding={finding({
        lineage: [
          {
            findingId: 'fnd_0',
            claim: 'The drop is caused by a single source going dark.',
            conclusion: null,
            state: 'SUPERSEDED',
            generatedBy: 'MACHINE',
            createdAt: '2026-08-21T09:00:00.000Z',
            supersededById: 'fnd_1',
          },
        ],
      })}
    />,
  ));
  // HISTORY IS NEVER VISUALLY REWRITTEN.
  assert.ok(out.includes('a single source going dark'), 'the earlier claim, verbatim');
  assert.ok(out.includes('Superseded'));
  assert.ok(out.includes('Replaced by a later claim'));
  assert.ok(out.includes('2026-08-21'), 'and when it stood');
});

// --- 2. Recommendations ---------------------------------------------------------------------

const option = (over: Record<string, unknown> = {}) => ({
  key: 'relationship-first',
  label: 'Ask CEM First',
  summary: 'Establish whether their qualification changed before moving anything.',
  posture: 'DIAGNOSTIC',
  rank: 1,
  factors: [
    { factor: 'EXPECTED_BENEFIT', level: 'MODERATE', basis: 'It answers the question directly.' },
    { factor: 'RELATIONSHIP_RISK', level: 'LOW', basis: 'Asking is not acting.' },
    { factor: 'TIME_TO_RESULT', level: 'UNKNOWN', basis: null },
  ],
  actions: [
    { position: 1, verb: 'Review', statement: 'Review the settlement feed for the affected days.', intent: 'Establish the shape of the drop.' },
    { position: 2, verb: 'Evaluate', statement: 'Evaluate whether one source accounts for it.', intent: null },
  ],
  decisionId: 'dec_1',
  author: 'MACHINE',
  selectedByUserId: null,
  selectedAt: null,
  dismissed: false,
  revision: null,
  ...over,
});

const recs = (over: Record<string, unknown> = {}) =>
  ({
    caseId: 'case_cem',
    findingId: 'fnd_1',
    setNumber: 1,
    ruleVersion: 'case-recommendation.v1',
    findingStateAtIssue: 'DEVELOPING',
    evidenceStrengthAtIssue: 'MODERATE',
    options: [option()],
    comparisons: [],
    supersededSets: [],
    ...over,
  }) as never;

test('2. options render with their sequence order unmissable', () => {
  const out = render(<RecommendationsSection recommendations={recs()} />);
  const text = strip(out);
  assert.ok(text.includes('Ask CEM First'));
  assert.ok(text.includes('Review the settlement feed'));
  assert.ok(text.includes('Evaluate whether one source'));
  // A numbered ordered list, with the position visible.
  assert.ok(out.includes('<ol class="cw-seq"'), 'the sequence is an ordered list');
  assert.ok(out.includes('cw-seq__n'), 'each step carries its position');
});

test('2b. UNKNOWN is "not assessed", never a middle value', () => {
  const out = strip(render(<RecommendationsSection recommendations={recs()} />));
  assert.ok(out.includes('Not assessed'));
  assert.ok(out.includes('not part of the comparison'));
  // It must not be dressed as a measured level.
  assert.equal(out.includes('Time to result Moderate'), false);
});

test('2c. every assessed factor shows its stated basis', () => {
  // A level with no stated basis is a number wearing a word.
  const out = strip(render(<RecommendationsSection recommendations={recs()} />));
  assert.ok(out.includes('It answers the question directly'));
  assert.ok(out.includes('Asking is not acting'));
});

test('2d. a human revision appears BESIDE the machine version, never instead', () => {
  const out = strip(render(
    <RecommendationsSection
      recommendations={recs({
        options: [
          option({
            revision: {
              actions: [{ position: 1, verb: 'Evaluate', statement: 'Evaluate the backup buyer first.', intent: null }],
            },
          }),
        ],
      })}
    />,
  ));
  assert.ok(out.includes('A person revised this'));
  assert.ok(out.includes('Evaluate the backup buyer first'), 'the revision');
  // AND LOOP'S ORIGINAL IS STILL THERE, in full.
  assert.ok(out.includes('Review the settlement feed'), "the machine's step 1 survives");
  assert.ok(out.includes('Evaluate whether one source'), "and its step 2");
  assert.ok(out.includes("original sequence is kept above, unchanged"));
});

test('2e. the order is explained by factors, never by a score', () => {
  const out = strip(render(
    <RecommendationsSection
      recommendations={recs({
        options: [option(), option({ key: 'protect-revenue', label: 'Move Volume', rank: 2 })],
        comparisons: [
          {
            leftKey: 'relationship-first',
            rightKey: 'protect-revenue',
            favouringLeft: [{ factor: 'RELATIONSHIP_RISK' } as never],
            favouringRight: [],
            incomparable: ['TIME_TO_RESULT'],
          },
        ],
      })}
    />,
  ));
  assert.ok(out.includes('Why they are in this order'));
  assert.ok(out.includes('Relationship risk'), 'in product language');
  // INCOMPARABLE FACTORS ARE FIRST-CLASS. "We did not assess this on either
  // option" is what a person needs before trusting an order.
  assert.ok(out.includes('Not compared, because neither option assessed'));
  assert.ok(out.includes('Time to result'));
  // And no number anywhere.
  assert.equal(/\b\d+(\.\d+)?\s*(points?|score)\b/i.test(out), false);
});

test('2f. no option offers an action the backend refuses', () => {
  // The verb guard lives in the contract; the UI must not add its own verbs.
  const src = readFileSync(new URL('../src/app/app/admin/cases/case-sections.tsx', import.meta.url), 'utf8');
  for (const external of ['Send ', 'Email ', 'Call ', 'Contact ', 'Pause ', 'Shift ']) {
    assert.equal(
      src.includes(`'${external}`) || src.includes(`>${external}`),
      false,
      `must not offer "${external}"`,
    );
  }
});

// --- 3. Participation is not work assignment -------------------------------------------------

const participation = (over: Partial<CaseParticipationView> = {}): CaseParticipationView =>
  ({
    caseId: 'case_cem',
    ownerUserId: 'usr_charlie',
    assigneeUserId: null,
    participants: [
      { id: 'p1', caseId: 'case_cem', userId: 'usr_charlie', contribution: 'DECIDE', request: 'Decide whether to move volume.', addedByUserId: 'usr_charlie', addedAt: '2026-08-23T14:30:00.000Z', releasedAt: null, releasedByUserId: null, active: true, awaited: true },
      { id: 'p2', caseId: 'case_cem', userId: 'usr_mike', contribution: 'RELATIONSHIP', request: 'Ask CEM whether their qualification changed.', addedByUserId: 'usr_charlie', addedAt: '2026-08-23T14:33:00.000Z', releasedAt: null, releasedByUserId: null, active: true, awaited: false },
    ],
    released: [],
    awaiting: [],
    work: [],
    ...over,
  }) as CaseParticipationView;

test('3. multiple participants render with distinct asks', () => {
  const out = strip(render(<ParticipationSection participation={participation()} />));
  assert.ok(out.includes('usr_charlie'));
  assert.ok(out.includes('usr_mike'));
  assert.ok(out.includes('Decide whether to move volume'));
  assert.ok(out.includes('Ask CEM whether their qualification changed'));
  // Two people, two DIFFERENT asks — not one owner.
  assert.equal(out.includes('Case owner'), false);
});

test('3b. participation says in words that it is not work assignment', () => {
  const out = strip(render(<ParticipationSection participation={participation()} />));
  assert.ok(out.includes('Being asked is not being assigned work'));
  assert.ok(out.includes('nothing here creates a task'));
});

test('3c. released people keep what they were asked for', () => {
  const out = strip(render(
    <ParticipationSection
      participation={participation({
        released: [
          { id: 'p3', caseId: 'case_cem', userId: 'usr_matt', contribution: 'INVESTIGATE', request: 'Work out whether the drop is CEM-wide.', addedByUserId: 'usr_charlie', addedAt: '2026-08-23T14:31:00.000Z', releasedAt: '2026-08-25T10:00:00.000Z', releasedByUserId: 'usr_charlie', active: false, awaited: false },
        ],
      })}
    />,
  ));
  assert.ok(out.includes('1 released'));
  assert.ok(out.includes('Work out whether the drop is CEM-wide'), 'the ask is kept');
});

// --- 4. Work is read, never owned ---------------------------------------------------------------

test('4. unmeasured work is never rendered as on track', () => {
  const out = strip(render(<WorkSection coordination={WORK_NOT_MEASURED} />));
  assert.ok(out.includes('Not measured'));
  assert.equal(out.includes('On track'), false);
  assert.ok(out.includes('no execution history'), 'and it says why');
});

test('4b. a blocked item names what is blocking it and the expected resolution', () => {
  const out = strip(render(<WorkSection coordination={WORK_BLOCKED} />));
  assert.ok(out.includes('Blocked'));
  assert.ok(out.includes('Blocked by'));
  assert.ok(out.includes("CEM's next-day settlement sheet"));
  assert.ok(out.includes('Expected 2026-08-25'));
  // The clock is paused, and the accrued time is kept.
  assert.ok(out.includes('Paused'));
});

test('4c. escalation-eligible with no recipient says so rather than hiding it', () => {
  const out = strip(render(<WorkSection coordination={WORK_ESCALATION_ELIGIBLE} />));
  assert.ok(out.includes('Eligible for escalation'));
  assert.ok(out.includes('no reporting relationship is configured'));
  assert.ok(out.includes('A role is a permission level, not a manager'));
  // AND NO MANAGER IS NAMED.
  for (const invented of ['manager', 'supervisor', 'escalate to usr', 'their lead']) {
    const lower = out.toLowerCase();
    if (invented === 'manager') {
      // The word appears only in the sentence explaining there is not one.
      assert.ok(lower.includes('not a manager'));
    } else {
      assert.equal(lower.includes(invented), false, `must not say "${invented}"`);
    }
  }
});

test('4d. a dangling reference is reported, not silently omitted', () => {
  const out = strip(render(<WorkSection coordination={WORK_REFERENCE_DANGLING} />));
  assert.ok(out.includes('Loop cannot find the work this points at'));
  assert.ok(out.includes('What Loop could not read'));
});

test('4e. an ordinary in-progress item shows the clock without inventing a due date', () => {
  const out = strip(render(<WorkSection coordination={WORK_IN_PROGRESS} />));
  assert.ok(out.includes('In progress'));
  assert.ok(out.includes('On track'));
  assert.ok(out.includes('4h'), 'actionable time is derived, not stored');
});

test('4f. the work section never writes', () => {
  const src = readFileSync(new URL('../src/app/app/admin/cases/case-sections.tsx', import.meta.url), 'utf8');
  for (const forbidden of ['prisma', 'transition(', 'setDue(', 'resolveDependency(', 'action={']) {
    assert.equal(src.includes(forbidden), false, `sections must not contain ${forbidden}`);
  }
});

// --- 5. Outcome without causation -----------------------------------------------------------------

test('5. a recovery is reported, and causation is explicitly not claimed', () => {
  const out = strip(render(<OutcomeSection outcome={OUTCOME_RECOVERED_NO_CAUSE} />));
  assert.ok(out.includes('met its success criterion'));
  assert.ok(out.includes('$41,200'), 'the measured effect');
  // THE CAVEAT IS RENDERED, not hidden.
  assert.ok(out.includes('What this does not establish'));
  assert.ok(out.includes('cannot say that acting on it is what caused the change'));
  assert.ok(out.includes('counterfactual'));
});

test('5b. no outcome sentence uses a causal verb', () => {
  for (const o of [OUTCOME_RECOVERED_NO_CAUSE, OUTCOME_UNESTABLISHED]) {
    const out = strip(render(<OutcomeSection outcome={o} />));
    // The caveat contains "caused" by design — it is the refusal. The STATEMENT
    // must not.
    const statement = o.statement;
    for (const verb of ['caused', 'because', 'led to', 'resulted in', 'thanks to']) {
      assert.equal(statement.toLowerCase().includes(verb), false, `"${statement}" must not say "${verb}"`);
    }
    assert.ok(out.includes('What this does not establish'));
  }
});

test('5c. an outcome that established little says what it could not establish', () => {
  const out = strip(render(<OutcomeSection outcome={OUTCOME_UNESTABLISHED} />));
  assert.ok(out.includes('could not establish what happened'));
  assert.ok(out.includes('What Loop could not establish'));
  assert.ok(out.includes('No established finding'));
});

test('5d. no outcome at all is honest about it', () => {
  const out = strip(render(<OutcomeSection outcome={null} />));
  assert.ok(out.includes('Nothing has been recorded about what happened'));
  for (const wrong of ['successful', 'resolved', 'worked']) {
    assert.equal(out.toLowerCase().includes(wrong), false);
  }
});

// --- 6. The 5Ws, including the ones Loop cannot answer -----------------------------------------------

test('6. an empty WHY renders its structural reason, not a blank', () => {
  const out = strip(render(<FiveWs brief={CASE_KNOWN} />));
  assert.ok(out.includes('Why'));
  // The contract supplies the sentence; the surface renders it rather than
  // generating one or leaving a gap that reads as complete.
  assert.ok(out.includes('Loop'), 'the unavailable reason is rendered');
  // And no causation is manufactured.
  for (const verb of ['caused by', 'because the', 'due to the']) {
    assert.equal(out.toLowerCase().includes(verb), false, `must not say "${verb}"`);
  }
});

test('6b. answered dimensions show where each answer came from', () => {
  const out = strip(render(<FiveWs brief={CASE_KNOWN} />));
  assert.ok(out.includes('from evidence') || out.includes('from timeline'));
});

test('6c. a Case with uncertainty renders its caveats, not a clean sheet', () => {
  const out = strip(render(<FiveWs brief={CASE_WITH_UNCERTAINTY} />));
  assert.ok(out.length > 50, 'it renders');
  assert.equal(out.includes('Complete'), false, 'nothing claims completeness');
});

// --- 7. Timeline keeps what did not hold -------------------------------------------------------------

test('7. the timeline renders every entry, including a reopen', () => {
  const brief = {
    ...CASE_KNOWN,
    timeline: [
      { id: 'o1', sequence: 1, type: 'SITUATION_DETECTED', occurredAt: '2026-08-20T11:02:00.000Z', recordedAt: '2026-08-20T11:02:00.000Z', actorType: 'SYSTEM', actorUserId: null, source: 'ci', reason: null, note: null, previousState: null, newState: null, outcome: null },
      { id: 'o2', sequence: 2, type: 'RESOLVED', occurredAt: '2026-09-01T09:00:00.000Z', recordedAt: '2026-09-01T09:00:00.000Z', actorType: 'HUMAN', actorUserId: 'usr_charlie', source: 'operator', reason: 'Settlement recovered.', note: null, previousState: 'WATCHING', newState: 'RESOLVED', outcome: 'RECOVERED' },
      { id: 'o3', sequence: 3, type: 'REOPENED', occurredAt: '2026-09-08T09:00:00.000Z', recordedAt: '2026-09-08T09:00:00.000Z', actorType: 'SYSTEM', actorUserId: null, source: 'ci', reason: 'It came back.', note: null, previousState: 'RESOLVED', newState: 'NEEDS_REVIEW', outcome: null },
    ],
  } as never;
  const out = strip(render(<TimelineSection brief={brief} />));
  // THE RESOLUTION THAT DID NOT HOLD STAYS ON THE LOG. It is the most
  // informative thing a Case can carry.
  assert.ok(out.includes('resolved'));
  assert.ok(out.includes('Settlement recovered'));
  assert.ok(out.includes('reopened'));
  assert.ok(out.includes('It came back'));
  // And the lane changes read in product language.
  assert.ok(out.includes('Monitoring → Resolved'));
  assert.ok(out.includes('Resolved → Needs review'));
});

// --- 8. The page composes and does not derive ----------------------------------------------------------

test('8. the workspace page reads one contract and joins nothing', () => {
  const page = readFileSync(new URL('../src/app/app/admin/cases/[id]/page.tsx', import.meta.url), 'utf8');
  const data = readFileSync(new URL('../src/app/app/admin/cases/case-data.ts', import.meta.url), 'utf8');
  assert.ok(data.includes('CaseWorkspaceService'), 'the composition contract');
  // No second read model: the page must not reach any other service directly.
  for (const other of ['CaseFindingService', 'CaseRecommendationService', 'CaseMonitoringService', 'CaseWorkCoordinationService']) {
    assert.equal(page.includes(other), false, `the page must not reach ${other} itself`);
    assert.equal(data.includes(other), false, `the data layer must not reach ${other} itself`);
  }
  assert.ok(page.includes("requirePermission('commercialIntelligence', 'view')"));
  assert.ok(page.includes('session.organizationId'));
});

test('8b. a failed read cannot render as an empty investigation', () => {
  const page = readFileSync(new URL('../src/app/app/admin/cases/[id]/page.tsx', import.meta.url), 'utf8');
  assert.ok(page.includes('!read.ok'));
  assert.ok(page.includes('<ReadError'));
  assert.ok(page.includes('notFound()'), 'and a missing Case is not-found, not an error');
});

test('8c. absent controls are named rather than faked', () => {
  // A disabled control with a documented gap beats an invented mutation. There
  // is no generic updateCase anywhere.
  const page = readFileSync(new URL('../src/app/app/admin/cases/[id]/page.tsx', import.meta.url), 'utf8');
  assert.ok(page.includes('governed actions that exist in the backend'));
  assert.ok(page.includes('will not offer a control it cannot honestly perform'));
  // SCANNED AS CODE. The comment above the section names `updateCase` to say it
  // was refused; forbidding the word would forbid the explanation.
  const code = page.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.equal(/updateCase|saveCase|editCase/.test(code), false, 'no invented mutation');
  // And no form posts anywhere on this page yet.
  assert.equal(/action=\{/.test(code), false, 'no wired mutation claims to exist');
});

test('8d. no monitoring plan is not "monitoring healthy"', () => {
  const page = readFileSync(new URL('../src/app/app/admin/cases/[id]/page.tsx', import.meta.url), 'utf8');
  assert.ok(page.includes('not currently being monitored'));
  const code = page.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.equal(/monitoring healthy/i.test(code), false);
});
