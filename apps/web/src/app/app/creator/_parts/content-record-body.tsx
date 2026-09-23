// The Content Record (Creator Hub, Mockup #1 revision 2). PURE.
//
// ONE RECORD, EIGHT REGIONS, IN THE ORDER A CREATOR NEEDS THEM -- ALWAYS:
//   1 trail · title · state pill + the fact that put it there
//   2 media preview (a Version, never "the file"), with the version segmented control
//   3 Where this fits: campaign, deliverable, opportunity, and the deliverable's own checklist
//   4 Production: the current cycle projected from Work OS; completed cycles as one line each
//   5 Versions: the immutable lineage as a strip, the full history behind one disclosure
//   6 What Loop noticed: the epistemic ladder (notice-panel.tsx)
//   7 After publishing: publications and performance, or an honest "nothing yet"
//   8 the state-dependent action bar (handed in by the page, which owns the server actions)
//
// Regions never move. Every projected panel names its source (the campaign, the production,
// the platform). Nothing here is the record's own truth except the lineage and the title.
// PURE: no I/O, no clock (the TimeView is passed in), and no runtime import from the database
// package, so the page test can render it from a fixture without a session.

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ContentNotice, ContentRecordView, PersonRef, ProductionView, VersionView } from '@emgloop/database';
import type { TimeView } from '@emgloop/shared';
import { EVIDENCE_SOURCE_LABELS, SOCIAL_PLATFORM_LABELS, formatSeconds } from '@emgloop/shared';
import { ActivityList, type ActivityEntry } from '../../_loop-os/activity-item';
import { ContextDrawer, Facts, PageHead, Panel, StateBlock, SummaryStrip, type FactRow } from '../../_loop-os/record';
import { CreatorNoticePanel } from './notice-panel';
import { CONTENT_STATE_TONES, Pill, compactNumber, refusalText } from './vocabulary';

export interface RecordHrefs {
  readonly library: string;
  readonly record: string;
  readonly requestEdit: string;
  readonly version: (versionId: string) => string;
  readonly review: (versionId: string) => string;
  readonly publish: string;
  readonly opportunity: (id: string) => string;
}

/** A performance row for THIS content (AnalyticsView['performance'] narrowed). */
export interface RecordPerformanceRow {
  readonly id: string;
  readonly platform: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly metrics: Record<string, number>;
  readonly source: string;
}

export interface ContentRecordBodyProps {
  record: ContentRecordView;
  time: TimeView;
  /** Null: media storage is not configured on this deployment, so no version can be played. */
  mediaHref: ((versionId: string) => string) | null;
  notice: ContentNotice | null;
  performance: readonly RecordPerformanceRow[];
  selectedVersionId: string | null;
  hrefs: RecordHrefs;
  /** Region 8, built by the page (it owns the server actions). */
  actionBar: ReactNode;
  /** The "Add a note" form for an active production, built by the page. */
  noteForm?: ReactNode;
  refused?: { reason: string; detail: string | null } | null;
  /** Anything the page places between the title and the media (a publish form, a review sheet). */
  overlay?: ReactNode;
}

// ---- words ---------------------------------------------------------------------------------------

export function platformLabel(platform: string): string {
  return (SOCIAL_PLATFORM_LABELS as Record<string, string>)[platform] ?? platform;
}

function isYou(ref: PersonRef | null, record: ContentRecordView): boolean {
  return ref !== null && record.creator.userId !== null && ref.userId === record.creator.userId;
}

function who(ref: PersonRef | null, record: ContentRecordView, capital = false): string {
  if (!ref) return 'EMG';
  if (isYou(ref, record)) return capital ? 'You' : 'you';
  return ref.name;
}

function num(metrics: Record<string, number>, key: string): number | null {
  const v = metrics[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readyVersions(record: ContentRecordView): VersionView[] {
  return [...record.versions].filter((v) => v.uploadState === 'READY').sort((a, b) => a.number - b.number);
}

export function selectVersion(record: ContentRecordView, wanted: string | null): VersionView | null {
  const visible = record.versions;
  if (wanted) {
    const hit = visible.find((v) => v.id === wanted);
    if (hit) return hit;
  }
  return record.latestVersion ?? [...visible].sort((a, b) => b.number - a.number)[0] ?? null;
}

function latestInstruction(production: ProductionView | null) {
  if (!production) return null;
  return [...production.instructions].sort((a, b) => b.sequence - a.sequence)[0] ?? null;
}

/** The fact beside the pill: what put the record in this state, in the words of the mockup's title row. */
export function headerFact(record: ContentRecordView, time: TimeView, views: number | null): string {
  const latest = record.latestVersion;
  switch (record.state) {
    case 'RAW': {
      const original = record.versions.find((v) => v.number === 0) ?? null;
      if (!original) return 'No upload yet';
      if (original.uploadState !== 'READY') return original.uploadState === 'FAILED' ? 'Original · upload failed' : 'Original · still uploading';
      return `Original · ${who(original.uploadedBy, record)} · ${time.dateTime(original.readyAt ?? original.createdAt)}`;
    }
    case 'IN_PRODUCTION': {
      const editor = record.activeProduction?.currentStep?.owner ?? null;
      return editor ? `With EMG · ${editor.name} is editing` : 'With EMG · waiting for an editor';
    }
    case 'YOUR_REVIEW':
      return latest ? `${latest.label} · returned ${time.dateTime(latest.readyAt ?? latest.createdAt)}${latest.uploadedBy ? ` by ${who(latest.uploadedBy, record)}` : ''}` : 'Ready for your review';
    case 'CHANGES_REQUESTED': {
      const instruction = latestInstruction(record.activeProduction);
      if (instruction?.originatorKind === 'BRAND_RELAYED') return `Brand feedback via EMG · ${time.dateTime(instruction.createdAt)}`;
      if (instruction?.originatorKind === 'EMG') return `Requested by EMG · ${time.dateTime(instruction.createdAt)}`;
      return 'By you · back with EMG';
    }
    case 'APPROVED_BY_YOU': {
      const judged = record.judgedVersion ?? latest;
      const mark = judged?.approvals.find((a) => a.requirementKey === 'creator') ?? null;
      const waiting = record.requirementStatuses.filter((r) => r.required && !r.met && r.key !== 'published').map((r) => r.label);
      return [judged?.label ?? 'Approved', mark ? time.dateTime(mark.at) : null, waiting.length ? `waiting for ${waiting.join(', ')}` : null].filter(Boolean).join(' · ');
    }
    case 'FINAL': {
      const judged = record.judgedVersion ?? latest;
      const by = (judged?.approvals ?? []).map((a) => (a.approverKind === 'CREATOR' ? 'you' : a.approverKind === 'EMG' ? 'EMG' : a.originatorLabel ?? 'the brand'));
      return `${judged?.label ?? 'Final'} · approved by ${by.join(', ') || 'nobody yet'}`;
    }
    case 'PUBLISHED': {
      const pub = record.versions.flatMap((v) => v.publications)[0] ?? null;
      const parts = [pub ? platformLabel(pub.platform) : 'Published', pub ? time.dateTime(pub.at) : null, views !== null ? `${compactNumber(views)} views` : null];
      return parts.filter(Boolean).join(' · ');
    }
  }
}

// ---- history -------------------------------------------------------------------------------------

/** The full chain, from the rows the record projects. Every entry says who acted and when; nothing is inferred. */
export function historyEntries(record: ContentRecordView, time: TimeView): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const at = (iso: string) => ({ when: time.dateTime(iso), whenIso: iso });
  const versionByProduction = new Map(record.productions.map((p) => [p.workInstanceId, p.number]));

  for (const v of record.versions) {
    const when = v.readyAt ?? v.createdAt;
    const evidence: FactRow[] = [
      { label: 'Version', value: v.label },
      { label: 'By', value: who(v.uploadedBy, record, true) },
      { label: 'Length', value: v.durationSeconds != null ? formatSeconds(v.durationSeconds) : null, unknownText: v.kind === 'ORIGINAL' && record.kind === 'PHOTO' ? 'A photo' : 'Not read from the file' },
      { label: 'Upload', value: v.uploadState === 'READY' ? 'Finished' : v.uploadState === 'FAILED' ? 'Failed' : 'Still uploading' },
    ];
    if (v.noteToCreator) evidence.push({ label: 'Note to you', value: v.noteToCreator });
    const productionNumber = v.producedByWorkInstanceId ? versionByProduction.get(v.producedByWorkInstanceId) ?? null : null;
    if (productionNumber !== null) evidence.push({ label: 'Production', value: `Production ${productionNumber}` });
    out.push({
      key: `version:${v.id}`,
      category: 'WORK',
      story: v.kind === 'ORIGINAL' ? `Original uploaded by ${who(v.uploadedBy, record)}` : `${v.label} returned by ${who(v.uploadedBy, record)}`,
      ...at(when),
      evidence,
    });
    for (const a of v.approvals) {
      const story =
        a.approverKind === 'CREATOR'
          ? `${who(a.by, record, true)} approved ${v.label}`
          : a.approverKind === 'EMG'
            ? `EMG approved ${v.label}`
            : `${a.originatorLabel ?? 'The brand'} approved ${v.label}`;
      out.push({
        key: `approval:${v.id}:${a.requirementKey}`,
        category: 'DECISION',
        story,
        ...at(a.at),
        evidence: [
          { label: 'Requirement', value: a.requirementKey },
          { label: 'Originated by', value: a.approverKind === 'BRAND_RELAYED' ? a.originatorLabel ?? 'The brand (relayed)' : a.approverKind === 'EMG' ? 'EMG' : 'You' },
          { label: 'Entered by', value: a.by ? a.by.name : null, unknownText: 'Not recorded' },
          { label: 'Note', value: a.note, unknownText: 'None' },
        ],
      });
    }
    for (const p of v.publications) {
      out.push({
        key: `publication:${p.id}`,
        category: 'STATE_CHANGE',
        story: `${who(p.by, record, true)} marked ${v.label} published on ${platformLabel(p.platform)}`,
        ...at(p.at),
        evidence: [
          { label: 'Platform', value: platformLabel(p.platform) },
          { label: 'Link', value: p.url ? <a href={p.url} rel="noreferrer noopener">{p.url}</a> : null, unknownText: 'No link recorded' },
        ],
      });
    }
  }

  for (const p of record.productions) {
    // The instruction that opened the production tells the story of its start (below); only a
    // production with no visible opening instruction gets a line of its own.
    if (!p.instructions.some((i) => i.sequence === 1)) {
      out.push({
        key: `production:${p.id}:start`,
        category: 'STATE_CHANGE',
        story: `Production ${p.number} started`,
        ...at(p.createdAt),
        evidence: [
          { label: 'Requested by', value: who(p.requestedBy, record, true) },
          { label: 'On', value: record.versions.find((v) => v.id === p.sourceVersionId)?.label ?? null, unknownText: 'A version you cannot see' },
          { label: 'You asked for', value: p.requestedReturnAt ? time.dateTime(p.requestedReturnAt) : null, unknownText: 'No date asked for' },
        ],
      });
    }
    if (p.expectedReturnAt && p.expectedReturnSetAt) {
      out.push({
        key: `production:${p.id}:expected`,
        category: 'STATE_CHANGE',
        story: `EMG set the expected return: ${time.dateTime(p.expectedReturnAt)}`,
        ...at(p.expectedReturnSetAt),
        evidence: [
          { label: 'Set by', value: p.expectedReturnSetBy?.name ?? null, unknownText: 'Not recorded' },
          { label: 'Production', value: `Production ${p.number}` },
        ],
      });
    }
    for (const i of p.instructions) {
      const refers = i.refersToVersionLabel ?? 'a version';
      const opened = i.sequence === 1 ? ` — Production ${p.number} started` : '';
      const story =
        i.originatorKind === 'CREATOR'
          ? i.sequence === 1
            ? `You asked EMG for an edit${opened}`
            : `You requested changes to ${refers}`
          : i.originatorKind === 'BRAND_RELAYED'
            ? `${i.originatorLabel ?? 'The brand'} requested changes to ${refers} (relayed by ${i.enteredBy?.name ?? 'EMG'})${opened}`
            : `EMG added an instruction on ${refers}${opened}`;
      out.push({
        key: `instruction:${i.id}`,
        category: 'COMMUNICATION',
        story,
        ...at(i.createdAt),
        evidence: [
          { label: 'Originated by', value: i.originatorKind === 'CREATOR' ? 'You' : i.originatorKind === 'EMG' ? 'EMG' : i.originatorLabel ?? 'The brand' },
          { label: 'Entered by', value: who(i.enteredBy, record, true) },
          { label: 'Refers to', value: refers },
          { label: 'Summary', value: i.summary, unknownText: 'No summary' },
          { label: 'Notes', value: i.notes.length > 0 ? `${i.notes.length} timestamped note${i.notes.length === 1 ? '' : 's'}` : null, unknownText: 'None' },
          { label: 'Asked back by', value: i.requestedReturnAt ? time.dateTime(i.requestedReturnAt) : null, unknownText: 'No date asked for' },
          { label: 'Answered by', value: i.answeredByVersionLabel ? `${i.answeredByVersionLabel}${i.answeredAt ? ` · ${time.dateTime(i.answeredAt)}` : ''}` : null, unknownText: 'Not answered yet' },
        ],
      });
    }
    for (const c of p.comments) {
      out.push({
        key: `comment:${c.id}`,
        category: 'COMMUNICATION',
        story: `${who(c.by, record, true)} noted: ${c.body}`,
        ...at(c.at),
        evidence: [{ label: 'Production', value: `Production ${p.number}` }],
      });
    }
    if (p.completedAt) {
      out.push({
        key: `production:${p.id}:done`,
        category: 'STATE_CHANGE',
        story: `Production ${p.number} ${p.workStatus === 'cancelled' ? 'cancelled' : 'completed'}`,
        ...at(p.completedAt),
        evidence: [{ label: 'Production', value: `Production ${p.number}` }],
      });
    }
  }
  return out.sort((a, b) => (a.whenIso < b.whenIso ? -1 : a.whenIso > b.whenIso ? 1 : 0));
}

// ---- regions -------------------------------------------------------------------------------------

function MediaPreview({ record, version, mediaHref, hrefs }: { record: ContentRecordView; version: VersionView | null; mediaHref: ContentRecordBodyProps['mediaHref']; hrefs: RecordHrefs }) {
  const ready = readyVersions(record);
  const badge = version ? (record.kind === 'VIDEO' ? (version.durationSeconds != null ? formatSeconds(version.durationSeconds) : 'Video') : 'Photo') : null;
  return (
    <div className="ch-media" data-region="media">
      {ready.length > 1 ? (
        <nav className="ch-media__seg" aria-label="Which version to show">
          {ready.map((v) => (
            <Link key={v.id} href={hrefs.version(v.id)} aria-current={version?.id === v.id ? 'true' : undefined}>
              {v.kind === 'ORIGINAL' ? 'Original' : `v${v.number}`}
            </Link>
          ))}
        </nav>
      ) : null}
      {badge ? <b className="ch-media__badge">{badge}</b> : null}
      {!version ? (
        <div className="ch-media__frame">
          <StateBlock kind="empty" compact title="No version to show." body="The upload has not finished, so there is nothing to play yet." />
        </div>
      ) : version.uploadState !== 'READY' ? (
        <div className="ch-media__frame">
          <StateBlock
            kind={version.uploadState === 'FAILED' ? 'error' : 'empty'}
            compact
            title={version.uploadState === 'FAILED' ? `${version.label} failed to upload.` : `${version.label} is still uploading.`}
            body={version.uploadState === 'FAILED' ? 'The bytes never reached storage. Upload it again as new content.' : 'It appears here once the upload is confirmed.'}
          />
        </div>
      ) : !mediaHref ? (
        <div className="ch-media__frame">
          <StateBlock kind="unavailable" compact title="Preview unavailable on this deployment." body="Media storage is not configured here, so Loop cannot play a version. The record and its history are unaffected." />
        </div>
      ) : record.kind === 'VIDEO' ? (
        <video className="ch-media__el" controls playsInline preload="metadata" src={mediaHref(version.id)} aria-label={`${record.title} · ${version.label}`} />
      ) : (
        <img className="ch-media__el" src={mediaHref(version.id)} alt={`${record.title} · ${version.label}`} />
      )}
    </div>
  );
}

function RequirementChecklist({ record, time }: { record: ContentRecordView; time: TimeView }) {
  const d = record.context.deliverable;
  if (!d) return null;
  return (
    <ul className="ch-req" aria-label={`Needed for ${d.title}`}>
      <li className="ch-req__t">Needed for {d.title}</li>
      {record.requirementStatuses.map((r) => (
        <li key={r.key} className={r.met ? 'is-done' : ''} data-requirement={r.key} data-met={r.met ? 'true' : 'false'}>
          <i aria-hidden="true">{r.met ? '✓' : ''}</i>
          <span>
            {r.label}
            {!r.required ? <small> · optional</small> : null}
            {r.met ? (
              <small>
                {' '}
                · {r.by ?? 'recorded'}
                {r.versionLabel ? ` · ${r.versionLabel}` : ''}
                {r.at ? ` · ${time.dateTime(r.at)}` : ''}
              </small>
            ) : r.key === 'published' && d.dueAt ? (
              <small> · by {time.date(d.dueAt)}</small>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function WhereThisFits({ record, time, hrefs }: { record: ContentRecordView; time: TimeView; hrefs: RecordHrefs }) {
  const { campaign, deliverable, opportunity } = record.context;
  if (!campaign && !deliverable && !opportunity) {
    return (
      <Panel title="Where this fits">
        <StateBlock kind="empty" compact title="Not part of a campaign" body="Yours to publish or to send to EMG for an edit. EMG can attach it to a campaign later." />
      </Panel>
    );
  }
  const rows: FactRow[] = [
    {
      label: 'Campaign',
      value: campaign ? (
        <>
          {campaign.name}
          {campaign.brandLabel ? ` · ${campaign.brandLabel}` : ''}{' '}
          <Pill tone={campaign.state === 'ACTIVE' ? 'good' : campaign.state === 'ENDED' || campaign.state === 'CANCELLED' ? 'neutral' : 'info'} small>
            {campaign.state.charAt(0) + campaign.state.slice(1).toLowerCase()}
          </Pill>
        </>
      ) : null,
      unknownText: 'None',
    },
    {
      label: 'Deliverable',
      value: deliverable ? (
        <>
          {deliverable.title} · {deliverable.complete ? <Pill tone="good" small>Complete</Pill> : deliverable.line}
          {!deliverable.complete && deliverable.dueAt ? <span className="ch-fact"> · due {time.date(deliverable.dueAt)}</span> : null}
          {deliverable.acceptsUnedited && record.state === 'RAW' ? <span className="ch-fact"> · accepts an unedited original</span> : null}
        </>
      ) : null,
      unknownText: 'None',
    },
    {
      label: 'Opportunity',
      value: opportunity ? (
        <Link href={hrefs.opportunity(opportunity.id)}>
          {opportunity.title}
          {opportunity.label ? ` — ${opportunity.label}` : ''}
        </Link>
      ) : null,
      unknownText: 'None',
    },
  ];
  return (
    <Panel title="Where this fits">
      <Facts rows={rows} />
      <RequirementChecklist record={record} time={time} />
    </Panel>
  );
}

function notInProductionBody(record: ContentRecordView): string {
  const d = record.context.deliverable;
  if (!d) return 'Publish it as it is, or request an edit.';
  if (d.acceptsUnedited && record.state === 'RAW') return 'This deliverable accepts an unedited original. Submit it for approval, or request an edit first.';
  const needs = record.requirementStatuses.filter((r) => r.required && r.key !== 'creator' && r.key !== 'published').map((r) => r.label);
  return needs.length > 0 ? `This deliverable needs ${needs.join(' and ')} before it can be published. Request an edit to start production.` : 'Request an edit to start production.';
}

function ProductionPanel({ record, time, noteForm }: { record: ContentRecordView; time: TimeView; noteForm?: ReactNode }) {
  const active = record.activeProduction;
  const finished = record.productions.filter((p) => p.workStatus !== 'active').sort((a, b) => b.number - a.number);
  const rows: FactRow[] = [];
  if (active) {
    const step = active.currentStep;
    const latest = record.latestVersion;
    const instruction = latestInstruction(active);
    const stage = !step ? 'Waiting' : step.kind === 'REVIEW' ? 'Your review' : (step.round ?? 1) > 1 ? 'Editing again' : 'Editing';
    rows.push({ label: `Production ${active.number}`, value: `${stage}${step?.startedAt ? ` · started ${time.dateTime(step.startedAt)}` : ''}` });
    if (step?.kind === 'REVIEW' && latest) {
      rows.push({ label: 'Returned by', value: `${who(latest.uploadedBy, record, true)} · ${time.dateTime(latest.readyAt ?? latest.createdAt)}` });
      rows.push({ label: latest.uploadedBy ? `${latest.uploadedBy.name}'s note` : 'Note to you', value: latest.noteToCreator ? <q>{latest.noteToCreator}</q> : null, unknownText: 'No note' });
    } else {
      rows.push({ label: 'Editor', value: step?.owner ? step.owner.name : null, unknownText: 'Not assigned yet' });
      if (instruction) {
        if (instruction.originatorKind === 'BRAND_RELAYED') {
          rows.push({ label: 'From', value: `${instruction.originatorLabel ?? 'The brand'} · relayed by ${instruction.enteredBy?.name ?? 'EMG'} · ${time.dateTime(instruction.createdAt)}` });
        } else if (instruction.originatorKind === 'EMG') {
          rows.push({ label: 'From', value: `EMG · ${instruction.enteredBy?.name ?? ''} · ${time.dateTime(instruction.createdAt)}` });
        } else {
          rows.push({ label: 'Sent', value: time.dateTime(instruction.createdAt) });
        }
        rows.push({
          label: instruction.originatorKind === 'CREATOR' ? 'Your request' : 'Instruction',
          value: instruction.summary || instruction.notes.length > 0 ? <q>{[instruction.summary, instruction.notes.length > 0 ? `${instruction.notes.length} note${instruction.notes.length === 1 ? '' : 's'} on ${instruction.refersToVersionLabel ?? 'the version'}` : null].filter(Boolean).join(' · ')}</q> : null,
          unknownText: 'Nothing written',
        });
      }
    }
    rows.push({ label: 'You asked for', value: active.requestedReturnAt ? time.dateTime(active.requestedReturnAt) : null, unknownText: 'No date asked for' });
    rows.push({
      label: 'EMG expects',
      value: active.expectedReturnAt ? `${time.dateTime(active.expectedReturnAt)}${active.expectedReturnSetAt ? ` · set ${time.dateTime(active.expectedReturnSetAt)}` : ''}` : null,
      unknownText: 'Not set yet',
    });
  }
  for (const p of finished) {
    rows.push({ label: `Production ${p.number}`, value: p.workStatus === 'cancelled' ? 'Cancelled' : `Completed${p.completedAt ? ` · ${time.dateTime(p.completedAt)}` : ''}` });
  }
  const comments = active ? active.comments : [];
  return (
    <Panel title="Production">
      {rows.length > 0 ? <Facts rows={rows} /> : <StateBlock kind="empty" compact title="Not in production" body={notInProductionBody(record)} />}
      {!active && finished.length > 0 ? (
        <p className="loop-note" style={{ marginTop: 10 }}>
          Nothing in production. Request an edit starts Production {finished.length + 1} on the same versions.
        </p>
      ) : null}
      {comments.length > 0 ? (
        <ul className="ch-comments" aria-label="Notes on this production">
          {comments.map((c) => (
            <li key={c.id}>
              <span className="ch-comments__who">{who(c.by, record, true)}</span> <span className="ch-comments__when">{time.dateTime(c.at)}</span>
              <p className="ch-comments__body">{c.body}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {active && noteForm ? noteForm : null}
    </Panel>
  );
}

function VersionsPanel({ record, time, selected, hrefs }: { record: ContentRecordView; time: TimeView; selected: VersionView | null; hrefs: RecordHrefs }) {
  const versions = [...record.versions].sort((a, b) => a.number - b.number);
  const active = record.activeProduction;
  const expecting = active?.currentStep?.kind === 'EDIT';
  const judged = record.judgedVersion;
  const entries = historyEntries(record, time);
  const publications = record.versions.flatMap((v) => v.publications.map((p) => ({ ...p, versionLabel: v.label })));
  return (
    <Panel title="Versions">
      <div className="ch-vstrip" role="list" aria-label="Version lineage">
        {versions.map((v) => {
          const marks = v.approvals.length > 0 ? (record.state === 'FINAL' && judged?.id === v.id ? '★ Final' : `✓ ${v.approvals.map((a) => (a.approverKind === 'CREATOR' ? 'you' : a.approverKind === 'EMG' ? 'EMG' : 'brand')).join(' · ')}`) : null;
          const badge = v.uploadState !== 'READY' ? (v.uploadState === 'FAILED' ? 'Failed' : 'Uploading') : record.kind === 'VIDEO' ? (v.durationSeconds != null ? formatSeconds(v.durationSeconds) : 'Video') : 'Photo';
          return (
            <Link key={v.id} role="listitem" className={`ch-vchip${selected?.id === v.id ? ' is-on' : ''}`} href={hrefs.version(v.id)} aria-current={selected?.id === v.id ? 'true' : undefined}>
              <span className="ch-vchip__thumb">
                <b>{marks ?? badge}</b>
              </span>
              <span className="ch-vchip__l">{v.label}</span>
              <span className="ch-vchip__m">
                {who(v.uploadedBy, record, true)} · {time.monthDayTime(v.readyAt ?? v.createdAt)}
              </span>
            </Link>
          );
        })}
        {expecting ? (
          <span role="listitem" className="ch-vchip is-ghost" aria-label="The next edit, not returned yet">
            <span className="ch-vchip__thumb" />
            <span className="ch-vchip__l">Next edit</span>
            <span className="ch-vchip__m">{active?.expectedReturnAt ? `expected ${time.monthDayTime(active.expectedReturnAt)}` : 'no expected return yet'}</span>
          </span>
        ) : null}
        {publications.map((p) => (
          <span key={p.id} role="listitem" className="ch-vchip ch-vchip--post">
            <span className="ch-vchip__thumb">
              <b>{platformLabel(p.platform)}</b>
            </span>
            <span className="ch-vchip__l">Post</span>
            <span className="ch-vchip__m">{time.monthDayTime(p.at)}</span>
          </span>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <ContextDrawer summary={`Full history · ${entries.length} event${entries.length === 1 ? '' : 's'}`}>
          {entries.length === 0 ? <p className="loop-note">Nothing has happened to this record yet.</p> : <ActivityList entries={entries} label="History of this content" />}
        </ContextDrawer>
      </div>
    </Panel>
  );
}

function AfterPublishing({ record, time, performance }: { record: ContentRecordView; time: TimeView; performance: readonly RecordPerformanceRow[] }) {
  const publications = record.versions.flatMap((v) => v.publications.map((p) => ({ ...p, versionLabel: v.label })));
  const d = record.context.deliverable;
  const totals = performance.reduce(
    (acc, r) => {
      const views = num(r.metrics, 'views');
      const reach = num(r.metrics, 'reach');
      const eng = ['likes', 'comments', 'saves', 'shares'].map((k) => num(r.metrics, k)).filter((x): x is number => x !== null);
      return {
        views: views === null ? acc.views : (acc.views ?? 0) + views,
        reach: reach === null ? acc.reach : (acc.reach ?? 0) + reach,
        engagements: eng.length === 0 ? acc.engagements : (acc.engagements ?? 0) + eng.reduce((a, b) => a + b, 0),
      };
    },
    { views: null as number | null, reach: null as number | null, engagements: null as number | null },
  );
  const latestWindow = [...performance].sort((a, b) => (a.windowEnd < b.windowEnd ? 1 : -1))[0] ?? null;
  const sources = [...new Set(performance.map((r) => (r.source === 'SEEDED_DEMO' ? EVIDENCE_SOURCE_LABELS.SEEDED_DEMO : `from ${platformLabel(r.platform)}`)))];
  return (
    <Panel title="After publishing">
      {publications.length > 0 ? (
        <ul className="ch-pubs" aria-label="Publications">
          {publications.map((p) => (
            <li key={p.id}>
              <span className="loop-table__strong">{platformLabel(p.platform)}</span> · {p.versionLabel} · {time.dateTime(p.at)}
              {p.url ? (
                <>
                  {' '}
                  ·{' '}
                  <a href={p.url} rel="noreferrer noopener">
                    Open the post
                  </a>
                </>
              ) : (
                <span className="loop-note"> · no link recorded</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {performance.length > 0 ? (
        <>
          <SummaryStrip
            label="Performance"
            items={[
              { label: 'Views', value: totals.views === null ? null : compactNumber(totals.views), unknownText: 'Not reported' },
              { label: 'Reach', value: totals.reach === null ? null : compactNumber(totals.reach), unknownText: 'Not reported' },
              { label: 'Engagements', value: totals.engagements === null ? null : compactNumber(totals.engagements), unknownText: 'Not reported' },
            ]}
          />
          <p className="ch-rung__meta" style={{ marginTop: 8 }}>
            {performance.length} report{performance.length === 1 ? '' : 's'}
            {latestWindow ? ` · as of ${time.dateTime(latestWindow.windowEnd)}` : ''} · {sources.join(' · ')}
          </p>
        </>
      ) : publications.length > 0 ? (
        <StateBlock kind="empty" compact title="No performance yet" body="Reports appear here once your connected platform sends them or EMG records them." />
      ) : record.state === 'FINAL' ? (
        <StateBlock kind="attention" compact title={d?.dueAt ? `Publish by ${time.date(d.dueAt)}, then mark it published here` : 'Publish, then mark it published here'} body="Performance from your connected platforms appears here once the post is linked." />
      ) : record.state === 'APPROVED_BY_YOU' && d ? (
        <StateBlock kind="empty" compact title="Nothing yet" body={`This deliverable can be published once ${record.requirementStatuses.filter((r) => r.required && !r.met && r.key !== 'published').map((r) => r.label).join(' and ') || 'every requirement is met'}.`} />
      ) : (
        <StateBlock kind="empty" compact title="Nothing yet" body="Performance appears here after you publish and connect the post." />
      )}
    </Panel>
  );
}

// ---- the record ----------------------------------------------------------------------------------

export function ContentRecordBody(props: ContentRecordBodyProps) {
  const { record, time, hrefs, performance } = props;
  const selected = selectVersion(record, props.selectedVersionId);
  const views = performance.length > 0 ? performance.reduce((a, r) => a + (num(r.metrics, 'views') ?? 0), 0) : null;
  const fact = headerFact(record, time, views);
  const campaign = record.context.campaign;
  const refused = props.refused ? refusalText(props.refused.reason, props.refused.detail) : null;
  const publication = record.versions.flatMap((v) => v.publications)[0] ?? null;

  return (
    <>
      <PageHead trail={[{ label: 'Content', href: hrefs.library }, { label: campaign ? campaign.name : 'Independent content' }]} title={record.title} />
      <div className="ch-titlerow" data-region="state">
        <Pill tone={CONTENT_STATE_TONES[record.state]}>{record.stateLabel}</Pill>
        <span className="ch-fact">{fact}</span>
        {record.state === 'PUBLISHED' ? (
          <a className="ch-jump" href="#after-publishing">
            Jump to performance ↓
          </a>
        ) : null}
      </div>
      {refused ? <StateBlock kind="attention" compact title={refused.title} body={refused.body} /> : null}
      {props.overlay}

      <MediaPreview record={record} version={selected} mediaHref={props.mediaHref} hrefs={hrefs} />
      {record.state === 'PUBLISHED' && publication ? (
        <p className="ch-media__pub" data-region="published-summary">
          <b>{platformLabel(publication.platform)}</b> · {time.dateTime(publication.at)}
          {views !== null ? <b> · {compactNumber(views)} views</b> : <span> · no views reported yet</span>}
          {publication.url ? (
            <>
              {' '}
              ·{' '}
              <a href={publication.url} rel="noreferrer noopener">
                Open on {platformLabel(publication.platform)}
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      <div id="where-this-fits">
        <WhereThisFits record={record} time={time} hrefs={hrefs} />
      </div>
      <div id="production">
        <ProductionPanel record={record} time={time} noteForm={props.noteForm} />
      </div>
      <div id="versions">
        <VersionsPanel record={record} time={time} selected={selected} hrefs={hrefs} />
      </div>
      <div id="what-loop-noticed">
        <CreatorNoticePanel notice={props.notice} when={(iso) => time.dateTime(iso)} />
      </div>
      <div id="after-publishing">
        <AfterPublishing record={record} time={time} performance={performance} />
      </div>
      {props.actionBar}
    </>
  );
}
