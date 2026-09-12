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
  type FindingJudgmentView,
  type CaseParticipationView,
  CASE_WITH_EVIDENCE_CONTEXT,
  CASE_WITH_HUMAN_REPORT,
} from '@emgloop/shared';

import {
  EvidenceSection,
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
    generatedBy: 'DETERMINISTIC_RULE',
    evidenceState: 'DEVELOPING',
    judgment: null,
    lifecycle: 'CURRENT',
    establishment: {
      ruleVersion: 'case-finding-establishment.v1',
      eligible: false,
      basis: null,
      reasons: ['EVIDENCE_INCOMPLETE'],
      readinessWithholdings: [],
    },
    // NO CASTS. A fixture that bypassed the contract would keep compiling after
    // the contract moved under it, which is how the old version of this file went
    // on describing a Finding shape the product had stopped producing.
    reasoning: { known: [], inferred: [], missing: [], contradictory: [], unavailable: {} },
    supporting: [
      {
        id: 'ev_1',
        source: 'commercial-intelligence',
        metricKey: 'MONETIZED_RATE',
        window: 'Trailing 7 business days',
        value: 0.412,
        completeness: 0.6,
      },
    ],
    createdAt: '2026-08-23T14:00:00.000Z',
    supportingWindowStart: '2026-08-15T04:00:00.000Z',
    supportingWindowEnd: '2026-08-22T04:00:00.000Z',
    ruleVersion: 'case-finding-establishment.v1',
    lineage: [],
    ...over,
  };
}

/** The same claim, with its evidence establishing it. */
const established = (over: Partial<CaseFindingView> = {}) =>
  finding({
    evidenceState: 'ESTABLISHED',
    establishment: {
      ruleVersion: 'case-finding-establishment.v1',
      eligible: true,
      basis: 'DETERMINISTIC_POLICY',
      reasons: [],
      readinessWithholdings: [],
    },
    ...over,
  });

const ACCEPTED: FindingJudgmentView = {
  judgment: 'ACCEPTED',
  byUserId: 'user_lexi',
  at: '2026-08-26T14:05:00.000Z',
};
const REJECTED: FindingJudgmentView = {
  judgment: 'REJECTED',
  byUserId: 'user_charlie',
  at: '2026-08-26T15:40:00.000Z',
};

// --- 1. Developing vs Established vs Accepted -------------------------------------------

test('1. a developing finding is visibly not an established one', () => {
  const dev = strip(render(<FindingSection finding={finding()} />));
  const est = strip(render(<FindingSection finding={established()} />));
  assert.ok(dev.includes('Developing'));
  assert.ok(est.includes('Established'));
  assert.notEqual(dev, est);
  assert.equal(dev.includes('Established'), false);
});

test('1b. established is never rendered as "accepted"', () => {
  // A person accepting a claim is a decision. Establishment is what the evidence
  // supports. They must never share a word, a line or a badge.
  const policy = strip(render(<FindingSection finding={established()} />));
  assert.ok(policy.includes('evidence meets the governed standard on its own'));
  // Nobody judged it, and the page says exactly that rather than letting the
  // establishment double as somebody's agreement.
  assert.ok(policy.includes('Nobody has accepted or rejected this claim'));
  assert.equal(policy.includes('Accepted by'), false);
  assert.equal(policy.includes('A person accepted'), false);
});

test('1b2. what the evidence supports and what a person decided are separate lines', () => {
  const out = strip(render(<FindingSection finding={established({ judgment: ACCEPTED })} />));
  assert.ok(out.includes('What the evidence supports'));
  assert.ok(out.includes('What a person decided'));
  // BOTH FACTS, NEITHER STANDING IN FOR THE OTHER.
  assert.ok(out.includes('Established. The evidence meets the governed standard on its own.'));
  assert.ok(out.includes('Accepted by user_lexi · 2026-08-26'));
  assert.ok(out.includes('it does not establish the claim'));
});

test('1b3. an accepted claim with weak evidence still reads as developing', () => {
  // THE PROPERTY PR 1 EXISTS FOR, at the surface a person actually looks at.
  const out = strip(render(<FindingSection finding={finding({ judgment: ACCEPTED })} />));
  assert.ok(out.includes('Developing'));
  assert.equal(out.includes('Established. The evidence'), false);
  assert.ok(out.includes('Accepted by user_lexi'));
  assert.ok(out.includes('What stands between this and being established'));
});

test('1b4. a rejected claim still reads as established when the evidence establishes it', () => {
  const out = strip(render(<FindingSection finding={established({ judgment: REJECTED })} />));
  assert.ok(out.includes('Established. The evidence meets the governed standard on its own.'));
  assert.ok(out.includes('Rejected by user_charlie · 2026-08-26'));
  assert.ok(out.includes('Loop keeps evaluating the evidence'));
  // A rejection is never listed as a reason the claim is not established.
  assert.equal(out.includes('What stands between this and being established'), false);
});

test('1b5. a judgement never renders as a state badge', () => {
  // The five tones say what Loop knows. A judgement is not one of them, so it
  // gets words — otherwise "Accepted" arrives wearing the tick that means "Loop
  // stands behind this".
  const raw = render(<FindingSection finding={finding({ judgment: ACCEPTED })} />);
  const badges = raw.match(/class="[^"]*ps-badge ps-badge--[^"]*"/g) ?? [];
  assert.equal(raw.includes('>Accepted<'), false, 'the judgement is not its own badge');
  assert.ok(badges.length >= 1, 'the evidence state still is one');
});

test('1b6. a judgement with no attribution says so rather than implying nobody', () => {
  const out = strip(render(
    <FindingSection
      finding={finding({ judgment: { judgment: 'ACCEPTED', byUserId: null, at: null } })}
    />,
  ));
  assert.ok(out.includes('(who was not recorded)'));
  assert.ok(out.includes('(when was not recorded)'));
});

test('1c. establishment is described as re-derived, never as permanent', () => {
  const out = strip(render(<FindingSection finding={established()} />));
  assert.ok(out.includes('re-derived on every read'), 'a person is told it can weaken');
});

test('1d. a developing finding names what stands between it and establishment', () => {
  const out = strip(render(<FindingSection finding={finding()} />));
  assert.ok(out.includes('What stands between this and being established'));
  // THE GATE'S OWN REFUSAL, in the dictionary's words rather than a second
  // vocabulary the surface invented for itself.
  assert.ok(out.includes('Some evidence covers only part of the population it describes'));
  assert.equal(out.includes('EVIDENCE_INCOMPLETE'), false, 'and not as a raw enum');
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
            lifecycle: 'SUPERSEDED',
            judgment: ACCEPTED,
            generatedBy: 'DETERMINISTIC_RULE',
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
  // AND THE JUDGEMENT IT CARRIED, without an evidence state: history is not
  // re-evaluated, and today's reading is not what was known then.
  assert.ok(out.includes('Accepted by user_lexi'));
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

// --- 7z. Evidence: what was reported, and what was measured -----------------------------

test('7z. a human report renders attributed, never as a bare fact', () => {
  // "The API token expired" and "Matt reported that the API token expired" are
  // different claims, and only the second one is true the moment it is written.
  const out = strip(render(<EvidenceSection brief={CASE_WITH_HUMAN_REPORT} />));
  assert.ok(out.includes('usr_matt reported'));
  assert.ok(out.includes('CEM told me on Friday'), 'their own words, verbatim');
  assert.ok(out.includes('has not established that what it says is true'));
});

test('7z2. nothing numeric is invented for a report', () => {
  const out = strip(render(<EvidenceSection brief={CASE_WITH_HUMAN_REPORT} />));
  // The measurement beside it shows a measure and a population that reported;
  // the report shows neither, because a sentence has neither.
  assert.ok(out.includes('MONETIZED_RATE'));
  assert.ok(out.includes('% of the population reported'));
  const reportBlock = out.slice(out.indexOf('usr_matt reported'));
  for (const invented of ['HUMAN_REPORT', 'NON_METRIC', 'MANUAL', 'UNKNOWN', '0%', 'n/a']) {
    assert.equal(reportBlock.includes(invented), false, `must not render "${invented}"`);
  }
});

test('7z3. a report never wears an epistemic state badge', () => {
  // The five tones say what LOOP knows. How evidence arrived is not one of them,
  // so the class is words: a report carrying the tick that means "Loop stands
  // behind this" is the exact confusion this section exists to prevent.
  const html = render(<EvidenceSection brief={CASE_WITH_HUMAN_REPORT} />);
  assert.equal(/ps-badge/.test(html), false, 'no state badge in the evidence list');
  assert.ok(strip(html).includes('Reported by a person'));
});

test('7z4. an investigation with nothing recorded says so, and does not read as clear', () => {
  const empty = { ...CASE_WITH_HUMAN_REPORT, evidence: [] };
  const out = strip(render(<EvidenceSection brief={empty} />));
  assert.ok(out.includes('Nothing has been recorded'));
  for (const wrong of ['no issue', 'all clear', 'nothing wrong', 'healthy']) {
    assert.equal(out.toLowerCase().includes(wrong), false);
  }
});

// --- 7y. Evidence context: additive, never an edit ---------------------------------------

test('7y. context renders beneath the unchanged original, never instead of it', () => {
  const out = strip(render(<EvidenceSection brief={CASE_WITH_EVIDENCE_CONTEXT} />));
  // The corrected report keeps its own words AND the correction is visible.
  assert.ok(out.includes('The production API token expired at about 09:15'));
  assert.ok(out.includes('Corrected by'));
  assert.ok(out.includes('I was looking at the staging credential'));
  // And the page says plainly that nothing above was edited.
  assert.ok(out.includes('nothing here edits, replaces or hides it'));
});

test('7y2. every relation shows what it establishes and what it does not', () => {
  const out = strip(render(<EvidenceSection brief={CASE_WITH_EVIDENCE_CONTEXT} />));
  assert.ok(out.includes('Corroborated by'));
  assert.ok(out.includes('Contradicted by'));
  // The half that stops a context note reading as a verdict.
  assert.ok(out.includes('does not decide which one is right'));
  assert.ok(out.includes('Agreement is not measurement'));
  assert.ok(out.includes('does not delete or edit the original'));
});

test('7y3. context is attributed, and carries no state badge', () => {
  const html = render(<EvidenceSection brief={CASE_WITH_EVIDENCE_CONTEXT} />);
  const out = strip(html);
  assert.ok(out.includes('usr_lexi'), 'who recorded it');
  assert.ok(out.includes('2026-08-22'), 'and when');
  // A relation is a fact about two records, not a statement of what Loop knows.
  assert.equal(/ps-badge/.test(html), false);
});

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

test('8c. every control reuses an existing mutation, and none was invented', () => {
  // THIS TEST REPLACES ITS OWN PLACEHOLDER. It previously asserted that NO form
  // posted anywhere on this page and that the screen said so in words. The
  // controls are wired now, so it asserts the property that mattered underneath:
  // every one of them calls a mutation that already existed, and there is no
  // generic write path.
  const actions = readFileSync(new URL('../src/app/app/admin/cases/actions.ts', import.meta.url), 'utf8');
  const code = actions.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

  // NO GENERIC MUTATION. Not one, under any of the names it would arrive as.
  assert.equal(/updateCase|saveCase|editCase|patchCase|setCaseState/.test(code), false);

  // Every write goes through a service that owns the fact. The actions file
  // constructs no Prisma query of its own.
  for (const forbidden of ['prisma.', '$transaction', 'findFirst', 'updateMany']) {
    assert.equal(code.includes(forbidden), false, `actions must not contain ${forbidden}`);
  }
  for (const owner of [
    'CaseRecommendationService',
    'CaseFindingService',
    'CaseParticipationService',
    'CaseMonitoringService',
    'createDecisionEngine',
  ]) {
    assert.ok(code.includes(owner), `${owner} is the authority for its own mutation`);
  }
});

test('8d. no monitoring plan is not "monitoring healthy"', () => {
  const page = readFileSync(new URL('../src/app/app/admin/cases/[id]/page.tsx', import.meta.url), 'utf8');
  assert.ok(page.includes('not currently being monitored'));
  const code = page.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.equal(/monitoring healthy/i.test(code), false);
});
