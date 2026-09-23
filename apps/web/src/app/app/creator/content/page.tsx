import Link from 'next/link';
import { MEDIA_CONTENT_TYPES, MEDIA_SIZE_LIMITS } from '@emgloop/providers';
import { requireWorkspace } from '../../../../workspaces/guard';
import { CREATOR_HREFS, creatorDomain, requireCreator } from '../../../../creator/creator-runtime';
import { mediaHrefIfConfigured, openDeliverables, seatOf, uploadsUnavailableReason } from '../../../../creator/creator-data';
import { viewerTime } from '../../../../time/viewer-time';
import { LoopPage, PageHead, Panel, StateBlock } from '../../_loop-os/record';
import { Uploader } from '../_client/Uploader';
import { LIBRARY_FILTERS, LibraryEmpty, LibraryGrid, applyLibraryFilter, libraryFilterOf } from '../_parts/library';
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

export default async function CreatorContentPage({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const time = viewerTime();
  const filter = libraryFilterOf(param(searchParams.filter));
  const [items, deliverables] = await Promise.all([creatorDomain().records.library(seatOf(seat), seat.profileId), openDeliverables(seat)]);
  const mediaHref = mediaHrefIfConfigured();
  const unavailable = uploadsUnavailableReason();
  const shown = applyLibraryFilter(items, filter);
  const wanted = param(searchParams.deliverable);
  const preselected = wanted && deliverables.some((d) => d.id === wanted) ? wanted : null;

  return (
    <LoopPage label="Content">
      <PageHead trail={[{ label: 'Creator' }, { label: 'Content' }]} title="Content" subtitle="Every piece you have uploaded, as a record: where it fits, what is happening to it, and what came of it." />

      <Panel title="Upload">
        {unavailable ? (
          <StateBlock kind="unavailable" compact title="Uploads are not available on this deployment yet." body={`${unavailable} Your existing content is unaffected.`} />
        ) : (
          <>
            {preselected ? <p className="loop-panel__lead">This upload is for {deliverables.find((d) => d.id === preselected)?.title}.</p> : null}
            <Uploader
              accept={ACCEPTED_TYPES.join(',')}
              acceptedTypes={ACCEPTED_TYPES}
              imageLimitBytes={MEDIA_SIZE_LIMITS.image}
              videoLimitBytes={MEDIA_SIZE_LIMITS.video}
              deliverables={deliverables.map((d) => ({ id: d.id, title: d.title, campaignName: d.campaignName }))}
              preselectedDeliverableId={preselected}
              recordBase={CREATOR_HREFS.content}
            />
          </>
        )}
      </Panel>

      <nav className="loop-filters" aria-label="Filter content">
        {LIBRARY_FILTERS.map((f) => (
          <Link key={f.key} className="loop-filter" href={f.key === 'all' ? CREATOR_HREFS.content : `${CREATOR_HREFS.content}?filter=${f.key}`} aria-current={filter === f.key ? 'true' : undefined}>
            {f.label}
          </Link>
        ))}
      </nav>
      <p className="loop-resultcount">
        {shown.length} of {items.length} piece{items.length === 1 ? '' : 's'}
      </p>
      {shown.length === 0 ? <LibraryEmpty filtered={filter !== 'all' && items.length > 0} /> : <LibraryGrid items={shown} time={time} mediaHref={mediaHref} recordHref={CREATOR_HREFS.contentRecord} />}
    </LoopPage>
  );
}
