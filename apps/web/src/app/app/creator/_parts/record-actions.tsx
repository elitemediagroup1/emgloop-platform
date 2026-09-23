// The Content Record's state-dependent action bar and its small server forms (Creator Hub).
//
// WHICH ACTIONS EXIST IS DERIVED, NEVER INVENTED HERE: `record.actions` comes from the shared
// `creatorActionsFor` over the state and the deliverable's requirements. This file only draws
// them -- one primary and one secondary, or a status line when the ball is with EMG or a brand --
// and posts the plain forms to the server actions. Server component: the forms need no JavaScript.

import Link from 'next/link';
import type { ContentRecordView, VersionView } from '@emgloop/database';
import type { TimeView } from '@emgloop/shared';
import { SOCIAL_PLATFORMS, SOCIAL_PLATFORM_LABELS } from '@emgloop/shared';
import { addCreatorNoteAction, markPublishedAction, submitOriginalAction } from '../../../../creator/creator-actions';
import type { RecordHrefs } from './content-record-body';

function statusLine(record: ContentRecordView): { title: string; detail: string } | null {
  const editor = record.activeProduction?.currentStep?.owner?.name ?? null;
  switch (record.state) {
    case 'IN_PRODUCTION':
      return { title: 'With EMG', detail: editor ? `${editor} is editing` : 'waiting for an editor' };
    case 'CHANGES_REQUESTED':
      return { title: 'Back with EMG', detail: editor ? `${editor} is answering the notes` : 'waiting for an editor' };
    case 'APPROVED_BY_YOU': {
      const waiting = record.requirementStatuses.filter((r) => r.required && !r.met && r.key !== 'published').map((r) => r.label);
      return { title: waiting.length ? `Waiting for ${waiting.join(' and ')}` : 'Approved by you', detail: 'Nothing for you to do until then' };
    }
    default:
      return null;
  }
}

export function ContentActionBar({ record, hrefs, selected }: { record: ContentRecordView; hrefs: RecordHrefs; selected: VersionView | null }) {
  const a = record.actions;
  const buttons: React.ReactNode[] = [];
  const review = a.review && record.latestVersion ? hrefs.review(record.latestVersion.id) : null;
  const publish = a.markPublished || a.publishAsIs;
  const primaryIsReview = review !== null;
  const primaryIsPublish = !primaryIsReview && publish;
  const primaryIsSubmit = !primaryIsReview && !primaryIsPublish && a.submitOriginalForApproval;
  const primaryIsEdit = !primaryIsReview && !primaryIsPublish && !primaryIsSubmit && a.requestEdit;

  if (review) {
    buttons.push(
      <Link key="review" className="loop-btn loop-btn--primary" href={review} data-action="review">
        Review
      </Link>,
    );
  }
  if (publish) {
    buttons.push(
      <Link key="publish" className={`loop-btn${primaryIsPublish ? ' loop-btn--primary' : ''}`} href={hrefs.publish} data-action="publish">
        {a.publishAsIs ? 'Publish as-is' : 'Mark as published'}
      </Link>,
    );
  }
  if (a.submitOriginalForApproval) {
    buttons.push(
      <form key="submit" action={submitOriginalAction} style={{ display: 'contents' }}>
        <input type="hidden" name="contentId" value={record.id} />
        <button type="submit" className={`loop-btn${primaryIsSubmit ? ' loop-btn--primary' : ''}`} data-action="submit-original">
          Submit for approval
        </button>
      </form>,
    );
  }
  if (a.requestEdit) {
    buttons.push(
      <Link key="edit" className={`loop-btn${primaryIsEdit ? ' loop-btn--primary' : ''}`} href={hrefs.requestEdit} data-action="request-edit">
        Request an edit
      </Link>,
    );
  }
  const status = buttons.length === 0 ? statusLine(record) : null;
  const note = record.activeProduction ? (
    <a key="note" className="loop-btn" href="#production" data-action="note">
      Add a note
    </a>
  ) : null;
  return (
    <div className="ch-actbar" role="region" aria-label="Actions" data-selected-version={selected?.id ?? ''}>
      {status ? (
        <div className="ch-actbar__status">
          <b>{status.title}</b>
          <span>{status.detail}</span>
        </div>
      ) : null}
      {buttons}
      {status ? note : null}
    </div>
  );
}

/** `?publish=1`: platform, link and date for the version being published. Posts to markPublishedAction. */
export function PublishForm({ record, version, time, cancelHref }: { record: ContentRecordView; version: VersionView | null; time: TimeView; cancelHref: string }) {
  if (!version || version.uploadState !== 'READY') {
    return (
      <div className="loop-state loop-state--attention loop-state--compact" data-state="attention">
        <span className="loop-state__mark" aria-hidden="true">
          ◑
        </span>
        <div>
          <p className="loop-state__title">Pick a finished version to publish.</p>
          <p className="loop-state__body">Choose one of the versions below first.</p>
        </div>
      </div>
    );
  }
  return (
    <form className="loop-panel ch-form" action={markPublishedAction} aria-label="Mark as published">
      <h2 className="loop-panel__title">Mark {version.label} as published</h2>
      <input type="hidden" name="contentId" value={record.id} />
      <input type="hidden" name="versionId" value={version.id} />
      <label className="loop-field">
        <span className="loop-label">Platform</span>
        <select className="loop-select" name="platform" required defaultValue="">
          <option value="" disabled>
            Choose a platform
          </option>
          {SOCIAL_PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {SOCIAL_PLATFORM_LABELS[p]}
            </option>
          ))}
        </select>
      </label>
      <label className="loop-field">
        <span className="loop-label">Link to the post (optional)</span>
        <input className="loop-input" type="url" name="url" placeholder="https://" />
      </label>
      <label className="loop-field">
        <span className="loop-label">Published at (optional)</span>
        <input className="loop-input" type="datetime-local" name="publishedAt" />
        <span className="loop-note">In your time zone ({time.timeZone}). Leave empty for now.</span>
      </label>
      <p className="loop-note">Loop records that you published it; it does not post anything for you.</p>
      <div className="loop-btnrow">
        <button type="submit" className="loop-btn loop-btn--primary">
          Mark as published
        </button>
        <Link className="loop-btn loop-btn--quiet" href={cancelHref}>
          Cancel
        </Link>
      </div>
    </form>
  );
}

/** A note to the active production. It changes no state. */
export function NoteForm({ record }: { record: ContentRecordView }) {
  return (
    <form className="ch-form" action={addCreatorNoteAction} aria-label="Add a note" style={{ marginTop: 14 }}>
      <input type="hidden" name="contentId" value={record.id} />
      <label className="loop-field">
        <span className="loop-label">Add a note to this production</span>
        <textarea className="loop-textarea" name="body" rows={2} required placeholder="A question or a heads-up for the editor. It changes nothing." />
      </label>
      <div className="loop-btnrow">
        <button type="submit" className="loop-btn">
          Add note
        </button>
      </div>
    </form>
  );
}
