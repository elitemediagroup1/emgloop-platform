import 'server-only';
import { realCreatorEarnings } from './creator-earnings';
import Link from 'next/link';
import type { TimeView } from '@emgloop/shared';
import { CREATOR_HREFS, creatorDomain, type CreatorSeat } from './creator-runtime';
import {
  loadCreatorBrandUpdates,
  groupCreatorBrandRows,
  latestCreatorBrandUpdate,
  creatorBrandStageKey,
} from './creator-brand-updates';
import { creatorPublicMedia } from './creator-public-media';
import { CreatorRefreshButton } from './CreatorRefreshButton';
import { CreatorUpdatesRefresh } from './CreatorUpdatesRefresh';
import { CreatorPageHead } from './creator-page-head';
import { settle } from '../app/app/_home/settle';
import { LoopPage, StateBlock } from '../app/app/_loop-os/record';
import { TaskList } from '../app/app/creator/_parts/task-list';
import { moneyMinor } from '../app/app/creator/_parts/vocabulary';
export async function CreatorHome({ seat, time }: { seat: CreatorSeat; time: TimeView }) {
  const domain = creatorDomain();
  const [profile, brands, tasks, earnings] = await Promise.all([
    settle(() => domain.creator.profileById(seat.actor.organizationId, seat.profileId)),
    loadCreatorBrandUpdates(seat, time),
    settle(() =>
      domain.records.tasks(seat.actor, {
        content: CREATOR_HREFS.contentRecord,
        profile: CREATOR_HREFS.profile,
      }),
    ),
    settle(() => domain.records.earnings(seat.actor.organizationId, seat.profileId)),
  ]);
  const balance = earnings.ok ? realCreatorEarnings(earnings.value) : null;
  const media = profile.ok ? creatorPublicMedia(profile.value?.preferences) : null;
  const latest = groupCreatorBrandRows(brands.rows).flatMap((g) => {
    const update = latestCreatorBrandUpdate(g);
    return update ? [{ brand: g.brand, id: g.brandId, update }] : [];
  });
  const count = (stages: string[]) =>
    latest.filter((g) => stages.includes(g.update.stage ?? '')).length;
  const outreach = count(['OUTREACH']),
    conversations = count([
      'DISCUSSING',
      'NEGOTIATING',
      'AWAITING_EMG',
      'AWAITING_BRAND',
      'AWAITING_CREATOR',
    ]),
    active = count(['CONFIRMED']);
  const lastChecked = brands.rows
    .map((row) => row.checkedAt)
    .filter((value): value is Date => value !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const waiting = latest.filter((g) => g.update.stage === 'AWAITING_CREATOR').length;
  const recent = [...latest]
    .sort((a, b) => (b.update.evidenceAt?.getTime() ?? 0) - (a.update.evidenceAt?.getTime() ?? 0))
    .slice(0, 3);
  const needs = tasks.ok ? tasks.value.filter((t) => t.bucket === 'NEEDS_ATTENTION') : [];
  return (
    <LoopPage label="Creator Home">
      <CreatorUpdatesRefresh />
      <CreatorPageHead
        section={`${time.greeting()}, ${seat.displayName.split(/\s+/)[0]}.`}
        title="Your business. In view."
        description="A clear view of what EMG is working on for you, and what needs you next."
        actions={
          <>
            <span className="ch-last-updated">
              {lastChecked
                ? `Last updated: ${time.dateTime(lastChecked)}`
                : 'Awaiting first review'}
            </span>
            <CreatorRefreshButton />
          </>
        }
      />
      <section
        className={`ch-business-hero${media ? ' ch-business-hero--photo' : ''}`}
        aria-label="Your EMG briefing"
      >
        <div>
          <span className="ch-eyebrow">Your EMG briefing</span>
          <h2>Your EMG briefing</h2>
          {brands.available ? (
            <>
              <p>
                {conversations
                  ? `${conversations} brand ${conversations === 1 ? 'conversation is' : 'conversations are'} underway.`
                  : 'Your team’s shared brand activity appears here.'}
              </p>
              <p>
                {waiting
                  ? `${waiting} ${waiting === 1 ? 'conversation needs' : 'conversations need'} your attention.`
                  : 'No brand conversation is currently marked as waiting on you.'}
              </p>
              {active ? (
                <p>
                  {active} agreed {active === 1 ? 'partnership' : 'partnerships'} in progress.
                </p>
              ) : null}
            </>
          ) : (
            <p>Brand updates could not be loaded. Your saved activity has not been removed.</p>
          )}
          <Link href={CREATOR_HREFS.opportunities}>View partnerships →</Link>
        </div>
        {media ? (
          <a
            href={media.portraitSource}
            target="_blank"
            rel="noreferrer"
            aria-label="Your creator photo on Instagram"
          >
            <img src={media.portrait} alt={seat.displayName} fetchPriority="high" />
          </a>
        ) : null}
      </section>
      <section className="ch-business-rail" aria-label="Partnership activity">
        {[
          ['Outreach', outreach],
          ['Conversations', conversations],
          ['Active partnerships', active],
        ].map(([label, value]) => (
          <Link key={label} href={CREATOR_HREFS.opportunities}>
            <span>{label}</span>
            <strong>{brands.available ? value : '—'}</strong>
          </Link>
        ))}
      </section>
      {brands.incomplete ? (
        <p className="loop-note">
          Some brand sources could not be loaded; this overview may be incomplete.
        </p>
      ) : null}
      <div className="ch-business-grid">
        <section aria-label="Latest from your team">
          <header className="ch-section-head">
            <h2>Latest from your team</h2>
            <Link href={CREATOR_HREFS.opportunities}>View all →</Link>
          </header>
          {recent.length ? (
            <ul className="ch-team-updates">
              {recent.map(({ id, brand, update }) => (
                <li key={id}>
                  <span className="ch-brand-monogram">{brand.slice(0, 1)}</span>
                  <div>
                    <strong>{brand}</strong>
                    <p>{update.summary}</p>
                    <small>
                      {update.evidenceAt ? time.date(update.evidenceAt) : 'Source date unavailable'}
                      {update.current ? '' : ' · Awaiting updated review'}
                    </small>
                  </div>
                  <Link
                    href={`${CREATOR_HREFS.opportunities}?stage=${creatorBrandStageKey(update.stage)}&brand=${encodeURIComponent(id)}`}
                  >
                    View update →
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <StateBlock
              kind={brands.available ? 'empty' : 'error'}
              compact
              title={brands.available ? 'No updates shared yet.' : 'Updates are unavailable.'}
              body="Your team’s accepted brand summaries will appear here."
            />
          )}
        </section>
        <section aria-label="Up next">
          <header className="ch-section-head">
            <h2>Up next</h2>
            <Link href={CREATOR_HREFS.tasks}>All tasks →</Link>
          </header>
          {!tasks.ok ? (
            <StateBlock
              kind="error"
              compact
              title="Tasks could not be read."
              body="Try again shortly; this does not mean your task list is empty."
            />
          ) : needs.length ? (
            <TaskList tasks={needs.slice(0, 3)} time={time} />
          ) : (
            <StateBlock
              kind="empty"
              compact
              title="You’re all caught up."
              body="Reviews and upcoming deliverables will appear here when they need you."
            />
          )}
          <Link className="ch-payment-link" href={CREATOR_HREFS.earnings}>
            <span>Payments</span>
            <strong>
              {balance ? moneyMinor(balance.availableMinor, balance.currency) : 'View balance'} →
            </strong>
          </Link>
        </section>
      </div>
      <footer className="ch-team-footer">
        <h2>Your EMG team</h2>
        <p>The people working on your business.</p>
        <span>Team contact details are not available in this view.</span>
      </footer>
      <p className="loop-note ch-home-coverage">
        Partnership counts reflect accepted, authorized records. Historical review may still be in
        progress. <Link href={CREATOR_HREFS.opportunities}>See coverage and history</Link>.
      </p>
    </LoopPage>
  );
}
