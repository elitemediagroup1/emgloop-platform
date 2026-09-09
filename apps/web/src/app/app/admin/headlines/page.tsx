// Today's Headlines — the first screen, and the one that must never lie.
//
// THE GOVERNED ATTENTION STATE DECIDES WHAT THIS PAGE SAYS. Not the length of an
// array. `AttentionView` arrives already decided by a rule that re-reads every
// active objective's readiness verdict, and this page has no branch anywhere on
// `headlines.length === 0`. An empty list with full coverage is good news; an
// empty list with a poller down is an outage; both render as zero cards, and
// only the governed state can tell them apart.
//
// NO "SINCE YOU WERE LAST HERE". Loop does not record last-view time, so the
// greeting says what is actually true: this is what Loop can establish right
// now. Fabricating a since-you-were-away frame would be the first invented fact
// on the most-read screen in the product, and it would be invented for
// atmosphere.
//
// SERVER COMPONENT, GUARDED AT THE TOP. `commercialIntelligence:view` before
// anything is read, the organization from the signed session, and every service
// resolves within it. The dismiss and investigate controls each check the
// narrower `update` permission separately, so a viewer sees the intelligence and
// none of the authority.
//
// A FAILED READ IS NOT AN EMPTY MORNING. `loadAttention` returns a discriminated
// result and the failure branch renders `ReadError`, which shares no styling with
// any governed state and says in words that nothing here should be read as
// evidence of health.

import Link from 'next/link';

import {
  HEADLINE_DISMISSAL_BASES,
  HEADLINE_DISMISSAL_BASIS_HELP,
  HEADLINE_DISMISSAL_BASIS_LABELS,
} from '@emgloop/shared';

import { hasPermission, requirePermission } from '../../../../auth/guard';
import { greeting } from '../../_loop-os/format';
import { ReadError } from '../../_loop-os/product-state';
import { dismissHeadlineAction } from '../administration/objectives/actions';
import { investigateHeadlineAction } from '../administration/objectives/investigate-actions';
import { AttentionBanner, HeadlineCard } from './headline-ui';
import { loadAttention, loadExistingCase } from './headlines-data';

export const dynamic = 'force-dynamic';

export default async function HeadlinesPage({
  searchParams,
}: {
  searchParams?: { notice?: string; error?: string };
}) {
  // READ is the broad grant; the two controls below require the narrower
  // authoring grant independently. A READ_ONLY member sees the intelligence and
  // is offered nothing to press.
  const session = await requirePermission('commercialIntelligence', 'view');
  const canAuthor = await hasPermission('commercialIntelligence', 'update');

  const result = await loadAttention(session.organizationId);

  return (
    <div className="hl-page">
      <header className="hl-page__head">
        <p className="hl-page__eyebrow">Commercial Intelligence</p>
        <h1 className="hl-page__title">
          {greeting()}
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

          {result.value.headlines.length > 0 ? (
            <section className="hl-feed" aria-label="Headlines">
              {await Promise.all(
                result.value.headlines.map(async (headline) => {
                  // THE AUTHORITATIVE LINEAGE, not a convenience column. A Case's
                  // identity IS derived from the Headline id, which is why a
                  // repeated Investigate converges rather than duplicating.
                  //
                  // THIS READ CREATES NOTHING. Rendering a Headline has never
                  // opened an investigation and does not now.
                  const existing = await loadExistingCase(session.organizationId, headline.id);
                  const caseId = existing.ok ? (existing.value?.caseId ?? null) : null;

                  return (
                    <HeadlineCard
                      key={headline.id}
                      headline={headline}
                      caseId={caseId}
                      investigate={
                        canAuthor ? (
                          <div className="hl-acts">
                            <form action={investigateHeadlineAction} className="hl-acts__form">
                              <input type="hidden" name="headlineId" value={headline.id} />
                              <input type="hidden" name="surface" value="headlines" />
                              <button type="submit" className="ent-btn ent-btn--primary">
                                Investigate
                              </button>
                            </form>

                            {/* DISMISSAL ASKS WHICH OF TWO THINGS THE PERSON MEANS,
                                because that distinction is the only signal Loop
                                gets about whether it earns attention, and a
                                default would corrupt it. */}
                            <details className="hl-acts__dismiss">
                              <summary>Not this</summary>
                              <form action={dismissHeadlineAction} className="hl-acts__reasons">
                                <input type="hidden" name="headlineId" value={headline.id} />
                                <input type="hidden" name="surface" value="headlines" />
                                <fieldset className="hl-acts__fs">
                                  <legend>Why?</legend>
                                  {HEADLINE_DISMISSAL_BASES.map((basis) => (
                                    <label key={basis} className="hl-acts__radio">
                                      <input type="radio" name="basis" value={basis} required />
                                      <span>
                                        <strong>{HEADLINE_DISMISSAL_BASIS_LABELS[basis]}</strong>
                                        <em>{HEADLINE_DISMISSAL_BASIS_HELP[basis]}</em>
                                      </span>
                                    </label>
                                  ))}
                                </fieldset>
                                <button type="submit" className="ent-btn ent-btn--ghost">
                                  Record
                                </button>
                              </form>
                            </details>
                          </div>
                        ) : null
                      }
                    />
                  );
                }),
              )}
            </section>
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
