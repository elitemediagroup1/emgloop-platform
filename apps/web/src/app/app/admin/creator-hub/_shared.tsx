// EMG Creator Operations: the words and pure views the creator-hub pages share
// (Creator Hub, 2026-09-22). Server components only; no data access here.
//
// Every page composes the domain's EMG projections; nothing here invents a value. What a
// projection cannot say is rendered as unknown, never as zero or a dash that reads as zero.

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { CreatorProfile, ProductionView, PersonRef } from '@emgloop/database';
import { CONTENT_STATE_LABELS, type ContentState, type TimeView } from '@emgloop/shared';
import { StateBlock } from '../../_loop-os/record';
import { CREATOR_HREFS, EMG_HREFS } from '../../../../creator/creator-runtime';

export const TRAIL = Object.freeze({
  operations: { label: 'Operations' },
  creators: { label: 'Creators', href: EMG_HREFS.creators },
});

/** What a `?refused=` reason means, in the reader's words. Unknown reasons say so. */
export function refusalText(reason: string): string {
  switch (reason) {
    case 'NOT_FOUND':
      return 'Loop could not find that record in your workspace, so nothing was changed.';
    case 'NOT_ALLOWED':
      return 'Your seat cannot take that action, so nothing was changed.';
    case 'NOT_YOUR_STEP':
      return 'That step is not assigned to you, so nothing was changed.';
    case 'VERSION_NOT_READY':
      return 'That version has not finished uploading, so nothing was recorded on it.';
    case 'NO_ACTIVE_PRODUCTION':
      return 'This content is not in production, so there is nothing to act on.';
    case 'PRODUCTION_ACTIVE':
      return 'This content is already in production.';
    case 'BAD_DATE':
      return 'That date and time could not be read, so nothing was changed.';
    case 'BAD_NOTES':
      return 'The notes were not in a shape Loop accepts, so nothing was recorded.';
    case 'NOT_A_CREATOR_LOGIN':
      return 'That login is not a creator login. Only an active login with the Creator role can be bound.';
    case 'INVALID':
      return 'Something the form needed was missing, so nothing was changed.';
    default:
      return 'The action was refused and nothing was changed.';
  }
}

export function RefusedBlock({ refused }: { refused: string | undefined }) {
  if (!refused) return null;
  return <StateBlock kind="attention" compact title="That action was refused." body={refusalText(refused)} />;
}

export const STATE_TONE: Record<ContentState, 'good' | 'attention' | 'critical' | 'neutral' | 'info'> = {
  RAW: 'neutral',
  IN_PRODUCTION: 'info',
  YOUR_REVIEW: 'attention',
  CHANGES_REQUESTED: 'attention',
  APPROVED_BY_YOU: 'good',
  FINAL: 'good',
  PUBLISHED: 'good',
};

/** The EMG reading of a content state: the creator-facing words say "your"; EMG reads "creator". */
export function emgStateLabel(state: ContentState): string {
  switch (state) {
    case 'YOUR_REVIEW':
      return 'Awaiting creator review';
    case 'APPROVED_BY_YOU':
      return 'Approved by the creator';
    default:
      return CONTENT_STATE_LABELS[state];
  }
}

export function ContentStatePill({ state }: { state: ContentState }) {
  return <span className={`loop-pill loop-pill--${STATE_TONE[state]}`}>{emgStateLabel(state)}</span>;
}

export function Pill({ tone, children }: { tone: 'good' | 'attention' | 'critical' | 'neutral' | 'info'; children: ReactNode }) {
  return <span className={`loop-pill loop-pill--${tone}`}>{children}</span>;
}

export function personName(p: PersonRef | null | undefined, fallback = 'No one yet'): string {
  return p?.name ?? fallback;
}

export function firstNameOf(displayName: string): string {
  const n = displayName.trim();
  return n ? n.split(/\s+/)[0]! : 'the creator';
}

export function creatorHandle(profile: Pick<CreatorProfile, 'handle'>): string | null {
  const h = (profile.handle ?? '').trim();
  return h ? (h.startsWith('@') ? h : `@${h}`) : null;
}

/** "Edit · round 2 — Sam K." or "Creator review — Denise" or "no owner yet". */
export function stepLine(step: ProductionView['currentStep']): string {
  if (!step) return 'No step in motion';
  return `${step.name} — ${step.owner ? step.owner.name : 'no owner yet'}`;
}

/** Requested vs expected return, as the two facts they are. */
export function turnaround(production: ProductionView, time: TimeView): { requested: string | null; expected: string | null } {
  return {
    requested: production.requestedReturnAt ? `${time.dateTime(production.requestedReturnAt)}${production.requestedBy ? ` · ${production.requestedBy.name}` : ''}` : null,
    expected: production.expectedReturnAt
      ? `${time.dateTime(production.expectedReturnAt)}${production.expectedReturnSetBy ? ` · set by ${production.expectedReturnSetBy.name}` : ''}`
      : null,
  };
}

// ---- the roster ----------------------------------------------------------------------------------

export interface RosterRow {
  readonly profile: CreatorProfile;
  readonly needsEmg: number;
  readonly needsCreator: number;
  readonly inProduction: number;
  readonly dueSoon: number;
  readonly contentCount: number;
}

export function RosterView({ rows }: { rows: readonly RosterRow[] }) {
  if (rows.length === 0) {
    return (
      <StateBlock
        kind="empty"
        title="No creators yet."
        body="A creator appears here once a creator profile exists in your workspace. Nothing is hidden by a filter."
      />
    );
  }
  return (
    <table className="loop-table" aria-label="Creators">
      <thead>
        <tr>
          <th scope="col">Creator</th>
          <th scope="col">Needs EMG</th>
          <th scope="col">Needs creator</th>
          <th scope="col">In production</th>
          <th scope="col">Due soon</th>
          <th scope="col">Content</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const handle = creatorHandle(r.profile);
          return (
            <tr key={r.profile.id}>
              <td data-label="Creator">
                <Link className="loop-link" href={EMG_HREFS.creator(r.profile.id)}>
                  {r.profile.displayName}
                </Link>
                {handle ? <span className="loop-table__muted"> · {handle}</span> : null}
              </td>
              <td data-label="Needs EMG">{r.needsEmg > 0 ? <Pill tone="attention">{r.needsEmg}</Pill> : <span className="loop-table__muted">0</span>}</td>
              <td data-label="Needs creator">{r.needsCreator > 0 ? <Pill tone="info">{r.needsCreator}</Pill> : <span className="loop-table__muted">0</span>}</td>
              <td data-label="In production">{r.inProduction}</td>
              <td data-label="Due soon">{r.dueSoon > 0 ? <Pill tone="attention">{r.dueSoon}</Pill> : <span className="loop-table__muted">0</span>}</td>
              <td data-label="Content">
                {r.contentCount} · <Link className="loop-link" href={EMG_HREFS.creator(r.profile.id)}>Open</Link>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ---- the requests lane ---------------------------------------------------------------------------

export interface RequestRow {
  readonly production: ProductionView;
  readonly contentId: string;
  readonly contentTitle: string;
  readonly creator: CreatorProfile;
  readonly needs: 'EMG' | 'CREATOR' | 'DONE';
}

export interface GroupedRequests {
  readonly needsEmg: readonly RequestRow[];
  readonly awaitingCreator: readonly RequestRow[];
  /** The most recently finished, newest first, capped. */
  readonly done: readonly RequestRow[];
}

export const DONE_LIMIT = 20;

const newestFirst = (a: RequestRow, b: RequestRow) => (b.production.completedAt ?? b.production.createdAt).localeCompare(a.production.completedAt ?? a.production.createdAt);
const oldestOpenFirst = (a: RequestRow, b: RequestRow) => a.production.createdAt.localeCompare(b.production.createdAt);

/** Pure: the lane's three groups from the service's rows. Open work oldest first; finished work newest first. */
export function groupRequests(rows: readonly RequestRow[]): GroupedRequests {
  return {
    needsEmg: rows.filter((r) => r.needs === 'EMG').sort(oldestOpenFirst),
    awaitingCreator: rows.filter((r) => r.needs === 'CREATOR').sort(oldestOpenFirst),
    done: rows.filter((r) => r.needs === 'DONE').sort(newestFirst).slice(0, DONE_LIMIT),
  };
}

function RequestTable({ rows, label, time }: { rows: readonly RequestRow[]; label: string; time: TimeView }) {
  return (
    <table className="loop-table" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">Creator</th>
          <th scope="col">Content</th>
          <th scope="col">Step</th>
          <th scope="col">Requested return</th>
          <th scope="col">Expected return</th>
          <th scope="col">Open</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const t = turnaround(r.production, time);
          return (
            <tr key={r.production.id}>
              <td data-label="Creator">
                <Link className="loop-link" href={EMG_HREFS.creator(r.creator.id)}>{r.creator.displayName}</Link>
              </td>
              <td data-label="Content">
                <span className="loop-table__strong">{r.contentTitle}</span>
                <span className="loop-table__muted"> · Production {r.production.number}</span>
              </td>
              <td data-label="Step">
                {r.production.workStatus === 'active' ? stepLine(r.production.currentStep) : r.production.workStatus === 'completed' ? 'Completed' : 'Cancelled'}
              </td>
              <td data-label="Requested return">{t.requested ?? <span className="loop-table__muted">Not asked</span>}</td>
              <td data-label="Expected return">{t.expected ?? <span className="loop-table__muted">Not set</span>}</td>
              <td data-label="Open">
                <Link className="loop-link" href={EMG_HREFS.adminWork(r.production.workInstanceId)}>Work</Link>
                {' · '}
                <Link className="loop-link" href={EMG_HREFS.creatorContent(r.creator.id, r.contentId)}>Content</Link>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function RequestsView({ groups, time }: { groups: GroupedRequests; time: TimeView }) {
  const total = groups.needsEmg.length + groups.awaitingCreator.length + groups.done.length;
  if (total === 0) {
    return (
      <StateBlock
        kind="empty"
        title="No production requests yet."
        body="A request appears here when a creator asks for an edit or brand feedback is relayed. Nothing is hidden by a filter."
      />
    );
  }
  return (
    <div className="loop-stack">
      <section className="loop-panel" aria-label="Needs EMG">
        <h2 className="loop-panel__title">Needs EMG <span className="loop-resultcount">{groups.needsEmg.length}</span></h2>
        {groups.needsEmg.length === 0 ? <p className="loop-note">Nothing is waiting on EMG.</p> : <RequestTable rows={groups.needsEmg} label="Needs EMG" time={time} />}
      </section>
      <section className="loop-panel" aria-label="Awaiting creator">
        <h2 className="loop-panel__title">Awaiting creator <span className="loop-resultcount">{groups.awaitingCreator.length}</span></h2>
        {groups.awaitingCreator.length === 0 ? <p className="loop-note">Nothing is waiting on a creator.</p> : <RequestTable rows={groups.awaitingCreator} label="Awaiting creator" time={time} />}
      </section>
      <section className="loop-panel" aria-label="Finished">
        <h2 className="loop-panel__title">Finished <span className="loop-resultcount">{groups.done.length}</span></h2>
        {groups.done.length === 0 ? <p className="loop-note">No production has finished yet.</p> : <RequestTable rows={groups.done} label="Finished" time={time} />}
        {groups.done.length === DONE_LIMIT ? <p className="loop-note">The {DONE_LIMIT} most recent. Older productions are on each content record.</p> : null}
      </section>
    </div>
  );
}

/** A play link for a READY version, or the reason there is none. */
export function playLink(v: { id: string; uploadState: 'PENDING' | 'READY' | 'FAILED'; label: string }): ReactNode {
  if (v.uploadState === 'READY') return <a className="loop-link" href={CREATOR_HREFS.media(v.id)} target="_blank" rel="noreferrer">Play</a>;
  return <span className="loop-table__muted">{v.uploadState === 'FAILED' ? 'Upload failed' : 'Upload pending'}</span>;
}
