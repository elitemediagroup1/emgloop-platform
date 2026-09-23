'use client';

// Review mode (Creator Hub, Mockup #2): a sheet over the Content Record, not a second page.
//
// The player first; "same moment, different cut" (the segmented control swaps versions and keeps
// the playhead); timestamped notes collected as DRAFTS in this browser until sent; and exactly two
// decisions, each ending in a server action. Closing the sheet returns to the record unchanged;
// drafts survive in localStorage keyed by the version they were made on.
//
// It decides nothing. Sending posts the drafts as JSON to `requestChangesAction`, which validates
// them again with the shared `validateNotes` and hands them to the production service. Approving
// posts to `approveVersionAction`. Neither the note count nor the checklist here is authority.
//
// Imports from @emgloop/shared only (client-bundle-boundary.test.tsx); the actions module is a
// 'use server' boundary the bundler replaces with references.

import { useEffect, useMemo, useRef, useState } from 'react';
import { INSTRUCTION_LIMITS, formatSeconds, type InstructionNote, type NoteKind } from '@emgloop/shared';
import { approveVersionAction, requestChangesAction } from '../../../../creator/creator-actions';

export interface ReviewVersion {
  readonly id: string;
  readonly label: string;
  readonly mediaHref: string | null;
  readonly durationSeconds: number | null;
}

export interface ReviewRequirement {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly met: boolean;
  readonly by: string | null;
}

export interface AddressedNoteView {
  readonly atSeconds: number;
  readonly kind: NoteKind;
  readonly text: string;
  readonly addressed: boolean;
  readonly reply: string | null;
}

export interface ReviewSheetProps {
  contentId: string;
  contentTitle: string;
  kind: 'VIDEO' | 'PHOTO';
  version: ReviewVersion;
  previous: ReviewVersion | null;
  returnedBy: string | null;
  returnedAtText: string | null;
  noteToCreator: string | null;
  /** The creator's notes on the previous version and what the editor said about each. */
  addressed: readonly AddressedNoteView[];
  previousLabel: string | null;
  requirements: readonly ReviewRequirement[];
  deliverableTitle: string | null;
  campaignName: string | null;
  requestedReturnText: string | null;
  productionNumber: number | null;
  closeHref: string;
}

type Draft = InstructionNote;
type Mode = 'review' | 'note' | 'send' | 'approve';

function storageKey(versionId: string): string {
  return `loop.creator.review.${versionId}`;
}

function loadDrafts(versionId: string): Draft[] {
  try {
    const raw = window.localStorage.getItem(storageKey(versionId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is Draft => !!n && typeof n === 'object' && typeof (n as Draft).id === 'string' && typeof (n as Draft).text === 'string' && typeof (n as Draft).atSeconds === 'number');
  } catch {
    return [];
  }
}

function saveDrafts(versionId: string, drafts: readonly Draft[]): void {
  try {
    if (drafts.length === 0) window.localStorage.removeItem(storageKey(versionId));
    else window.localStorage.setItem(storageKey(versionId), JSON.stringify(drafts));
  } catch {
    // Storage unavailable (private mode, quota): drafts live only in memory for this visit.
  }
}

function newId(): string {
  return `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function ReviewSheet(props: ReviewSheetProps) {
  const { version, previous, kind } = props;
  const [viewing, setViewing] = useState<'current' | 'previous'>('current');
  const [playhead, setPlayhead] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>('review');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [noteAt, setNoteAt] = useState(0);
  const [noteKind, setNoteKind] = useState<NoteKind>('CHANGE');
  const [noteText, setNoteText] = useState('');
  const [summary, setSummary] = useState('');
  const [returnAt, setReturnAt] = useState('');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const resumeAt = useRef<number | null>(null);

  useEffect(() => {
    setDrafts(loadDrafts(version.id));
    setLoaded(true);
  }, [version.id]);

  useEffect(() => {
    if (loaded) saveDrafts(version.id, drafts);
  }, [drafts, loaded, version.id]);

  const shown = viewing === 'previous' && previous ? previous : version;
  const duration = shown.durationSeconds ?? (videoRef.current?.duration || null);
  const sortedDrafts = useMemo(() => [...drafts].sort((a, b) => a.atSeconds - b.atSeconds), [drafts]);

  function switchTo(target: 'current' | 'previous') {
    if (target === viewing) return;
    const v = videoRef.current;
    resumeAt.current = v ? v.currentTime : playhead;
    setViewing(target);
  }

  function onLoadedMetadata() {
    const v = videoRef.current;
    if (v && resumeAt.current !== null) {
      v.currentTime = Math.min(resumeAt.current, Number.isFinite(v.duration) ? v.duration : resumeAt.current);
      resumeAt.current = null;
    }
  }

  function seek(seconds: number) {
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.currentTime = seconds;
    }
    setPlayhead(seconds);
  }

  function openNote(existing?: Draft) {
    videoRef.current?.pause();
    if (existing) {
      setEditing(existing);
      setNoteAt(existing.atSeconds);
      setNoteKind(existing.kind);
      setNoteText(existing.text);
    } else {
      setEditing(null);
      setNoteAt(kind === 'VIDEO' ? Math.round(playhead * 10) / 10 : 0);
      setNoteKind('CHANGE');
      setNoteText('');
    }
    setMode('note');
  }

  function saveNote() {
    const text = noteText.trim();
    if (!text) return;
    if (editing) setDrafts((d) => d.map((n) => (n.id === editing.id ? { ...n, kind: noteKind, text } : n)));
    else if (drafts.length < INSTRUCTION_LIMITS.maxNotes) setDrafts((d) => [...d, { id: newId(), atSeconds: noteAt, untilSeconds: null, kind: noteKind, text }]);
    setEditing(null);
    setMode('review');
  }

  function removeNote(id: string) {
    setDrafts((d) => d.filter((n) => n.id !== id));
    if (editing?.id === id) {
      setEditing(null);
      setMode('review');
    }
  }

  const noteButtonLabel = kind === 'VIDEO' ? `Add a note at ${formatSeconds(playhead)}` : 'Add a note';
  const canSend = sortedDrafts.length > 0 || summary.trim() !== '';
  const unmetAfter = props.requirements.filter((r) => r.required && !r.met && r.key !== 'creator');

  const player =
    shown.mediaHref === null ? (
      <div className="ch-media__frame">
        <p className="loop-note">Preview unavailable on this deployment: media storage is not configured, so this version cannot be played here. You can still send notes or approve.</p>
      </div>
    ) : kind === 'VIDEO' ? (
      <video
        ref={videoRef}
        key={shown.id}
        className="ch-media__el"
        controls
        playsInline
        preload="metadata"
        src={shown.mediaHref}
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
        onPause={(e) => setPlayhead(e.currentTarget.currentTime)}
        aria-label={`${props.contentTitle} · ${shown.label}`}
      />
    ) : (
      <img className="ch-media__el" src={shown.mediaHref} alt={`${props.contentTitle} · ${shown.label}`} />
    );

  return (
    <section className="ch-sheet" aria-label={`Review ${version.label}`} data-review-version={version.id}>
      <header className="ch-sheet__head">
        <div>
          <p className="ch-sheet__title">Review · {version.label}</p>
          <p className="ch-sheet__sub">
            {props.contentTitle}
            {props.returnedBy ? ` · returned by ${props.returnedBy}` : ''}
            {props.returnedAtText ? ` ${props.returnedAtText}` : ''}
          </p>
        </div>
        <a className="loop-link" href={props.closeHref}>
          Close
        </a>
      </header>

      <div className="ch-sheet__body">
        <div className="ch-media">
          {previous ? (
            <div className="ch-media__seg" role="group" aria-label="Which cut to show">
              <button type="button" aria-pressed={viewing === 'previous'} onClick={() => switchTo('previous')}>
                {previous.label}
              </button>
              <button type="button" aria-pressed={viewing === 'current'} onClick={() => switchTo('current')}>
                {version.label}
              </button>
            </div>
          ) : null}
          {kind === 'VIDEO' && shown.durationSeconds != null ? <b className="ch-media__badge">{formatSeconds(shown.durationSeconds)}</b> : null}
          {player}
        </div>
        {kind === 'VIDEO' && duration ? (
          <div className="ch-marks" aria-label="Your notes on the timeline">
            {sortedDrafts.map((n) => (
              <button key={n.id} type="button" className={`ch-marks__m${n.kind === 'KEEP' ? ' is-keep' : ''}`} style={{ left: `${Math.min(100, (n.atSeconds / duration) * 100)}%` }} title={`${formatSeconds(n.atSeconds)} · ${n.text}`} onClick={() => seek(n.atSeconds)}>
                <span className="loop-sr-only">Jump to {formatSeconds(n.atSeconds)}</span>
              </button>
            ))}
          </div>
        ) : null}
        {previous && kind === 'VIDEO' ? <p className="loop-note">Switch cuts to compare this moment; the playhead stays where it is.</p> : null}

        {mode === 'review' ? (
          <>
            <div className="loop-btnrow">
              <button type="button" className="loop-btn" onClick={() => openNote()} disabled={drafts.length >= INSTRUCTION_LIMITS.maxNotes}>
                {noteButtonLabel}
              </button>
            </div>

            {props.noteToCreator || props.returnedBy ? (
              <div>
                <p className="ch-h">What {props.returnedBy ?? 'EMG'} changed</p>
                {props.noteToCreator ? <p className="ch-quote">“{props.noteToCreator}”</p> : <p className="loop-note">No note came back with this version.</p>}
              </div>
            ) : null}

            {props.addressed.length > 0 ? (
              <div>
                <p className="ch-h">
                  Your notes on {props.previousLabel ?? 'the previous version'} · {props.addressed.filter((a) => a.addressed).length} of {props.addressed.length} addressed
                </p>
                <ul className="ch-notes">
                  {props.addressed.map((a, i) => (
                    <li key={i} className={`ch-note${a.addressed ? ' ch-note--done' : ''}${a.kind === 'KEEP' ? ' ch-note--keep' : ''}`}>
                      <span className="ch-note__t">
                        {a.addressed ? '✓ ' : ''}
                        {kind === 'VIDEO' ? formatSeconds(a.atSeconds) : a.kind === 'KEEP' ? 'Keep' : 'Change'}
                      </span>
                      <span>
                        <span className="ch-note__b">{a.text}</span>
                        <span className="ch-note__m">{a.reply ? `${props.returnedBy ?? 'EMG'}: “${a.reply}”` : a.addressed ? 'Addressed' : 'Not marked as addressed'}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div>
              <p className="ch-h">
                Your notes · {sortedDrafts.length} · not sent yet
              </p>
              {sortedDrafts.length === 0 ? (
                <p className="loop-note">Pause where something should change (or stay exactly as it is) and add a note there.</p>
              ) : (
                <ul className="ch-notes">
                  {sortedDrafts.map((n) => (
                    <li key={n.id} className={`ch-note${n.kind === 'KEEP' ? ' ch-note--keep' : ''}`}>
                      <button type="button" className="ch-note__t" onClick={() => (kind === 'VIDEO' ? seek(n.atSeconds) : undefined)}>
                        {kind === 'VIDEO' ? formatSeconds(n.atSeconds) : n.kind === 'KEEP' ? 'Keep' : 'Change'}
                      </button>
                      <span>
                        <span className="ch-note__b">{n.text}</span>
                        <span className="ch-note__m">{n.kind === 'KEEP' ? 'Keep' : 'Change'}</span>
                      </span>
                      <span className="ch-note__x">
                        <button type="button" className="loop-btn loop-btn--quiet" onClick={() => openNote(n)}>
                          Edit
                        </button>
                        <button type="button" className="loop-btn loop-btn--quiet" onClick={() => removeNote(n.id)}>
                          Delete
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="loop-note" style={{ marginTop: 8 }}>
                Notes stay in this browser until you send them.
              </p>
            </div>
          </>
        ) : null}

        {mode === 'note' ? (
          <div className="ch-consequence" role="dialog" aria-label={editing ? 'Edit note' : 'Add note'}>
            <p className="ch-h">
              {editing ? 'Edit note' : 'Note'}
              {kind === 'VIDEO' ? ` at ${formatSeconds(noteAt)}` : ''} · on {version.label}
            </p>
            <div className="ch-kind" role="group" aria-label="Kind of note">
              <button type="button" aria-pressed={noteKind === 'CHANGE'} onClick={() => setNoteKind('CHANGE')}>
                Change
              </button>
              <button type="button" aria-pressed={noteKind === 'KEEP'} onClick={() => setNoteKind('KEEP')}>
                Keep
              </button>
            </div>
            <textarea className="loop-textarea" rows={3} maxLength={INSTRUCTION_LIMITS.maxNoteChars} value={noteText} placeholder={noteKind === 'KEEP' ? 'What should stay exactly as it is' : 'What should change here'} onChange={(e) => setNoteText(e.target.value)} />
            <p className="loop-note">The editor sees this on their timeline{kind === 'VIDEO' ? ` at ${formatSeconds(noteAt)}` : ''}, with your words exactly as written.</p>
            <div className="loop-btnrow">
              <button type="button" className="loop-btn loop-btn--primary" onClick={saveNote} disabled={noteText.trim() === ''}>
                {editing ? 'Save note' : 'Add note'}
              </button>
              <button
                type="button"
                className="loop-btn loop-btn--quiet"
                onClick={() => {
                  setEditing(null);
                  setMode('review');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {mode === 'send' ? (
          <form className="ch-consequence ch-form" action={requestChangesAction} onSubmit={() => saveDrafts(version.id, [])}>
            <p className="ch-h">Send changes to EMG</p>
            <input type="hidden" name="contentId" value={props.contentId} />
            <input type="hidden" name="notes" value={JSON.stringify(sortedDrafts)} />
            {sortedDrafts.length > 0 ? (
              <ul className="ch-notes">
                {sortedDrafts.map((n) => (
                  <li key={n.id} className={`ch-note${n.kind === 'KEEP' ? ' ch-note--keep' : ''}`}>
                    <span className="ch-note__t">{kind === 'VIDEO' ? formatSeconds(n.atSeconds) : n.kind === 'KEEP' ? 'Keep' : 'Change'}</span>
                    <span>
                      <span className="ch-note__b">{n.text}</span>
                      <span className="ch-note__m">{n.kind === 'KEEP' ? 'Keep' : 'Change'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="loop-note">No timestamped notes. Say what should change below.</p>
            )}
            <label className="loop-field">
              <span className="loop-label">Anything else for {props.returnedBy ?? 'EMG'}?</span>
              <textarea className="loop-textarea" name="summary" rows={3} maxLength={INSTRUCTION_LIMITS.maxSummaryChars} value={summary} onChange={(e) => setSummary(e.target.value)} />
            </label>
            <label className="loop-field">
              <span className="loop-label">When you'd like it back (optional)</span>
              <input className="loop-input" type="datetime-local" name="requestedReturnAt" value={returnAt} onChange={(e) => setReturnAt(e.target.value)} />
              <span className="loop-note">{props.requestedReturnText ? `You asked for ${props.requestedReturnText} last time; leave this empty to keep it.` : 'In your own time zone.'}</span>
            </label>
            <p className="ch-consequence__what">
              <b>What happens.</b> This goes back to {props.returnedBy ?? 'EMG'} on {props.productionNumber ? `Production ${props.productionNumber}` : 'the same production'}. The next edit answers these notes. EMG's expected return stays unless they change it, and you will see it on the record. Your notes become part of the history and cannot be edited after sending.
            </p>
            <div className="loop-btnrow">
              <button type="submit" className="loop-btn loop-btn--primary" disabled={!canSend}>
                Send to EMG
              </button>
              <button type="button" className="loop-btn loop-btn--quiet" onClick={() => setMode('review')}>
                Back
              </button>
            </div>
          </form>
        ) : null}

        {mode === 'approve' ? (
          <form className="ch-consequence ch-form" action={approveVersionAction}>
            <p className="ch-h">Approve {version.label} · your approval, for this version only</p>
            <input type="hidden" name="contentId" value={props.contentId} />
            <input type="hidden" name="versionId" value={version.id} />
            {props.deliverableTitle ? (
              <>
                <p className="ch-consequence__what">
                  <b>
                    For {props.deliverableTitle}
                    {props.campaignName ? ` · ${props.campaignName}` : ''}
                  </b>
                </p>
                <ul className="ch-req">
                  {props.requirements.map((r) => {
                    const done = r.met || r.key === 'creator';
                    return (
                      <li key={r.key} className={done ? 'is-done' : ''}>
                        <i aria-hidden="true">{done ? '✓' : ''}</i>
                        <span>
                          {r.label}
                          {r.key === 'creator' && !r.met ? <small> · {version.label} · now</small> : r.met && r.by ? <small> · {r.by}</small> : null}
                          {!r.required ? <small> · optional</small> : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="loop-note">
                  {props.productionNumber ? `Production ${props.productionNumber} completes. ` : ''}
                  {unmetAfter.length > 0 ? `The deliverable is not complete until every line above is ticked. ` : ''}
                  If a later version changes materially, it will need your approval again — this one stays on {version.label} in the history.
                </p>
              </>
            ) : (
              <p className="ch-consequence__what">
                This makes {version.label} the final. Nothing else is needed.
                {props.productionNumber ? ` Production ${props.productionNumber} completes.` : ''}
              </p>
            )}
            {sortedDrafts.length > 0 ? <p className="loop-note">Your {sortedDrafts.length} unsent note{sortedDrafts.length === 1 ? '' : 's'} will not be sent. Delete them or send changes instead.</p> : null}
            <div className="loop-btnrow">
              <button type="submit" className="loop-btn loop-btn--primary">
                Approve {version.label}
              </button>
              <button type="button" className="loop-btn loop-btn--quiet" onClick={() => setMode('review')}>
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </div>

      {mode === 'review' ? (
        <div className="ch-sheet__bar">
          <button type="button" className="loop-btn" onClick={() => setMode('send')}>
            Request changes{sortedDrafts.length > 0 ? ` · ${sortedDrafts.length}` : ''}
          </button>
          <button type="button" className="loop-btn loop-btn--primary" onClick={() => setMode('approve')}>
            Approve
          </button>
        </div>
      ) : null}
    </section>
  );
}
