// Headline Investigation — the claim, why it matters, where it stands, and what
// Loop does and does not know about it.
//
// THIS IS NOT A RECORD PAGE. Opening a Headline puts a person in front of an
// argument they have to judge: here is what Loop measured, here is what that
// measurement will not support, here is how Loop measured it, and here is what
// happened before. The decision sits at the bottom because it belongs after the
// evidence, not beside the title.
//
// WHERE IT STANDS IS DERIVED, NEVER STORED. The health band reads
// `headlineSituation()`, a pure projection over two records that already exist:
// this Headline (open, or set aside with a basis) and the Case opened from it
// (its lane, its outcome, when it closed). "Since it was identified" shows the
// facts that projection rests on -- the Headline's own counters, the Case's
// state, outcome and close time, and the work the Case references, read from
// Work OS through the Case's coordination read and owned by Work OS. Nothing on
// this page is a Headline state, and nothing here caches one.
//
// BUILT ON `EntityPage`, the repository's existing detail-page language, so this
// looks like the rest of the product rather than like a new one. Its sections
// map onto the brief's almost exactly: health is where the claim stands,
// evidence is "what Loop knows" and "how Loop knows", history is history. What
// it did not have is a first-class place for what Loop DOESN'T know, and that
// renders above the page rather than being folded into evidence, because a
// caveat inside an evidence list reads as evidence.
//
// TWO DECISIONS, OFFERED ONLY WHILE ONE IS OPEN. Investigate and Set aside are
// answers to "does this deserve attention", offered to a person holding the
// authoring grant while nobody has answered. Once a Case exists the primary
// action is the way into it; once the Headline is set aside there is nothing to
// decide and no control pretends otherwise. There is no path from a Headline to
// new work in this build, and no button implies one.
//
// NOTHING HERE WRITES. Rendering this page, expanding a disclosure and reading
// the evidence all create nothing. The only writes on the screen are the two
// forms posting to guarded actions, and the organization on both comes from the
// signed session.

import { notFound } from 'next/navigation';
import Link from 'next/link';

import {
  HEADLINE_DISMISSAL_BASIS_LABELS,
  HEADLINE_TONE_LABELS,
  caseOutcomeLabel,
  headlineAcceptsDecision,
  headlineSituation,
  headlineSituationLabel,
  headlineTone,
  isClosed,
  productLabel,
  type CaseCoordinationView,
} from '@emgloop/shared';

import {
  EntityPage,
  type EntityEvidence,
  type EntityHealth,
  type EntityHistoryItem,
  type EntityPageModel,
  type EntityRelatedItem,
} from '../../../_loop-os';
import { hasPermission, requirePermission } from '../../../../../auth/guard';
import { LabelBadge, NotKnown, ReadError, StateBadge, toneFor } from '../../../_loop-os/product-state';
import { dismissHeadlineAction } from '../../administration/objectives/actions';
import { investigateHeadlineAction } from '../../administration/objectives/investigate-actions';
import { DismissalBasisFieldset, HeadlineStanding } from '../headline-ui';
import {
  loadCasesForHeadlines,
  loadCoordination,
  loadExistingCase,
  loadHeadline,
  type ReadResult,
} from '../headlines-data';
import { requireWorkspace } from '../../../../../workspaces/guard';
import { viewerTime } from '../../../../../time/viewer-time';

export const dynamic = 'force-dynamic';

const pct = (v: number | null) => (v === null ? '—' : (v * 100).toFixed(1) + '%');
const signed = (v: number | null) =>
  v === null ? '—' : (v * 100 > 0 ? '+' : '') + (v * 100).toFixed(1) + '%';

export default async function HeadlineInvestigationPage({
  params,
}: {
  params: { id: string };
}) {
  await requireWorkspace('ADMIN');
  const session = await requirePermission('commercialIntelligence', 'view');
  const canAuthor = await hasPermission('commercialIntelligence', 'update');
  const time = viewerTime();

  const read = await loadHeadline(session.organizationId, params.id);
  if (!read.ok) {
    return (
      <div className="hl-page">
        <ReadError what={read.what} retryHref={'/app/admin/headlines/' + params.id} />
      </div>
    );
  }
  // NOT-FOUND, NEVER FORBIDDEN. A Headline in another organization resolves to
  // null in the repository and reaches here indistinguishable from one that
  // does not exist, so this page cannot be used to enumerate other tenants.
  const headline = read.value;
  if (!headline) notFound();

  // THE SECOND AUTHORITY. Where the investigation stands, read through the same
  // lineage a repeated Investigate press resolves. Without it the situation
  // cannot be derived honestly, so a failed read is a failed page rather than a
  // Headline shown as new.
  const cases = await loadCasesForHeadlines(session.organizationId, [headline.id]);
  if (!cases.ok) {
    return (
      <div className="hl-page">
        <ReadError what={cases.what} retryHref={'/app/admin/headlines/' + params.id} />
      </div>
    );
  }
  const kase = cases.value.get(headline.id) ?? null;
  const situation = headlineSituation(headline, kase);
  const standing = headlineSituationLabel(situation);

  // Per-thread reads, made only when there is a thread: who authorized it, and
  // what work it references. Both are reads and both create nothing.
  const existing = kase ? await loadExistingCase(session.organizationId, headline.id) : null;
  const coordination = kase ? await loadCoordination(session.organizationId, kase.caseId, time.now) : null;

  const m = headline.measurement;
  const tone = headlineTone(headline);
  const caseStateWord = kase ? (productLabel(kase.state)?.label ?? kase.state) : null;
  const outcomeWord = kase?.outcome ? (caseOutcomeLabel(kase.outcome)?.label ?? kase.outcome) : null;

  // THE POSTURE OF THE CLAIM, in the product's words. For a Headline nobody has
  // decided about, that is its relationship to the objective's stated direction;
  // for every other situation it is the situation itself. Never a confidence
  // percentage: there is no governed confidence in this platform and a number
  // here would be read as authority Loop was never granted.
  const health: EntityHealth =
    situation === 'NEW'
      ? {
          label: HEADLINE_TONE_LABELS[tone],
          tone: tone === 'AGAINST' ? 'crit' : 'good',
          line:
            tone === 'AGAINST'
              ? 'This move runs against the direction ' +
                (headline.objectiveTitle ?? 'the objective') +
                ' states. That is arithmetic against a stated intent, not a judgement about the business.'
              : 'This move runs with the direction ' +
                (headline.objectiveTitle ?? 'the objective') +
                ' states.',
        }
      : {
          label: standing.label,
          tone: toneFor(standing.tone),
          line:
            situation === 'SET_ASIDE'
              ? (headline.dismissedByName ?? 'Somebody') +
                ' recorded that this did not need attention' +
                (headline.dismissalBasis
                  ? ' (' + HEADLINE_DISMISSAL_BASIS_LABELS[headline.dismissalBasis].toLowerCase() + ')'
                  : '') +
                (headline.dismissedAt ? ' on ' + time.date(headline.dismissedAt) : '') +
                '. Loop keeps watching whether it persists — setting aside never stops recurrence.'
              : situation === 'UNDER_INVESTIGATION'
                ? standing.detail + ' Right now it reads: ' + (caseStateWord ?? '') + '.'
                : standing.detail +
                  (outcomeWord ? ' Outcome: ' + outcomeWord + '.' : ' No outcome was recorded.') +
                  (kase?.resolvedAt ? ' Closed ' + time.date(kase.resolvedAt) + '.' : ''),
        };

  // WHAT LOOP KNOWS. Every fact traces to the measurement; none is composed.
  const evidence: EntityEvidence[] = [
    {
      label: 'The measurement',
      tone: 'good',
      facts: [
        { statement: m.metricLabel + ', current window', value: pct(m.currentValue) },
        { statement: m.metricLabel + ', prior window', value: pct(m.priorValue) },
        { statement: 'Change', value: signed(m.percentageChange) },
        {
          statement: 'Calls measured, current window',
          value: m.currentDenominator.toLocaleString('en-US'),
        },
        {
          statement: 'Calls measured, prior window',
          value: m.priorDenominator.toLocaleString('en-US'),
        },
      ],
      note: m.comparisonBasis,
    },
    {
      label: 'Coverage',
      // Coverage below the ready threshold cannot produce a Headline at all, so
      // anything here passed Stage 3's gate. It is shown because 98% and 61% are
      // different claims even when both are ready.
      tone: (m.currentCoverage ?? 1) >= 0.95 ? 'good' : 'warn',
      facts: [
        { statement: 'Current window measured', value: pct(m.currentCoverage) },
        { statement: 'Prior window measured', value: pct(m.priorCoverage) },
      ],
      note:
        'A Headline exists only where Stage 3 established that the measurement could be made. ' +
        'Coverage says how much of the window that measurement actually saw.',
    },
    {
      label: 'How Loop knows',
      tone: 'idle',
      facts: [
        { statement: 'Rule', value: headline.ruleId, source: headline.ruleVersion },
        { statement: 'Threshold', value: headline.ruleDescription },
        {
          statement: 'Measure binding',
          value: headline.measureBindingId + ' · v' + headline.measureBindingVersion,
        },
        { statement: 'Producer build', value: headline.producerVersion },
        {
          statement: 'Current window',
          value: m.currentWindowStart.slice(0, 10) + ' → ' + m.currentWindowEnd.slice(0, 10),
        },
        {
          statement: 'Prior window',
          value: m.priorWindowStart.slice(0, 10) + ' → ' + m.priorWindowEnd.slice(0, 10),
        },
      ],
      note:
        'The exact binding version this was produced under, never the latest one — so a rule ' +
        'change does not retroactively rewrite what Loop concluded.',
    },
  ];

  // WHAT HAPPENED PREVIOUSLY. The Headline's own counters, the person's own
  // dismissal, and the Case's close -- each from the record that owns it.
  const history: EntityHistoryItem[] = [
    {
      at: time.dateTime(headline.firstDetectedAt),
      label: 'First detected',
      detail: 'Loop measured this development for the first time.',
    },
    {
      at: time.dateTime(headline.lastDetectedAt),
      label: 'Last detected',
      detail:
        'Seen in ' +
        headline.detectionCount +
        (headline.detectionCount === 1 ? ' analysis run.' : ' analysis runs.'),
    },
    ...(headline.dismissedAt
      ? [
          {
            at: time.dateTime(headline.dismissedAt),
            label: headlineSituationLabel('SET_ASIDE').label,
            detail:
              (headline.dismissedByName ?? 'Somebody') +
              ' recorded that this did not need attention' +
              (headline.dismissalBasis
                ? ': ' + HEADLINE_DISMISSAL_BASIS_LABELS[headline.dismissalBasis].toLowerCase() + '.'
                : '.'),
          },
        ]
      : []),
    ...(kase?.resolvedAt
      ? [
          {
            at: time.dateTime(kase.resolvedAt),
            label: 'Investigation closed',
            detail: outcomeWord ? 'Outcome: ' + outcomeWord + '.' : 'No outcome was recorded.',
            tone: 'good' as const,
          },
        ]
      : []),
  ];

  const related: EntityRelatedItem[] = [
    ...(kase
      ? [
          {
            icon: 'search',
            title: 'The investigation',
            detail: caseStateWord ?? undefined,
            href: '/app/admin/cases/' + kase.caseId,
          },
        ]
      : []),
    {
      icon: 'target',
      title: headline.objectiveTitle ?? 'Objectives',
      detail: 'Objectives and evidence health',
      href: '/app/admin/administration/objectives',
    },
  ];

  // THE HUMAN GATE. The decision sits after the evidence, deliberately, and is
  // offered only while the projection says nobody has made it.
  const primaryAction = kase ? (
    <Link href={'/app/admin/cases/' + kase.caseId} className="ent-btn ent-btn--primary">
      Open investigation
    </Link>
  ) : headlineAcceptsDecision(situation) && canAuthor ? (
    <div className="hl-primary">
      <form action={investigateHeadlineAction}>
        <input type="hidden" name="headlineId" value={headline.id} />
        <input type="hidden" name="surface" value="headlines" />
        <button type="submit" className="ent-btn ent-btn--primary">
          Investigate
        </button>
      </form>
      {/* SETTING ASIDE ASKS WHICH OF TWO THINGS THE PERSON MEANS. The action
          returns to this page only after it resolved and wrote this row. */}
      <details className="hl-acts__dismiss">
        <summary>Set aside</summary>
        <form action={dismissHeadlineAction} className="hl-acts__reasons">
          <input type="hidden" name="headlineId" value={headline.id} />
          <input type="hidden" name="surface" value="headline" />
          <DismissalBasisFieldset />
          <button type="submit" className="ent-btn ent-btn--ghost">
            Record
          </button>
        </form>
      </details>
    </div>
  ) : undefined;

  const model: EntityPageModel = {
    eyebrow: 'Headline',
    title: headline.statement,
    subtitle: headline.objectiveTitle
      ? 'Measured against ' + headline.objectiveTitle
      : 'Measured against a performance objective',
    backHref: '/app/admin/headlines',
    backLabel: 'Headlines',

    stats: [
      { label: m.metricLabel, value: pct(m.currentValue) },
      { label: 'Change', value: signed(m.percentageChange), tone: m.againstObjective ? 'crit' : 'good' },
      { label: 'Coverage', value: pct(m.currentCoverage) },
      {
        label: 'Seen',
        value: headline.detectionCount + (headline.detectionCount === 1 ? ' time' : ' times'),
      },
    ],

    health,

    whyItMatters: headline.objectiveTitle
      ? 'Somebody stated that this organization is trying to ' +
        headline.objectiveTitle.toLowerCase() +
        '. This measurement moved ' +
        (m.againstObjective ? 'against' : 'with') +
        ' that intent by ' +
        signed(m.percentageChange) +
        ' over ' +
        m.comparisonBasis.toLowerCase()
      : undefined,

    evidence,
    related,
    history,

    // SINCE IT WAS IDENTIFIED: the facts the situation rests on, from the two
    // records that own them, and the work the Case references, read-only.
    manageTitle: 'Since it was identified',
    manage: (
      <div>
        <dl className="hl-since">
          <div>
            <dt>Where it stands</dt>
            <dd><LabelBadge label={standing} /></dd>
          </div>
          <div>
            <dt>First seen</dt>
            <dd>{time.dateTime(headline.firstDetectedAt)}</dd>
          </div>
          <div>
            <dt>Last seen</dt>
            <dd>{time.dateTime(headline.lastDetectedAt)}</dd>
          </div>
          <div>
            <dt>Times seen</dt>
            <dd>{headline.detectionCount}</dd>
          </div>
          {headline.dismissedAt ? (
            <div>
              <dt>Set aside</dt>
              <dd>
                {headline.dismissalBasis
                  ? HEADLINE_DISMISSAL_BASIS_LABELS[headline.dismissalBasis]
                  : 'No basis recorded'}
                <span className="hl-since__quiet">
                  · {time.dateTime(headline.dismissedAt)}
                  {headline.dismissedByName ? ' · by ' + headline.dismissedByName : ''}
                </span>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Investigation</dt>
            <dd>
              {kase ? (
                <>
                  <StateBadge state={kase.state} />
                  <Link href={'/app/admin/cases/' + kase.caseId}>Open investigation</Link>
                </>
              ) : (
                <span className="hl-since__quiet">None has been opened.</span>
              )}
            </dd>
          </div>
          {kase ? (
            <div>
              <dt>Outcome</dt>
              <dd>
                {outcomeWord ?? (
                  <span className="hl-since__quiet">
                    {isClosed(kase.state) ? 'None recorded.' : 'Not yet — the investigation is open.'}
                  </span>
                )}
              </dd>
            </div>
          ) : null}
          {kase ? (
            <div>
              <dt>Closed</dt>
              <dd>
                {kase.resolvedAt ? (
                  time.dateTime(kase.resolvedAt)
                ) : (
                  <span className="hl-since__quiet">
                    {isClosed(kase.state) ? 'Time not recorded.' : 'Still open.'}
                  </span>
                )}
              </dd>
            </div>
          ) : null}
          {kase ? (
            <div>
              <dt>Work</dt>
              <dd>
                <WorkLine coordination={coordination} caseId={kase.caseId} />
              </dd>
            </div>
          ) : null}
        </dl>
        {kase && existing?.ok && existing.value && !existing.value.humanAuthorizationRecorded ? (
          <p className="hl-since__note">
            Loop has no record of who authorized this investigation — pressing Investigate again
            will complete that record without opening anything new.
          </p>
        ) : null}
        <p className="hl-since__note">
          Whatever stands here, Loop keeps resighting this development while it persists. The
          counters above move; nothing else on the Headline does.
        </p>
      </div>
    ),

    empty: {
      history: 'Loop has not recorded anything else about this development yet.',
      actions:
        situation === 'SET_ASIDE'
          ? 'This Headline was set aside. Loop keeps watching it; nothing here needs a decision.'
          : situation === 'NEW' && !canAuthor
            ? 'You can read this Headline. Investigating it or setting it aside needs permission to author commercial intelligence.'
            : undefined,
    },

    primaryAction,
  };

  return (
    <div className="hl-invest">
      {/* WHAT LOOP DOESN'T KNOW, ABOVE THE PAGE RATHER THAN INSIDE IT. A caveat
          rendered inside an evidence list reads as evidence, and these are the
          opposite: the reasons this measurement cannot carry more weight than it
          does. */}
      <NotKnown
        lines={[...headline.limitations, ...headline.unknowns]}
        title="What this measurement doesn't establish"
      />

      {situation === 'UNDER_INVESTIGATION' && kase ? (
        <p className="hl-invest__open" role="status">
          <StateBadge state={kase.state} />
          This Headline is under investigation.
          {existing?.ok && existing.value && !existing.value.humanAuthorizationRecorded ? (
            <span className="hl-invest__note">
              {' '}
              Loop has no record of who authorized it — pressing Investigate again will complete
              that record without opening anything new.
            </span>
          ) : null}
        </p>
      ) : situation !== 'NEW' ? (
        <p className="hl-invest__open" role="status">
          <HeadlineStanding headline={headline} kase={kase} time={time} />
        </p>
      ) : null}

      <EntityPage model={model} />
    </div>
  );
}

/**
 * The work a Case references, read from Work OS and owned by Work OS.
 *
 * READ-ONLY, BY DESIGN AND BY ABSENCE. This build has no path from a Headline
 * or a Case to a new work item, so this line shows what exists and links to the
 * Case, where the work is read in full. Three different unreadable answers
 * survive as the coordination read's own sentences rather than as a blank.
 */
function WorkLine({
  coordination,
  caseId,
}: {
  coordination: ReadResult<CaseCoordinationView | null> | null;
  caseId: string;
}) {
  if (!coordination) {
    return <span className="hl-since__quiet">Not read.</span>;
  }
  if (!coordination.ok) {
    return (
      <span className="hl-since__quiet">
        Loop could not read the work behind this investigation. That is a failure to read, not an
        absence of work.
      </span>
    );
  }
  const view = coordination.value;
  if (!view || view.work.length === 0) {
    return <span className="hl-since__quiet">No work has been created from this investigation.</span>;
  }
  return (
    <>
      <span>
        {view.work.length} work {view.work.length === 1 ? 'item' : 'items'}
      </span>
      {view.work.map((w) =>
        w.execution ? <StateBadge key={w.observationId} state={w.execution.state} /> : null,
      )}
      {view.notKnown.length > 0 ? (
        <span className="hl-since__quiet">{view.notKnown.join(' ')}</span>
      ) : null}
      <Link href={'/app/admin/cases/' + caseId + '#cw-work'}>Read it on the investigation</Link>
    </>
  );
}
