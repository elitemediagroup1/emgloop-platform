// Sources — the lightweight discovery listing.
//
// A listing answers ONE question: "what exists?" It is deliberately thin —
// search, a status filter, the key metrics, and a quick health indicator per
// row — and it never tells a source's story. That story lives on the entity
// page (sources/[id]); the two never duplicate each other.
//
// Same data path as the entity page (loadDimensionWindows), so a row's key is
// exactly the key its detail page looks up. Search + filter are zero-JS GET
// params, so this stays a pure Server Component.

import Link from 'next/link';
import { CallGridNav } from '../_CallGridNav';
import { requireCrmContext } from '../../../../../crm/crm-data';
import { money, num, type EntityTone } from '../../../_loop-os';
import { loadDimensionWindows, rowTone, type DimRow } from '../callgrid-dimensions';

export const dynamic = 'force-dynamic';

const STATUS: { key: string; label: string; tone: EntityTone | 'all' }[] = [
  { key: 'all', label: 'All', tone: 'all' },
  { key: 'healthy', label: 'Healthy', tone: 'good' },
  { key: 'watch', label: 'Watch', tone: 'warn' },
  { key: 'at_risk', label: 'At risk', tone: 'crit' },
];

interface PageProps {
  searchParams?: { q?: string; status?: string };
}

export default async function SourcesListingPage({ searchParams }: PageProps) {
  const { organizationId: org } = await requireCrmContext();
  const windows = org ? await loadDimensionWindows(org, 'sources') : null;
  const current = windows?.current ?? null;
  const readFailed = !current || !current.ok;

  const q = (searchParams?.q ?? '').trim();
  const qLower = q.toLowerCase();
  const status = searchParams?.status ?? 'all';
  const statusTone = STATUS.find((s) => s.key === status)?.tone;

  const all = current?.rows ?? [];
  let rows: DimRow[] = all;
  if (qLower) rows = rows.filter((r) => (r.label || '').toLowerCase().includes(qLower));
  if (statusTone && statusTone !== 'all') rows = rows.filter((r) => rowTone(r) === statusTone);

  const summary = readFailed
    ? 'Loop could not reach source data right now.'
    : all.length === 0
      ? 'No sources have attributed calls in the last 7 days yet.'
      : `${num(all.length)} source${all.length === 1 ? '' : 's'} · ${num(current!.totalCalls)} calls · ${money(current!.totalRevenueCents)} over the last 7 days.`;

  function statusHref(key: string): string {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (key !== 'all') p.set('status', key);
    const s = p.toString();
    return '/app/admin/marketplace/sources' + (s ? '?' + s : '');
  }

  return (
    <div className="loop-os loop-os--v3 loop-os--v4 loop-os--v5">
      <main className="loop-os__main">
        <header className="loop-os__brief">
          <div className="loop-os__brief-main">
            <p className="loop-os__brief-lead">CallGrid Intelligence</p>
            <h1 className="loop-os__brief-title">Sources</h1>
            <p className="loop-os__brief-body">{summary}</p>
          </div>
        </header>

        <CallGridNav active="sources" />

        <div className="cg-toolbar">
          <form className="cg-search" method="get">
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Search sources…"
              className="cg-search__input"
              aria-label="Search sources"
            />
            {status !== 'all' ? <input type="hidden" name="status" value={status} /> : null}
            <button type="submit" className="cg-search__btn">Search</button>
          </form>
          <div className="cg-filters" role="group" aria-label="Filter by status">
            {STATUS.map((s) => (
              <Link
                key={s.key}
                href={statusHref(s.key)}
                className={'cg-filter' + (status === s.key ? ' is-active' : '')}
                aria-current={status === s.key ? 'true' : undefined}
              >
                {s.tone !== 'all' ? <span className={'cg-dot cg-dot--' + s.tone} aria-hidden="true" /> : null}
                {s.label}
              </Link>
            ))}
          </div>
        </div>

        <div className="loop-card">
          <div className="loop-card__head">
            <span className="loop-card__title">
              Sources <span className="loop-count">{num(rows.length)}</span>
            </span>
          </div>

          {rows.length === 0 ? (
            <div className="loop-empty">
              <p className="loop-empty__title">
                {readFailed ? 'Source data is unavailable' : q || status !== 'all' ? 'No sources match' : 'No sources yet'}
              </p>
              <p className="loop-empty__body">
                {readFailed
                  ? 'Loop is showing you nothing rather than a list built on data it could not confirm.'
                  : q || status !== 'all'
                    ? 'Try clearing the search or the status filter.'
                    : 'Sources appear here as CallGrid routes inbound calls with source context.'}
              </p>
            </div>
          ) : (
            <ul className="cg-list">
              <li className="cg-list__labels" aria-hidden="true">
                <span className="cg-list__lname">Source</span>
                <span className="cg-list__lmetric">Calls</span>
                <span className="cg-list__lmetric">Revenue</span>
                <span className="cg-list__lmetric">Margin</span>
              </li>
              {rows.map((r) => {
                const tone = rowTone(r);
                return (
                  <li key={r.key} className="cg-row">
                    <Link href={'/app/admin/marketplace/sources/' + encodeURIComponent(r.key)} className="cg-row__link">
                      <span className={'cg-dot cg-dot--' + tone} aria-hidden="true" title={tone} />
                      <span className="cg-row__name">{r.label || 'Unlabelled source'}</span>
                      <span className="cg-row__metric">{num(r.calls)}</span>
                      <span className="cg-row__metric">{money(r.revenueCents)}</span>
                      <span className={'cg-row__metric' + (r.marginCents < 0 ? ' cg-row__metric--crit' : '')}>{money(r.marginCents)}</span>
                      <span className="cg-row__arrow" aria-hidden="true">→</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
