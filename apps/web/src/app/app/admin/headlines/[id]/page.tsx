// Headline Investigation — the claim, why it matters, and what Loop does and
// does not know about it.
//
// THIS IS NOT A RECORD PAGE. Opening a Headline puts a person in front of an
// argument they have to judge: here is what Loop measured, here is what that
// measurement will not support, here is how Loop measured it, and here is what
// happened before. The Investigate button is at the bottom because the decision
// belongs after the evidence, not beside the title.
//
// BUILT ON `EntityPage`, the repository's existing detail-page language, so this
// looks like the rest of the product rather than like a new one. Its sections
// map onto the brief's almost exactly: health is the claim's posture, evidence
// is "what Loop knows" and "how Loop knows", history is history. What it did not
// have is a first-class place for what Loop DOESN'T know, and that renders
// above the page rather than being folded into evidence, because a caveat inside
// an evidence list reads as evidence.
//
// NOTHING HERE WRITES. Rendering this page, expanding a disclosure and reading
// the evidence all create nothing. The only write on the screen is a form
// posting to the guarded promotion action.

import { notFound } from 'next/navigation';
import Link from 'next/link';

import { EntityPage, type EntityEvidence, type EntityPageModel } from '../../../_loop-os';
import { hasPermission, requirePermission } from '../../../../../auth/guard';
import { NotKnown, ReadError, StateBadge } from '../../../_loop-os/product-state';
import { investigateHeadlineAction } from '../../administration/objectives/investigate-actions';
import { loadExistingCase, loadHeadline } from '../headlines-data';

export const dynamic = 'force-dynamic';

const pct = (v: number | null) => (v === null ? '—' : (v * 100).toFixed(1) + '%');
const signed = (v: number | null) =>
  v === null ? '—' : (v * 100 > 0 ? '+' : '') + (v * 100).toFixed(1) + '%';

export default async function HeadlineInvestigationPage({
  params,
}: {
  params: { id: string };
}) {
  const session = await requirePermission('commercialIntelligence', 'view');
  const canAuthor = await hasPermission('commercialIntelligence', 'update');

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

  const existing = await loadExistingCase(session.organizationId, headline.id);
  const caseId = existing.ok ? (existing.value?.caseId ?? null) : null;
  const m = headline.measurement;

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

    // THE POSTURE OF THE CLAIM, in the product's words. Never a confidence
    // percentage: there is no governed confidence in this platform and a number
    // here would be read as authority Loop was never granted.
    health: headline.dismissedAt
      ? {
          label: 'Set aside',
          tone: 'idle',
          line:
            'Somebody recorded that this did not need attention. Loop keeps watching whether it ' +
            'persists — dismissal never stops recurrence.',
        }
      : m.againstObjective
        ? {
            label: 'Against the objective',
            tone: 'crit',
            line:
              'This move runs against the direction ' +
              (headline.objectiveTitle ?? 'the objective') +
              ' states. That is arithmetic against a stated intent, not a judgement about the business.',
          }
        : {
            label: 'With the objective',
            tone: 'good',
            line:
              'This move runs with the direction ' +
              (headline.objectiveTitle ?? 'the objective') +
              ' states.',
          },

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

    history: [
      {
        at: headline.firstDetectedAt,
        label: 'First detected',
        detail: 'Loop measured this development for the first time.',
      },
      {
        at: headline.lastDetectedAt,
        label: 'Last detected',
        detail:
          'Seen in ' +
          headline.detectionCount +
          (headline.detectionCount === 1 ? ' analysis run.' : ' analysis runs.'),
      },
      ...(headline.dismissedAt
        ? [
            {
              at: headline.dismissedAt,
              label: 'Set aside',
              detail:
                (headline.dismissedByName ?? 'Somebody') +
                ' recorded that this did not need attention.',
            },
          ]
        : []),
    ],

    empty: {
      history: 'Loop has not recorded anything else about this development yet.',
    },

    // THE HUMAN GATE. The decision sits after the evidence, deliberately.
    primaryAction: caseId ? (
      <Link href={'/app/admin/cases/' + caseId} className="ent-btn ent-btn--primary">
        Open investigation
      </Link>
    ) : canAuthor ? (
      <form action={investigateHeadlineAction}>
        <input type="hidden" name="headlineId" value={headline.id} />
        <input type="hidden" name="surface" value="headlines" />
        <button type="submit" className="ent-btn ent-btn--primary">
          Investigate
        </button>
      </form>
    ) : undefined,
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

      {caseId ? (
        <p className="hl-invest__open" role="status">
          <StateBadge state="NEEDS_ATTENTION" />
          This Headline is already under investigation.
          {existing.ok && existing.value && !existing.value.humanAuthorizationRecorded ? (
            <span className="hl-invest__note">
              {' '}
              Loop has no record of who authorized it — pressing Investigate again will complete
              that record without opening anything new.
            </span>
          ) : null}
        </p>
      ) : null}

      <EntityPage model={model} />
    </div>
  );
}
