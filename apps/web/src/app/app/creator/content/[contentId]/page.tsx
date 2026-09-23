import { notFound } from 'next/navigation';
import { requireWorkspace } from '../../../../../workspaces/guard';
import { requireCreator } from '../../../../../creator/creator-runtime';
import { loadAnalytics, loadContentRecord, loadNotice, mediaHrefIfConfigured, performanceFor, recordHrefs, refusedFrom } from '../../../../../creator/creator-data';
import { viewerTime } from '../../../../../time/viewer-time';
import { settle } from '../../../_home/settle';
import { LoopPage, ReadFailed } from '../../../_loop-os/record';
import { ReviewSheet, type ReviewSheetProps } from '../../_client/ReviewSheet';
import { ContentRecordBody, selectVersion } from '../../_parts/content-record-body';
import { ContentActionBar, NoteForm, PublishForm } from '../../_parts/record-actions';
import { param } from '../../_parts/vocabulary';

// The Content Record page (Creator Hub, Mockup #1): guards and loads; the body is pure.
//
// The record comes from the creator read model, which returns null for content that is not this
// creator's (not-found, never forbidden). Every other source loads on its own: a notice or an
// analytics read that fails leaves its region honest and never takes the record down.
//   ?v=<versionId>       which version the preview shows (default: the latest finished one)
//   ?review=<versionId>  Review mode: the sheet over the record, only while the state is YOUR_REVIEW
//   ?publish=1           the small "mark as published" form for the selected version
//   ?refused=<reason>    a refusal the last action sent back, rendered as an attention block

export const dynamic = 'force-dynamic';

export default async function ContentRecordPage({ params, searchParams }: { params: { contentId: string }; searchParams: Record<string, string | string[] | undefined> }) {
  await requireWorkspace('CREATOR');
  const seat = await requireCreator();
  const record = await loadContentRecord(seat, params.contentId);
  if (!record) notFound();
  const time = viewerTime();
  const [noticeResult, analyticsResult] = await Promise.all([settle(() => loadNotice(seat, record!, time.now)), settle(() => loadAnalytics(seat))]);
  const hrefs = recordHrefs(record!.id);
  const mediaHref = mediaHrefIfConfigured();
  const selected = selectVersion(record!, param(searchParams.v));
  const performance = analyticsResult.ok ? performanceFor(analyticsResult.value, record!.id) : [];
  const reviewId = param(searchParams.review);
  const publish = param(searchParams.publish) === '1';

  let overlay: React.ReactNode = null;
  if (reviewId && record!.state === 'YOUR_REVIEW' && record!.actions.review) {
    const ready = record!.versions.filter((v) => v.uploadState === 'READY').sort((a, b) => b.number - a.number);
    const version = ready.find((v) => v.id === reviewId) ?? record!.latestVersion ?? null;
    if (version) {
      const previous = ready.find((v) => v.number < version.number) ?? null;
      const answered = record!.productions.flatMap((p) => p.instructions).find((i) => i.answeredByVersionId === version.id) ?? null;
      const media = (v: typeof version) => ({ id: v.id, label: v.label, mediaHref: mediaHref && v.uploadState === 'READY' ? mediaHref(v.id) : null, durationSeconds: v.durationSeconds });
      const props: ReviewSheetProps = {
        contentId: record!.id,
        contentTitle: record!.title,
        kind: record!.kind,
        version: media(version),
        previous: previous ? media(previous) : null,
        returnedBy: version.uploadedBy?.name ?? null,
        returnedAtText: time.dateTime(version.readyAt ?? version.createdAt),
        noteToCreator: version.noteToCreator,
        addressed: answered
          ? answered.notes.map((n) => {
              const mark = answered.addressed.find((a) => a.noteId === n.id) ?? null;
              return { atSeconds: n.atSeconds, kind: n.kind, text: n.text, addressed: mark?.addressed ?? false, reply: mark?.reply ?? null };
            })
          : [],
        previousLabel: answered?.refersToVersionLabel ?? previous?.label ?? null,
        requirements: record!.requirementStatuses.map((r) => ({ key: r.key, label: r.label, required: r.required, met: r.met, by: r.by })),
        deliverableTitle: record!.context.deliverable?.title ?? null,
        campaignName: record!.context.campaign?.name ?? null,
        requestedReturnText: record!.activeProduction?.requestedReturnAt ? time.dateTime(record!.activeProduction.requestedReturnAt) : null,
        productionNumber: record!.activeProduction?.number ?? null,
        closeHref: hrefs.record,
      };
      overlay = <ReviewSheet {...props} />;
    }
  } else if (publish) {
    overlay = <PublishForm record={record!} version={selected} time={time} cancelHref={hrefs.record} />;
  }

  return (
    <LoopPage label={record!.title}>
      <ContentRecordBody
        record={record!}
        time={time}
        mediaHref={mediaHref}
        notice={noticeResult.ok ? noticeResult.value : null}
        performance={performance}
        selectedVersionId={selected?.id ?? null}
        hrefs={hrefs}
        refused={refusedFrom(searchParams)}
        overlay={overlay}
        noteForm={<NoteForm record={record!} />}
        actionBar={<ContentActionBar record={record!} hrefs={hrefs} selected={selected} />}
      />
      {!noticeResult.ok ? <ReadFailed what="what Loop noticed about this content" /> : null}
    </LoopPage>
  );
}
