// Headlines — the canonical Headline workspace, and the one screen that must
// never lie.
//
// EVERY HEADLINE LIVES HERE, current and historical, and becomes actionable
// here. One list, three sections, sorted by a PROJECTION over two authorities
// the platform already has: the Headline record (open, or set aside with a
// basis) and the Case opened from it (its lane, its outcome, when it closed).
// Where a Headline stands is derived on every render by `headlineSituation()`
// in `@emgloop/shared`; nothing on this page stores, caches or transitions it,
// because a Headline has no lifecycle by design and the Case already has one.
//
//   Headline         Case                        Situation                  Section
//   open             none                        NEW                        Current
//   open             NEEDS_REVIEW|ASSIGNED|      UNDER_INVESTIGATION        Under investigation
//                    WATCHING
//   open             RESOLVED                    RESOLVED                   History
//   open             DISMISSED                   DISMISSED_BY_INVESTIGATION History
//   set aside        any, or none                SET_ASIDE                  History
//
// RESOLVED DOES NOT MEAN DELETED. History is a section, collapsed by default
// and always on the page. The `?show=` filter expands a section; it never
// removes one. A set-aside Headline shows its basis and when, and offers no
// decision -- the question Investigate and Set aside answer is closed.
//
// THE GOVERNED ATTENTION STATE DECIDES WHAT THIS PAGE SAYS FIRST. Not the
// length of an array. `AttentionView` arrives already decided by a rule that
// re-reads every active objective's readiness verdict, and this page has no
// branch anywhere on `headlines.length === 0`. An empty list with full coverage
// is good news; an empty list with a poller down is an outage; both render as
// zero cards, and only the governed state can tell them apart. The banner is
// never filtered: it speaks for the whole organization even when the list is
// scoped to one objective.
//
// NO "SINCE YOU WERE LAST HERE". Loop does not record last-view time, so the
// greeting says what is actually true: this is what Loop can establish right
// now. Fabricating a since-you-were-away frame would be the first invented fact
// on the most-read screen in the product, and it would be invented for
// atmosphere.
//
// SERVER COMPONENT, GUARDED AT THE TOP. `commercialIntelligence:view` before
// anything is read, the organization from the signed session, and every service
// resolves within it. The Investigate and Set aside controls each check the
// narrower `update` permission separately, so a viewer sees the intelligence and
// none of the authority. The `?objective=` scope is the repository's own filter,
// resolved inside the organization; another tenant's objective id matches
// nothing.
//
// A FAILED READ IS NOT AN EMPTY MORNING. Every loader returns a discriminated
// result and each failure branch renders `ReadError`, which shares no styling
// with any governed state and says in words that nothing here should be read as
// evidence of health. A list whose Cases could not be read is not sectioned at
// all, because a Headline shown as "current" while its investigation is
// unreadable would be a lie the projection cannot catch.
//
// WHAT THIS PAGE CANNOT DO. It cannot create work. There is no path from a
// Headline or a Case to a new work item in this build, and no control here
// pretends otherwise. Rendering this page writes nothing.

import Link from 'next/link';

import type { HeadlineView } from '@emgloop/shared';

import { hasPermission, requirePermission } from '../../../../auth/guard';
import { ReadError } from '../../_loop-os/product-state';
import { dismissHeadlineAction } from '../administration/objectives/actions';
import { investigateHeadlineAction } from '../administration/objectives/investigate-actions';
import {
  AttentionBanner,
  DismissalBasisFieldset,
  HeadlineSectionBlock,
  HeadlineShowNav,
  expandedSections,
  parseShow,
  sectionHeadlines,
  workspaceHref,
  type HeadlineShow,
} from './headline-ui';
import {
  loadAttention,
  loadCasesForHeadlines,
  loadHeadlinesForWorkspace,
  loadObjective,
  type ReadResult,
} from './headlines-data';
import { requireWorkspace } from '../../../../workspaces/guard';
import { viewerTime } from '../../../../time/viewer-time';
import { loadSituations } from '../../../../intelligence/situations';
import { SituationsPanel } from '../../../../intelligence/situations-view';

export const dynamic = 'force-dynamic';

export default async function HeadlinesPage({
  searchParams,
}: {
  searchParams?: { notice?: string; error?: string; show?: string; objective?: string };
}) {
  await requireWorkspace('ADMIN');
  // READ is the broad grant; the two controls below require the narrower
  // authoring grant independently. A READ_ONLY member sees the intelligence and
  // is offered nothing to press.
  const session = await requirePermission('commercialIntelligence', 'view');
  const canAuthor = await hasPermission('commercialIntelligence', 'update');
  const time = viewerTime();

  // The two query options, each closed: `show` parses against a fixed set and
  // an unknown value is the default; `objective` is an identifier the
  // repository resolves within the organization, never an authority.
  const show = parseShow(searchParams?.show);
  const objectiveId = (searchParams?.objective ?? '').trim() || null;

  const result = await loadAttention(session.organizationId);

  // THE FEED IS THE BANNER'S OWN HEADLINES unless the person scoped the list to
  // one objective, in which case it is the repository's own filter -- with
  // `dismissed` omitted either way, so history is read with the rest.
  const feed: ReadResult<readonly HeadlineView[]> | null = !result.ok
    ? null
    : objectiveId
      ? await loadHeadlinesForWorkspace(session.organizationId, { performanceObjectiveId: objectiveId })
      : { ok: true, value: result.value.headlines };
  const objective = result.ok && objectiveId ? await loadObjective(session.organizationId, objectiveId) : null;

  // THE SECOND AUTHORITY, IN ONE QUERY. Where each investigation stands, read
  // through the same lineage a repeated Investigate press resolves. THIS READ
  // CREATES NOTHING: rendering a Headline has never opened an investigation and
  // does not now.
  const cases = feed?.ok ? await loadCasesForHeadlines(session.organizationId, feed.value.map((h) => h.id)) : null;
  const sections = feed?.ok && cases?.ok ? sectionHeadlines(feed.value, cases.value) : null;
  const open = expandedSections(show);
  const situations = await loadSituations(session).catch(() => null);

  return (
    <div className="hl-page">
      <header className="hl-page__head">
        <p className="hl-page__eyebrow">Commercial Intelligence</p>
        <h1 className="hl-page__title">
          {time.greeting()}
          {session.name ? ', ' + session.name.split(' ')[0] : ''}.
        </h1>
        {/* TRUTHFUL, because Loop does not know when this person last looked. */}
        <p className="hl-page__sub">Here's what Loop can establish right now.</p>
      </header>

      {searchParams?.notice ? (
        <p className="hl-flash hl-flash--notice" role="status">{searchParams.notice}</p>
      ) : null}
      {searchParams?.error ? (
        <p className="hl-flash hl-flash--error" role="alert">{searchParams.error}</p>
      ) : null}

      {!result.ok ? (
        <ReadError what={result.what} retryHref="/app/admin/headlines" />
      ) : (
        <>
          <AttentionBanner attention={result.value.attention} />

          {/* Loop Intelligence Phase F: connected situations are Cases too. The measured Headlines below stay
              the evidence of measured movement; situations are read only by those who may read every
              domain each one cites. */}
          {situations?.organization && situations.organization.length > 0 ? (
            <SituationsPanel read={{ personal: [], organization: situations.organization }} time={time} caseHref={(id) => `/app/admin/cases/${id}`} />
          ) : null}

          {objectiveId ? <ObjectiveScope objective={objective} show={show} /> : null}

          {!feed || !feed.ok ? (
            <ReadError what={feed?.what ?? 'the headlines'} retryHref={workspaceHref(show, objectiveId)} />
          ) : !cases || !cases.ok ? (
            // NOT SECTIONED WITHOUT THE SECOND AUTHORITY. A Headline placed
            // under "Current" while its investigation could not be read would
            // be the projection lying by omission.
            <ReadError what={cases?.what ?? 'the investigations behind these headlines'} retryHref={workspaceHref(show, objectiveId)} />
          ) : sections ? (
            <>
              <HeadlineShowNav
                show={show}
                counts={{
                  current: sections.current.length,
                  investigating: sections.investigating.length,
                  history: sections.history.length,
                }}
                objectiveId={objectiveId}
              />

              <HeadlineSectionBlock
                id="CURRENT"
                title="Current"
                lead="Measured, and nobody has decided about it yet. Investigate it, or set it aside with a reason."
                entries={sections.current}
                expanded={open.CURRENT}
                empty="Nothing is waiting for a decision. Whether that is good news is what the state above says."
                time={time}
                controls={canAuthor ? (entry) => <DecisionControls headlineId={entry.headline.id} /> : undefined}
              />

              <HeadlineSectionBlock
                id="INVESTIGATING"
                title="Under investigation"
                lead="A person authorized an investigation. Where each one stands is the investigation's own to say."
                entries={sections.investigating}
                expanded={open.INVESTIGATING}
                empty="No Headline is under investigation right now."
                time={time}
              />

              <HeadlineSectionBlock
                id="HISTORY"
                title="History"
                lead="Resolved, closed without acting, or set aside. Kept, never deleted, and still resighted by Loop when the development persists."
                entries={sections.history}
                expanded={open.HISTORY}
                empty="Nothing has been resolved, closed or set aside yet."
                time={time}
              />
            </>
          ) : null}

          <footer className="hl-page__foot">
            <Link href="/app/admin/administration/objectives" className="hl-page__link">
              Objectives and evidence health
            </Link>
          </footer>
        </>
      )}
    </div>
  );
}

/**
 * The two decisions a person can make about a current Headline.
 *
 * SUPPLIED BY THE PAGE, NEVER BUILT BY THE CARD, and rendered by the card only
 * while the derived situation says nobody has decided. Both forms post to
 * actions that re-check the authoring grant for themselves.
 */
function DecisionControls({ headlineId }: { headlineId: string }) {
  return (
    <div className="hl-acts">
      <form action={investigateHeadlineAction} className="hl-acts__form">
        <input type="hidden" name="headlineId" value={headlineId} />
        <input type="hidden" name="surface" value="headlines" />
        <button type="submit" className="ent-btn ent-btn--primary">
          Investigate
        </button>
      </form>

      {/* SETTING ASIDE ASKS WHICH OF TWO THINGS THE PERSON MEANS, because that
          distinction is the only signal Loop gets about whether it earns
          attention, and a default would corrupt it. */}
      <details className="hl-acts__dismiss">
        <summary>Set aside</summary>
        <form action={dismissHeadlineAction} className="hl-acts__reasons">
          <input type="hidden" name="headlineId" value={headlineId} />
          <input type="hidden" name="surface" value="headlines" />
          <DismissalBasisFieldset />
          <button type="submit" className="ent-btn ent-btn--ghost">
            Record
          </button>
        </form>
      </details>
    </div>
  );
}

/**
 * What the list is scoped to, said plainly -- including when the objective
 * could not be named. A cross-organization id and a missing one read the same:
 * not-found, never forbidden.
 */
function ObjectiveScope({
  objective,
  show,
}: {
  objective: ReadResult<{ id: string; title: string } | null> | null;
  show: HeadlineShow;
}) {
  return (
    <p className="hl-scope" role="status">
      {objective?.ok && objective.value ? (
        <>
          Showing the Headlines measured against <strong>{objective.value.title}</strong>.
        </>
      ) : objective && !objective.ok ? (
        <>Loop could not name this objective. The list below is still scoped to it.</>
      ) : (
        <>Loop has no objective with that id in this organization, so nothing was measured against it.</>
      )}
      <Link href={workspaceHref(show, null)}>Show every objective</Link>
    </p>
  );
}
