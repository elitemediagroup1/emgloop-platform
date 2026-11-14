import Link from 'next/link';
import { CreatorPageHead } from '../../../../creator/creator-page-head';
import {
  loadCreatorPublishedMedia,
  PublishedMediaGrid,
} from '../../../../creator/creator-published-media';
import { MEDIA_CONTENT_TYPES, MEDIA_SIZE_LIMITS } from '@emgloop/providers';
import { requireWorkspace } from '../../../../workspaces/guard';
import { CREATOR_HREFS, creatorDomain, requireCreator } from '../../../../creator/creator-runtime';
import {
  mediaHrefIfConfigured,
  openDeliverables,
  seatOf,
  uploadsUnavailableReason,
} from '../../../../creator/creator-data';
import { viewerTime } from '../../../../time/viewer-time';
import { LoopPage, Panel, StateBlock } from '../../_loop-os/record';
import { Uploader } from '../_client/Uploader';
import {
  LIBRARY_FILTERS,
  LibraryEmpty,
  LibraryGrid,
  applyLibraryFilter,
  libraryFilterOf,
} from '../_parts/library';
import { param } from '../_parts/vocabulary';

// The Content library (Creator Hub): every piece of this creator's content as a record, and the
// one place a new Original enters Loop.
//
// Authority first, then the seat: the CREATOR route authority, then the profile bound to this
// login. The library read model filters to that profile; nothing on this page names a creator.
// Uploads are offered only when this deployment has media storage; otherwise the control is an
// honest state, never a button that fails.

export const dynamic = 'force-dynamic';

const ACCEPTED_TYPES = [...MEDIA_CONTENT_TYPES.image, ...MEDIA_CONTENT_TYPES.video];

export default async function CreatorContentPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const time = viewerTime();
  const filter = libraryFilterOf(param(searchParams.filter));
  const viewRaw = param(searchParams.view);
  const view = viewRaw === 'production' || viewRaw === 'review' ? viewRaw : 'published';
  const published = await loadCreatorPublishedMedia(seat);
  const query = (param(searchParams.q) ?? '').trim().slice(0, 100);
  const platform = param(searchParams.platform);
  const social = published.rows.filter(
    (v) =>
      (!platform || v.platform === platform) &&
      (!query || v.title.toLowerCase().includes(query.toLowerCase())),
  );
  const [items, deliverables] = await Promise.all([
    creatorDomain().records.library(seatOf(seat), seat.profileId),
    openDeliverables(seat),
  ]);
  const mediaHref = mediaHrefIfConfigured();
  const unavailable = uploadsUnavailableReason();
  const production = items.filter((i) => i.state !== 'PUBLISHED');
  const review = items.filter((i) => i.state === 'YOUR_REVIEW' || i.state === 'CHANGES_REQUESTED');
  const shown = applyLibraryFilter(
    view === 'review'
      ? review
      : view === 'production'
        ? production
        : items.filter((i) => i.state === 'PUBLISHED'),
    filter,
  );
  const wanted = param(searchParams.deliverable);
  const preselected = wanted && deliverables.some((d) => d.id === wanted) ? wanted : null;

  return (
    <LoopPage label="Content">
      <CreatorPageHead
        section="Content"
        title="Your work, all together."
        description=""
      />
      <nav className="ch-analytics-tabs" aria-label="Content workspace">
        <Link
          className="ch-analytics-tab"
          href={CREATOR_HREFS.content}
          aria-current={view === 'published' ? 'page' : undefined}
        >
          Published
        </Link>
        <Link
          className="ch-analytics-tab"
          href={`${CREATOR_HREFS.content}?view=production`}
          aria-current={view === 'production' ? 'page' : undefined}
        >
          In production · {production.length}
        </Link>
        <Link
          className="ch-analytics-tab"
          href={`${CREATOR_HREFS.content}?view=review`}
          aria-current={view === 'review' ? 'page' : undefined}
        >
          For review · {review.length}
        </Link>
      </nav>
      <div className="ch-content-layout">
        <aside className="ch-production-workspace">
          <h2>Production workspace</h2>
          <p>Upload an original and follow your work through production and review.</p>
          <details className="ch-upload-panel" open={!!preselected}>
            <summary>Upload an original</summary>

            <Panel title="Upload">
              {unavailable ? (
                <StateBlock
                  kind="unavailable"
                  compact
                  title="Uploads are not available on this deployment yet."
                  body={`${unavailable} Your existing content is unaffected.`}
                />
              ) : (
                <>
                  {preselected ? (
                    <p className="loop-panel__lead">
                      This upload is for {deliverables.find((d) => d.id === preselected)?.title}.
                    </p>
                  ) : null}
                  <Uploader
                    accept={ACCEPTED_TYPES.join(',')}
                    acceptedTypes={ACCEPTED_TYPES}
                    imageLimitBytes={MEDIA_SIZE_LIMITS.image}
                    videoLimitBytes={MEDIA_SIZE_LIMITS.video}
                    deliverables={deliverables.map((d) => ({
                      id: d.id,
                      title: d.title,
                      campaignName: d.campaignName,
                    }))}
                    preselectedDeliverableId={preselected}
                    recordBase={CREATOR_HREFS.content}
                  />
                </>
              )}
            </Panel>
          </details>
          <section className="ch-workflow-guide">
            <h3>How the workflow works</h3>
            <p>
              Upload an original to start production. Your team’s edits and review requests stay on
              the content record. Published social posts link to their platform.
            </p>
            <ol>
              <li>
                <strong>Original</strong>
                <span>Your uploaded content</span>
              </li>
              <li>
                <strong>Production &amp; review</strong>
                <span>Work with your EMG team</span>
              </li>
              <li>
                <strong>Published</strong>
                <span>Recorded published work</span>
              </li>
            </ol>
          </section>
        </aside>
        <section className="ch-content-main">
          {view === 'published' ? (
            <>
              <form className="ch-content-search" method="get">
                <label>
                  <span className="loop-label">Platform</span>
                  <select name="platform" defaultValue={platform ?? ''}>
                    <option value="">All imported platforms</option>
                    <option value="TIKTOK">TikTok</option>
                    <option value="YOUTUBE">YouTube</option>
                  </select>
                </label>
                <label>
                  <span className="loop-label">Find content</span>
                  <input
                    name="q"
                    defaultValue={query}
                    maxLength={100}
                    placeholder="Search your captions…"
                  />
                </label>
                <button className="loop-btn" type="submit">
                  Search
                </button>
              </form>
              {social.length ? (
                <PublishedMediaGrid items={social} time={time} />
              ) : (
                <StateBlock
                  kind="empty"
                  compact
                  title={
                    query
                      ? 'No imported posts match your search.'
                      : 'No published posts imported yet.'
                  }
                  body="Your authorized platform reports populate this collection."
                />
              )}
              {published.incomplete ? (
                <p className="loop-note">
                  One platform could not be read; this collection may be incomplete.
                </p>
              ) : null}
              <p className="loop-note">
                This collection contains videos returned by your latest TikTok and YouTube reports.
                It may not include every post.
              </p>
            </>
          ) : null}
          {view !== 'published' || shown.length > 0 ? (
            <>
              <nav className="loop-filters" aria-label="Filter content">
                {LIBRARY_FILTERS.map((f) => (
                  <Link
                    key={f.key}
                    className="loop-filter"
                    href={`${CREATOR_HREFS.content}?view=${view}&filter=${f.key}`}
                    aria-current={filter === f.key ? 'true' : undefined}
                  >
                    {f.label}
                  </Link>
                ))}
              </nav>
              <p className="loop-resultcount">
                {shown.length} of {items.length} piece{items.length === 1 ? '' : 's'}
              </p>
              {shown.length === 0 ? (
                <LibraryEmpty filtered={filter !== 'all' && items.length > 0} />
              ) : (
                <LibraryGrid
                  items={shown}
                  time={time}
                  mediaHref={mediaHref}
                  recordHref={CREATOR_HREFS.contentRecord}
                />
              )}
            </>
          ) : null}
        </section>
      </div>
    </LoopPage>
  );
}
