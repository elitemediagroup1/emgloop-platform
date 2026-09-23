// The EMG editing work view (edit-review handoff §3), rendered by BOTH Work OS detail pages
// when the work instance is a creator production. SERVER COMPONENT; the upload control is
// its one client leaf.
//
// THE SAME PRODUCTION, ON THE WORK OS DETAIL THE EDITOR ALREADY USES. It composes the EMG
// projection the record service returns -- every instruction set in order with its notes on
// the timeline, requested vs expected return as two facts, every version including EMG-only
// drafts, every comment with its visibility -- and adds the acts an editor takes here:
// upload-as-answer (the way an Edit step completes), a committed expected return (ADMIN),
// and a comment that is internal unless marked creator-visible.
//
// Nothing here decides who may act. The page passed the seat; the actions and the upload
// route re-check the session and the step before anything is written.

import Link from 'next/link';
import type { ContentRecordView, ProductionView, InstructionView, VersionView } from '@emgloop/database';
import { formatSeconds } from '@emgloop/shared';
import { Facts, Panel, StateBlock, SummaryStrip } from '../app/app/_loop-os/record';
import { Pill, RefusedBlock, firstNameOf, playLink, stepLine, turnaround } from '../app/app/admin/creator-hub/_shared';
import { viewerTime } from '../time/viewer-time';
import { EmgVersionUploader, type UploaderNote } from './_client/EmgVersionUploader';
import { addProductionCommentAction, setExpectedReturnAction } from './emg-actions';

export interface ProductionPanelProps {
  readonly view: { readonly record: ContentRecordView; readonly production: ProductionView };
  readonly actor: { readonly userId: string; readonly canActOnAnyStep: boolean };
  readonly workspace: 'ADMIN' | 'EMPLOYEE';
  readonly hrefs: {
    /** This work's own page: where the actions return to. */
    readonly work: string;
    /** The EMG projection of the content record, when this seat can open it. */
    readonly content: string | null;
    /** The creator's operating view, when this seat can open it. */
    readonly creator: string | null;
  };
  readonly media: { readonly state: 'CONFIGURED' } | { readonly state: 'NOT_CONFIGURED'; readonly reason: string };
  readonly refused?: string | undefined;
}

/** "Originated by … · Entered by …": two facts, never collapsed into one. */
export function provenanceLine(i: InstructionView): string {
  const entered = i.enteredBy?.name ?? 'someone';
  const originated =
    i.originatorKind === 'BRAND_RELAYED'
      ? `${i.originatorLabel ?? 'the brand'} (relayed)`
      : i.originatorKind === 'EMG'
        ? `EMG${i.originatorLabel ? ` · ${i.originatorLabel}` : ''}`
        : `${i.originatorLabel ?? entered} (creator)`;
  return `Originated by ${originated} · Entered by ${entered}`;
}

/** The newest instruction set nothing has answered yet, or null. */
export function openInstruction(production: ProductionView): InstructionView | null {
  return [...production.instructions].sort((a, b) => b.sequence - a.sequence).find((i) => i.answeredByVersionId === null) ?? null;
}

export function nextVersionLabel(record: ContentRecordView): string {
  const max = record.versions.reduce((m, v) => Math.max(m, v.number), 0);
  return `Edit v${max + 1}`;
}

function noteLine(n: InstructionView['notes'][number]): string {
  const range = n.untilSeconds != null ? `${formatSeconds(n.atSeconds)} – ${formatSeconds(n.untilSeconds)}` : formatSeconds(n.atSeconds);
  return `${range} · ${n.kind === 'KEEP' ? 'Keep' : 'Change'} · ${n.text}`;
}

/** One instruction set: its summary, provenance, and notes on the timeline (shared with the content record). */
export function InstructionSetItem({ i, time }: { i: InstructionView; time: ReturnType<typeof viewerTime> }) {
  const addressedOf = (noteId: string) => i.addressed.find((a) => a.noteId === noteId) ?? null;
  return (
    <li className="loop-stack" style={{ gap: 6 }}>
      <div>
        <strong>Set {i.sequence}</strong>
        {i.summary ? <span> · “{i.summary}”</span> : null}
        <span className="loop-table__muted"> · {time.dateTime(i.createdAt)}</span>
      </div>
      <p className="loop-note" style={{ margin: 0 }}>
        {provenanceLine(i)}
        {i.refersToVersionLabel ? ` · refers to ${i.refersToVersionLabel}` : ''}
        {i.requestedReturnAt ? ` · asked for ${time.dateTime(i.requestedReturnAt)}` : ''}
        {i.answeredByVersionLabel ? ` · answered by ${i.answeredByVersionLabel}${i.answeredAt ? ` (${time.dateTime(i.answeredAt)})` : ''}` : ' · not yet answered'}
      </p>
      {i.notes.length > 0 ? (
        <ul className="loop-stack" style={{ margin: 0, paddingLeft: 18, gap: 4 }}>
          {i.notes.map((n) => {
            const a = addressedOf(n.id);
            return (
              <li key={n.id}>
                {noteLine(n)}
                {i.answeredByVersionId ? (
                  <span className="loop-note">
                    {' '}
                    — {a?.addressed ? 'addressed' : 'not addressed'}
                    {a?.reply ? `: “${a.reply}”` : ''}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="loop-note" style={{ margin: 0 }}>No timestamped notes on this set.</p>
      )}
    </li>
  );
}

function VersionRow({ v, time }: { v: VersionView; time: ReturnType<typeof viewerTime> }) {
  return (
    <tr>
      <td data-label="Version">
        <span className="loop-table__strong">{v.label}</span>
        {!v.visibleToCreator ? (
          <>
            {' '}
            <Pill tone="neutral">EMG-only draft</Pill>
          </>
        ) : null}
      </td>
      <td data-label="Uploaded by">
        {v.uploadedBy?.name ?? 'Someone'} <span className="loop-table__muted">· {v.uploadedByKind === 'EMG' ? 'EMG' : 'creator'} · {time.dateTime(v.createdAt)}</span>
      </td>
      <td data-label="State">{v.uploadState === 'READY' ? <Pill tone="good">Ready</Pill> : v.uploadState === 'FAILED' ? <Pill tone="critical">Failed</Pill> : <Pill tone="neutral">Pending</Pill>}</td>
      <td data-label="Notes">
        {v.noteToCreator ? <span>To the creator: “{v.noteToCreator}”</span> : null}
        {v.internalNote ? (
          <span className="loop-note">
            {v.noteToCreator ? ' · ' : ''}
            <Pill tone="neutral">EMG only</Pill> {v.internalNote}
          </span>
        ) : null}
        {!v.noteToCreator && !v.internalNote ? <span className="loop-table__muted">—</span> : null}
      </td>
      <td data-label="Play">{playLink(v)}</td>
    </tr>
  );
}

export function ProductionPanel({ view, actor, workspace, hrefs, media, refused }: ProductionPanelProps) {
  const { record, production } = view;
  const time = viewerTime();
  const creatorFirst = firstNameOf(record.creator.displayName);
  const current = production.currentStep;
  const active = production.workStatus === 'active';
  const onEdit = active && current?.kind === 'EDIT';
  const onReview = active && current?.kind === 'REVIEW';
  const mine = current?.owner?.userId === actor.userId;
  const mayUpload = onEdit && (actor.canActOnAnyStep || mine);
  const open = openInstruction(production);
  const t = turnaround(production, time);
  const versions = [...record.versions].sort((a, b) => b.number - a.number);
  const instructions = [...production.instructions].sort((a, b) => a.sequence - b.sequence);
  const uploaderNotes: UploaderNote[] = (open?.notes ?? []).map((n) => ({ id: n.id, atSeconds: n.atSeconds, untilSeconds: n.untilSeconds ?? null, kind: n.kind, text: n.text }));

  return (
    <div className="loop-stack" data-production-panel>
      <RefusedBlock refused={refused} />

      <Panel title="Creator production">
        <Facts
          rows={[
            { label: 'Creator', value: hrefs.creator ? <Link className="loop-link" href={hrefs.creator}>{record.creator.displayName}</Link> : record.creator.displayName },
            { label: 'Content', value: hrefs.content ? <Link className="loop-link" href={hrefs.content}>{record.title}</Link> : record.title },
            { label: 'Production', value: `Production ${production.number} · ${production.kind.toLowerCase()}` },
            { label: 'Lineage', value: versions.length ? [...versions].reverse().map((v) => v.label).join(' · ') : null, unknownText: 'No version yet' },
            { label: 'Now', value: active ? stepLine(current) : production.workStatus === 'completed' ? 'Completed' : 'Cancelled' },
          ]}
        />
      </Panel>

      <SummaryStrip
        label="Turnaround"
        items={[
          { label: 'Requested return', value: t.requested, unknownText: 'Not asked for' },
          { label: 'Expected return', value: t.expected, unknownText: 'Not set yet' },
          { label: 'Waiting on', value: !active ? 'Nobody — finished' : onReview ? creatorFirst : current?.owner ? current.owner.name : null, unknownText: 'No owner yet' },
          { label: 'Answers next', value: open ? `Set ${open.sequence}` : null, unknownText: 'No open set' },
        ]}
      />

      {workspace === 'ADMIN' && active ? (
        <form action={setExpectedReturnAction} className="loop-btnrow" style={{ alignItems: 'flex-end' }} aria-label="Set expected return">
          <input type="hidden" name="workInstanceId" value={production.workInstanceId} />
          <input type="hidden" name="returnTo" value={hrefs.work} />
          <label className="loop-field">
            <span className="loop-label">Expected return (your local time)</span>
            <input className="loop-input" type="datetime-local" name="expectedReturnAt" />
          </label>
          <button className="loop-btn" type="submit">Set expected return</button>
        </form>
      ) : null}

      <Panel title="Instructions · in order">
        {instructions.length === 0 ? (
          <p className="loop-note">No instruction set on this production yet.</p>
        ) : (
          <ol className="loop-stack" style={{ margin: 0, paddingLeft: 18 }}>
            {instructions.map((i) => (
              <InstructionSetItem key={i.id} i={i} time={time} />
            ))}
          </ol>
        )}
      </Panel>

      <Panel title="Versions on this content">
        {versions.length === 0 ? (
          <p className="loop-note">No version has been uploaded yet.</p>
        ) : (
          <table className="loop-table" aria-label="Versions">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Uploaded by</th>
                <th scope="col">State</th>
                <th scope="col">Notes</th>
                <th scope="col">Play</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <VersionRow key={v.id} v={v} time={time} />
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={`Upload ${nextVersionLabel(record)}`} lead="Upload is how an Edit step is answered and completed. A draft stays EMG-only until it is sent.">
        {!active ? (
          <StateBlock kind="empty" compact title="This production is finished." body="Nothing more is expected on it. A new request starts a new production on the same content." />
        ) : onReview ? (
          <StateBlock kind="empty" compact title={`Waiting for ${creatorFirst}.`} body={`${creatorFirst} is reviewing the returned version. Uploading is closed until they approve it or ask for changes.`} />
        ) : mayUpload ? (
          <EmgVersionUploader
            workInstanceId={production.workInstanceId}
            returnTo={hrefs.work}
            creatorFirstName={creatorFirst}
            nextLabel={nextVersionLabel(record)}
            answers={open ? { label: `Set ${open.sequence}`, notes: uploaderNotes } : null}
            media={media}
          />
        ) : (
          <StateBlock
            kind="denied"
            compact
            title={current?.owner ? `This Edit step is assigned to ${current.owner.name}.` : 'This Edit step has no owner yet.'}
            body={current?.owner ? 'Only the assigned editor (or an administrator) can upload against it.' : 'An administrator can assign it, or upload against it directly.'}
          />
        )}
      </Panel>

      <Panel title="Comments">
        {production.comments.length === 0 ? (
          <p className="loop-note">No comments on this production yet.</p>
        ) : (
          <ul className="loop-stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {production.comments.map((c) => (
              <li key={c.id}>
                <span className="loop-table__strong">{c.by?.name ?? 'Someone'}</span>{' '}
                {c.visibility === 'creator_visible' ? <Pill tone="info">Visible to {creatorFirst}</Pill> : <Pill tone="neutral">Internal</Pill>}
                <span className="loop-table__muted"> · {time.dateTime(c.at)}</span>
                <div>{c.body}</div>
              </li>
            ))}
          </ul>
        )}
        <form action={addProductionCommentAction} className="loop-stack" style={{ marginTop: 12 }} aria-label="Add a comment">
          <input type="hidden" name="workInstanceId" value={production.workInstanceId} />
          <input type="hidden" name="returnTo" value={hrefs.work} />
          <textarea className="loop-textarea" name="body" rows={2} maxLength={4000} placeholder="Add a comment…" required />
          <div className="loop-btnrow" style={{ alignItems: 'center' }}>
            <select className="loop-select" name="visibility" defaultValue="internal" aria-label="Visibility" style={{ width: 'auto' }}>
              <option value="internal">Internal · EMG only</option>
              <option value="creator_visible">Visible to {creatorFirst}</option>
            </select>
            <button className="loop-btn" type="submit">Add comment</button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
