// What the creator pages read, bound to the seat (Creator Hub, 2026-09-22). SERVER ONLY.
//
// Thin loaders over the creator domain's read models, each taking the seat `requireCreator()`
// returned. Nothing here decides access: the read models filter to the seat's own profile, and a
// page has already stated its authority before it calls in. The media address is offered only
// when this deployment can serve one; otherwise the pages render their honest "not available".

import 'server-only';

import { headers } from 'next/headers';
import type { AnalyticsView, ContentNotice, ContentRecordView, Seat } from '@emgloop/database';
import type { RecordHrefs, RecordPerformanceRow } from '../app/app/creator/_parts/content-record-body';
import { CREATOR_HREFS, creatorDomain, type CreatorSeat } from './creator-runtime';
import { readMediaRuntime } from './media-runtime';

export function seatOf(seat: CreatorSeat): Seat {
  return { kind: 'CREATOR', actor: seat.actor };
}

function requestHost(): string | null {
  try {
    return headers().get('host');
  } catch {
    return null;
  }
}

/** The stable media address, or null when media storage is not configured on this deployment. */
export function mediaHrefIfConfigured(): ((versionId: string) => string) | null {
  return readMediaRuntime(process.env, requestHost()).state === 'CONFIGURED' ? CREATOR_HREFS.media : null;
}

/** Why uploads are unavailable here, or null when they are available. */
export function uploadsUnavailableReason(): string | null {
  const runtime = readMediaRuntime(process.env, requestHost());
  return runtime.state === 'CONFIGURED' ? null : runtime.reason;
}

export function recordHrefs(contentId: string): RecordHrefs {
  const record = CREATOR_HREFS.contentRecord(contentId);
  return {
    library: CREATOR_HREFS.content,
    record,
    requestEdit: CREATOR_HREFS.requestEdit(contentId),
    version: (versionId) => `${record}?v=${encodeURIComponent(versionId)}`,
    review: (versionId) => CREATOR_HREFS.review(contentId, versionId),
    publish: `${record}?publish=1`,
    opportunity: CREATOR_HREFS.opportunity,
  };
}

export interface OpenDeliverable {
  readonly id: string;
  readonly title: string;
  readonly campaignName: string;
  readonly dueAt: string | null;
}

/** The creator's deliverables that still have no content attached: what an upload can be for. */
export async function openDeliverables(seat: CreatorSeat): Promise<OpenDeliverable[]> {
  const campaigns = await creatorDomain().records.campaigns(seatOf(seat), seat.partyId);
  return campaigns.flatMap((c) => c.deliverables.filter((d) => !d.contentId && d.status !== 'COMPLETE').map((d) => ({ id: d.id, title: d.title, campaignName: c.name, dueAt: d.dueAt })));
}

export async function loadContentRecord(seat: CreatorSeat, contentId: string): Promise<ContentRecordView | null> {
  return creatorDomain().records.contentRecord(seatOf(seat), contentId);
}

export async function loadNotice(seat: CreatorSeat, record: ContentRecordView, now: Date): Promise<ContentNotice> {
  return creatorDomain().records.contentNotice(seatOf(seat), record, now);
}

/** This content's performance rows, from the creator's analytics read model. */
export function performanceFor(analytics: AnalyticsView, contentId: string): RecordPerformanceRow[] {
  return analytics.performance.filter((r) => r.contentId === contentId).map((r) => ({ id: r.id, platform: r.platform, windowStart: r.windowStart, windowEnd: r.windowEnd, metrics: r.metrics, source: r.source }));
}

export async function loadAnalytics(seat: CreatorSeat, filter: { platform?: string | null; days?: number | null } = {}): Promise<AnalyticsView> {
  return creatorDomain().records.analytics(seat.actor.organizationId, seat.profileId, filter);
}

/** `?refused=<reason>&detail=<text>` as the page renders it. */
export function refusedFrom(searchParams: Record<string, string | string[] | undefined>): { reason: string; detail: string | null } | null {
  const reason = searchParams.refused;
  if (typeof reason !== 'string' || reason === '') return null;
  const detail = searchParams.detail;
  return { reason, detail: typeof detail === 'string' && detail !== '' ? detail : null };
}
