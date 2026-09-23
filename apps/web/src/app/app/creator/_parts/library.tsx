// The Content library's cards and empty state (Creator Hub). PURE.
//
// A card is a projection of a LibraryItem: its name, kind, one lifecycle pill, the campaign it
// belongs to, and a thumbnail drawn from the latest READY version when media storage can
// serve it. No number is shown that a row does not hold.

import Link from 'next/link';
import type { LibraryItem } from '@emgloop/database';
import type { TimeView } from '@emgloop/shared';
import { formatSeconds } from '@emgloop/shared';
import { StateBlock } from '../../_loop-os/record';
import { CONTENT_STATE_TONES, Pill } from './vocabulary';

export const LIBRARY_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'videos', label: 'Videos' },
  { key: 'photos', label: 'Photos' },
  { key: 'production', label: 'In production' },
  { key: 'published', label: 'Published' },
] as const;
export type LibraryFilter = (typeof LIBRARY_FILTERS)[number]['key'];

export function libraryFilterOf(raw: string | null): LibraryFilter {
  return (LIBRARY_FILTERS.find((f) => f.key === raw)?.key ?? 'all') as LibraryFilter;
}

export function applyLibraryFilter(items: readonly LibraryItem[], filter: LibraryFilter): LibraryItem[] {
  switch (filter) {
    case 'videos':
      return items.filter((i) => i.kind === 'VIDEO');
    case 'photos':
      return items.filter((i) => i.kind === 'PHOTO');
    case 'production':
      return items.filter((i) => i.state === 'IN_PRODUCTION' || i.state === 'YOUR_REVIEW' || i.state === 'CHANGES_REQUESTED');
    case 'published':
      return items.filter((i) => i.state === 'PUBLISHED');
    default:
      return [...items];
  }
}

/** The thumbnail: the latest READY version, when storage can serve it; otherwise a neutral frame. */
export function MediaThumb({ item, mediaHref }: { item: Pick<LibraryItem, 'kind' | 'latestVersion' | 'title'>; mediaHref: ((versionId: string) => string) | null }) {
  const v = item.latestVersion;
  const ready = v !== null && v.uploadState === 'READY' && mediaHref !== null;
  const badge = item.kind === 'VIDEO' ? (v?.durationSeconds != null ? formatSeconds(v.durationSeconds) : 'Video') : 'Photo';
  return (
    <span className={`ch-thumb${ready ? '' : ' ch-thumb--empty'}`} data-thumb={ready ? 'media' : 'placeholder'}>
      {ready && item.kind === 'VIDEO' ? <video className="ch-thumb__el" preload="metadata" muted playsInline src={mediaHref!(v!.id)} aria-hidden="true" /> : null}
      {ready && item.kind === 'PHOTO' ? <img className="ch-thumb__el" src={mediaHref!(v!.id)} alt="" loading="lazy" /> : null}
      <b className="ch-thumb__badge">{badge}</b>
    </span>
  );
}

export function LibraryGrid({ items, time, mediaHref, recordHref }: { items: readonly LibraryItem[]; time: TimeView; mediaHref: ((versionId: string) => string) | null; recordHref: (id: string) => string }) {
  return (
    <ul className="ch-grid" aria-label="Your content">
      {items.map((item) => (
        <li key={item.id}>
          <Link className="ch-card" href={recordHref(item.id)} data-content-state={item.state}>
            <MediaThumb item={item} mediaHref={mediaHref} />
            <span className="ch-card__body">
              <span className="ch-card__title">{item.title}</span>
              <span className="ch-card__row">
                <Pill tone={CONTENT_STATE_TONES[item.state]} small>
                  {item.stateLabel}
                </Pill>
                {item.campaignName ? <span className="ch-chip">{item.campaignName}</span> : null}
              </span>
              <span className="ch-card__meta">Updated {time.relative(item.updatedAt)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function LibraryEmpty({ filtered }: { filtered: boolean }) {
  return filtered ? (
    <StateBlock kind="empty" title="Nothing matches this filter." body="Your other content is still here; pick another filter to see it." />
  ) : (
    <StateBlock kind="empty" title="No content yet." body="Upload a video or a photo and it appears here as a record you can send to EMG, review and publish." />
  );
}
