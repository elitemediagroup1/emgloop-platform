'use client';

// Upload-as-answer: the EMG editor's one act on an Edit step (edit-review handoff §3).
//
// A CLIENT LEAF, AND NOTHING MORE. The file goes straight to storage: this component asks
// /api/creator/uploads for a short-lived PUT URL, PUTs the bytes, confirms with
// /api/creator/uploads/{versionId}/complete, and then -- when the editor chose "send" --
// submits a hidden form to the returnVersionForReview server action, which answers the
// instruction set, makes the version visible and completes the Edit step in one act. A draft
// stays EMG-only and the step stays open. Nothing here decides who may act: the route and the
// action re-check the session and the step.
//
// It imports no database, no server module and no runtime configuration; what it knows about
// storage (configured or not, and why) arrives as props from the server page.

import { useRef, useState, type FormEvent } from 'react';
import { returnVersionForReviewAction } from '../emg-actions';

export interface UploaderNote {
  readonly id: string;
  readonly atSeconds: number;
  readonly untilSeconds?: number | null;
  readonly kind: 'CHANGE' | 'KEEP';
  readonly text: string;
}

export interface EmgVersionUploaderProps {
  readonly workInstanceId: string;
  /** The work page to return to after the action; a safe application path. */
  readonly returnTo: string;
  readonly creatorFirstName: string;
  /** The label the next version will carry ("Edit v2"). */
  readonly nextLabel: string;
  /** The latest unanswered instruction set this upload answers, with its notes. Null when none is open. */
  readonly answers: { readonly label: string; readonly notes: readonly UploaderNote[] } | null;
  readonly media: { readonly state: 'CONFIGURED' } | { readonly state: 'NOT_CONFIGURED'; readonly reason: string };
}

type Phase =
  | { kind: 'IDLE' }
  | { kind: 'RESERVING' }
  | { kind: 'UPLOADING'; percent: number }
  | { kind: 'CONFIRMING' }
  | { kind: 'SENDING' }
  | { kind: 'DRAFT_SAVED'; label: string }
  | { kind: 'REFUSED'; text: string };

const REFUSAL_TEXT: Record<string, string> = {
  NOT_ALLOWED: 'This work is not on an Edit step you may act on.',
  NOT_FOUND: 'Loop could not find this production in your workspace.',
  NOT_CONFIGURED: 'Media storage is not configured on this deployment, so nothing can be uploaded.',
  UNREACHABLE: 'Storage could not be reached. Nothing was saved; try again shortly.',
  BAD_TYPE: 'That file type is not accepted. Upload a video or an image.',
  TOO_LARGE: 'That file is larger than Loop accepts.',
  NOT_UPLOADED: 'The bytes did not arrive in storage. Nothing was saved; try again.',
  UNAUTHENTICATED: 'Your session has ended. Sign in again.',
  FAILED: 'The upload failed. Nothing was saved.',
};

function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

interface MediaFacts {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
}

/** Facts the browser can read from the file, or nulls. Best effort, never blocking. */
function readMediaFacts(file: File): Promise<MediaFacts> {
  return new Promise((resolve) => {
    const none: MediaFacts = { durationSeconds: null, width: null, height: null };
    const url = URL.createObjectURL(file);
    const finish = (facts: MediaFacts) => {
      URL.revokeObjectURL(url);
      resolve(facts);
    };
    const timer = setTimeout(() => finish(none), 5000);
    if (file.type.startsWith('video/')) {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => {
        clearTimeout(timer);
        finish({ durationSeconds: Number.isFinite(v.duration) ? v.duration : null, width: v.videoWidth || null, height: v.videoHeight || null });
      };
      v.onerror = () => {
        clearTimeout(timer);
        finish(none);
      };
      v.src = url;
    } else if (file.type.startsWith('image/')) {
      const img = new Image();
      img.onload = () => {
        clearTimeout(timer);
        finish({ durationSeconds: null, width: img.naturalWidth || null, height: img.naturalHeight || null });
      };
      img.onerror = () => {
        clearTimeout(timer);
        finish(none);
      };
      img.src = url;
    } else {
      clearTimeout(timer);
      finish(none);
    }
  });
}

function putWithProgress(url: string, headers: Record<string, string>, file: File, onProgress: (percent: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.send(file);
  });
}

export function EmgVersionUploader(props: EmgVersionUploaderProps) {
  const { workInstanceId, returnTo, creatorFirstName, nextLabel, answers, media } = props;
  const [phase, setPhase] = useState<Phase>({ kind: 'IDLE' });
  const [then, setThen] = useState<'send' | 'draft'>('send');
  const [addressed, setAddressed] = useState<Record<string, { addressed: boolean; reply: string }>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const sendFormRef = useRef<HTMLFormElement>(null);
  const versionIdRef = useRef<HTMLInputElement>(null);
  const addressedRef = useRef<HTMLInputElement>(null);
  const noteOutRef = useRef<HTMLInputElement>(null);

  if (media.state !== 'CONFIGURED') {
    return (
      <div className="loop-state loop-state--unavailable" data-state="unavailable">
        <span className="loop-state__mark" aria-hidden="true">◌</span>
        <div>
          <p className="loop-state__title">Uploads are not available on this deployment.</p>
          <p className="loop-state__body">{media.reason} An Edit step is completed by uploading a version, so this step cannot be completed here until storage is configured.</p>
        </div>
      </div>
    );
  }

  const busy = phase.kind === 'RESERVING' || phase.kind === 'UPLOADING' || phase.kind === 'CONFIRMING' || phase.kind === 'SENDING';

  const addressedList = () =>
    (answers?.notes ?? []).map((n) => {
      const a = addressed[n.id];
      return { noteId: n.id, addressed: a?.addressed === true, reply: (a?.reply ?? '').trim() || null };
    });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setPhase({ kind: 'REFUSED', text: 'Choose the file to upload.' });
      return;
    }
    const noteToCreator = (noteRef.current?.value ?? '').trim();
    const internalNote = (internalRef.current?.value ?? '').trim();
    setPhase({ kind: 'RESERVING' });
    let begin: { ok: true; versionId: string; upload: { url: string; headers: Record<string, string> } } | { ok: false; reason: string };
    try {
      const res = await fetch('/api/creator/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purpose: 'EMG_VERSION',
          workInstanceId,
          fileName: file.name,
          contentType: file.type,
          byteSize: file.size,
          noteToCreator: noteToCreator || null,
          internalNote: internalNote || null,
          saveAsDraft: then === 'draft',
        }),
      });
      begin = (await res.json()) as typeof begin;
    } catch {
      begin = { ok: false, reason: 'FAILED' };
    }
    if (!begin.ok) {
      setPhase({ kind: 'REFUSED', text: REFUSAL_TEXT[begin.reason] ?? REFUSAL_TEXT.FAILED! });
      return;
    }
    setPhase({ kind: 'UPLOADING', percent: 0 });
    const put = await putWithProgress(begin.upload.url, begin.upload.headers, file, (percent) => setPhase({ kind: 'UPLOADING', percent }));
    if (!put) {
      setPhase({ kind: 'REFUSED', text: REFUSAL_TEXT.NOT_UPLOADED! });
      return;
    }
    setPhase({ kind: 'CONFIRMING' });
    const facts = await readMediaFacts(file);
    let complete: { ok: true } | { ok: false; reason: string };
    try {
      const res = await fetch(`/api/creator/uploads/${encodeURIComponent(begin.versionId)}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(facts),
      });
      complete = (await res.json()) as typeof complete;
    } catch {
      complete = { ok: false, reason: 'FAILED' };
    }
    if (!complete.ok) {
      setPhase({ kind: 'REFUSED', text: REFUSAL_TEXT[complete.reason] ?? REFUSAL_TEXT.FAILED! });
      return;
    }
    if (then === 'draft') {
      setPhase({ kind: 'DRAFT_SAVED', label: nextLabel });
      // Show the new draft in the versions list; a full reload is the honest refresh for a leaf.
      window.location.reload();
      return;
    }
    setPhase({ kind: 'SENDING' });
    if (versionIdRef.current) versionIdRef.current.value = begin.versionId;
    if (addressedRef.current) addressedRef.current.value = JSON.stringify(addressedList());
    if (noteOutRef.current) noteOutRef.current.value = noteToCreator;
    sendFormRef.current?.requestSubmit();
  }

  return (
    <div className="loop-stack" data-emg-uploader>
      <form onSubmit={onSubmit} className="loop-stack" aria-label={`Upload ${nextLabel}`}>
        <p className="loop-note">
          {answers
            ? `${nextLabel} answers ${answers.label}${answers.notes.length ? ` · ${answers.notes.length} note${answers.notes.length === 1 ? '' : 's'}` : ''}.`
            : `${nextLabel} will be added to this production. No instruction set is open, so there is nothing to mark as addressed.`}
        </p>
        <label className="loop-field">
          <span className="loop-label">File</span>
          <input ref={fileRef} className="loop-input" type="file" name="file" accept="video/*,image/*" disabled={busy} required />
        </label>

        {answers && answers.notes.length > 0 ? (
          <fieldset className="loop-stack" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="loop-label">{creatorFirstName}&rsquo;s notes — mark what this version addresses</legend>
            {answers.notes.map((n) => (
              <div key={n.id} className="loop-stack" style={{ gap: 4 }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={addressed[n.id]?.addressed === true}
                    disabled={busy}
                    onChange={(e) => setAddressed((s) => ({ ...s, [n.id]: { addressed: e.target.checked, reply: s[n.id]?.reply ?? '' } }))}
                  />
                  <span>
                    <strong>{mmss(n.atSeconds)}</strong>
                    {n.untilSeconds != null ? ` – ${mmss(n.untilSeconds)}` : ''} · {n.kind === 'KEEP' ? 'Keep' : 'Change'} · {n.text}
                  </span>
                </label>
                <input
                  className="loop-input"
                  type="text"
                  maxLength={500}
                  placeholder={`Reply to ${creatorFirstName} (one line, visible)`}
                  value={addressed[n.id]?.reply ?? ''}
                  disabled={busy}
                  onChange={(e) => setAddressed((s) => ({ ...s, [n.id]: { addressed: s[n.id]?.addressed === true, reply: e.target.value } }))}
                />
              </div>
            ))}
          </fieldset>
        ) : null}

        <label className="loop-field">
          <span className="loop-label">Note to {creatorFirstName} · visible to them</span>
          <textarea ref={noteRef} className="loop-textarea" rows={2} maxLength={2000} disabled={busy} placeholder="What changed, in a line or two." />
        </label>
        <label className="loop-field">
          <span className="loop-label">Internal note · EMG only</span>
          <textarea ref={internalRef} className="loop-textarea" rows={2} maxLength={2000} disabled={busy} placeholder="e.g. rendered from the 4K master; colour untouched" />
        </label>

        <fieldset className="loop-stack" style={{ border: 0, margin: 0, padding: 0, gap: 6 }}>
          <legend className="loop-label">Then</legend>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="radio" name="then" value="send" checked={then === 'send'} disabled={busy} onChange={() => setThen('send')} />
            <span>Send to {creatorFirstName} for review — completes the Edit step; their review starts now.</span>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="radio" name="then" value="draft" checked={then === 'draft'} disabled={busy} onChange={() => setThen('draft')} />
            <span>Save as a draft version — EMG only, not visible to {creatorFirstName}; the step stays open.</span>
          </label>
        </fieldset>

        {phase.kind === 'REFUSED' ? (
          <div className="loop-state loop-state--attention loop-state--compact" data-state="attention" role="status">
            <span className="loop-state__mark" aria-hidden="true">◑</span>
            <div>
              <p className="loop-state__title">Not uploaded.</p>
              <p className="loop-state__body">{phase.text}</p>
            </div>
          </div>
        ) : null}
        {phase.kind === 'UPLOADING' ? (
          <p className="loop-note" role="status" aria-live="polite">Uploading… {phase.percent}%</p>
        ) : phase.kind === 'RESERVING' ? (
          <p className="loop-note" role="status" aria-live="polite">Reserving {nextLabel}…</p>
        ) : phase.kind === 'CONFIRMING' ? (
          <p className="loop-note" role="status" aria-live="polite">Confirming the upload…</p>
        ) : phase.kind === 'SENDING' ? (
          <p className="loop-note" role="status" aria-live="polite">Sending to {creatorFirstName} for review…</p>
        ) : phase.kind === 'DRAFT_SAVED' ? (
          <p className="loop-note" role="status" aria-live="polite">{phase.label} saved as an EMG-only draft.</p>
        ) : null}

        <div className="loop-btnrow">
          <button className="loop-btn loop-btn--primary" type="submit" disabled={busy}>
            {then === 'send' ? `Upload and send for ${creatorFirstName}’s review` : 'Upload as a draft'}
          </button>
        </div>
      </form>

      {/* The act that answers the set and completes the step: submitted only after the bytes are confirmed. */}
      <form ref={sendFormRef} action={returnVersionForReviewAction} hidden aria-hidden="true">
        <input type="hidden" name="workInstanceId" value={workInstanceId} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <input ref={versionIdRef} type="hidden" name="versionId" defaultValue="" />
        <input ref={addressedRef} type="hidden" name="addressed" defaultValue="" />
        <input ref={noteOutRef} type="hidden" name="noteToCreator" defaultValue="" />
      </form>
    </div>
  );
}
