'use client';

// The upload control (Creator Hub). The one client leaf on the Content library.
//
// THE BYTES GO STRAIGHT TO STORAGE. This leaf reserves a version (POST /api/creator/uploads),
// PUTs the file to the short-lived URL it was given, then confirms it (POST .../complete). It
// reads the file's duration and dimensions in the browser first, because that is the only place
// they can be read before the bytes leave; the server records them as "read in the uploader's
// browser". It holds no business rule: which types and sizes are accepted arrive as props from
// the server, and the server refuses anything else again.
//
// It imports nothing from the database package (client-bundle-boundary.test.tsx).

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

export interface UploaderDeliverable {
  readonly id: string;
  readonly title: string;
  readonly campaignName: string;
}

interface Props {
  /** Accepted content types, comma-separated, as the <input accept> attribute wants them. */
  accept: string;
  acceptedTypes: readonly string[];
  imageLimitBytes: number;
  videoLimitBytes: number;
  deliverables: readonly UploaderDeliverable[];
  preselectedDeliverableId: string | null;
  /** The library route; a finished upload links to `${recordBase}/${contentId}`. */
  recordBase: string;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'reserving' }
  | { kind: 'uploading'; percent: number }
  | { kind: 'completing' }
  | { kind: 'done'; contentId: string }
  | { kind: 'failed'; message: string; retryable: boolean };

interface Facts {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
}

interface Reserved {
  contentId: string;
  versionId: string;
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

const BEGIN_REASONS: Record<string, string> = {
  NOT_CONFIGURED: 'Uploads are not available on this deployment yet.',
  BAD_TYPE: 'That file type is not accepted.',
  TOO_LARGE: 'That file is too large.',
  INVALID: 'Give the content a name.',
  NOT_FOUND: 'That deliverable is not yours.',
  NOT_ALLOWED: 'That deliverable already has content attached.',
  UNREACHABLE: 'Storage could not be reached. Try again in a moment.',
  UNAUTHENTICATED: 'Your session has ended. Sign in again.',
};

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024 * 1024))} GB` : `${Math.round(bytes / (1024 * 1024))} MB`;
}

function titleFromName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 140);
}

/** Duration and dimensions from the file itself, in this browser. Anything unreadable is null, never guessed. */
function readFacts(file: File, kind: 'VIDEO' | 'PHOTO'): Promise<Facts> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const done = (facts: Facts) => {
      URL.revokeObjectURL(url);
      resolve(facts);
    };
    const timer = setTimeout(() => done({ durationSeconds: null, width: null, height: null }), 10_000);
    if (kind === 'VIDEO') {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        const duration = Number.isFinite(video.duration) ? Math.round(video.duration * 10) / 10 : null;
        done({ durationSeconds: duration, width: video.videoWidth || null, height: video.videoHeight || null });
      };
      video.onerror = () => {
        clearTimeout(timer);
        done({ durationSeconds: null, width: null, height: null });
      };
      video.src = url;
    } else {
      const img = new Image();
      img.onload = () => {
        clearTimeout(timer);
        done({ durationSeconds: null, width: img.naturalWidth || null, height: img.naturalHeight || null });
      };
      img.onerror = () => {
        clearTimeout(timer);
        done({ durationSeconds: null, width: null, height: null });
      };
      img.src = url;
    }
  });
}

function putFile(target: Reserved, file: File, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', target.url, true);
    for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Storage answered ${xhr.status}.`)));
    xhr.onerror = () => reject(new Error('The upload was interrupted.'));
    xhr.onabort = () => reject(new Error('The upload was cancelled.'));
    xhr.send(file);
  });
}

function ProgressRing({ percent }: { percent: number }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  return (
    <svg className="ch-ring" viewBox="0 0 44 44" role="img" aria-label={`${percent}% uploaded`}>
      <circle className="ch-ring__track" cx="22" cy="22" r={r} />
      <circle className="ch-ring__bar" cx="22" cy="22" r={r} strokeDasharray={c} strokeDashoffset={c - (c * percent) / 100} />
    </svg>
  );
}

export function Uploader(props: Props) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [deliverableId, setDeliverableId] = useState(props.preselectedDeliverableId ?? '');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const reserved = useRef<Reserved | null>(null);
  const facts = useRef<Facts | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const kind: 'VIDEO' | 'PHOTO' | null = file ? (file.type.startsWith('video/') ? 'VIDEO' : 'PHOTO') : null;
  const busy = phase.kind === 'reading' || phase.kind === 'reserving' || phase.kind === 'uploading' || phase.kind === 'completing';
  const fileRefused = file ? !props.acceptedTypes.includes(file.type) || file.size > (kind === 'VIDEO' ? props.videoLimitBytes : props.imageLimitBytes) : true;

  function choose(next: File | null) {
    setFile(next);
    reserved.current = null;
    facts.current = null;
    setPhase({ kind: 'idle' });
    if (next) {
      if (!title) setTitle(titleFromName(next.name));
      if (!props.acceptedTypes.includes(next.type)) setPhase({ kind: 'failed', message: `That file type (${next.type || 'unknown'}) is not accepted. Accepted: ${props.acceptedTypes.join(', ')}.`, retryable: false });
      else if (next.size > (next.type.startsWith('video/') ? props.videoLimitBytes : props.imageLimitBytes)) {
        setPhase({ kind: 'failed', message: `That file is larger than the ${megabytes(next.type.startsWith('video/') ? props.videoLimitBytes : props.imageLimitBytes)} limit.`, retryable: false });
      }
    }
  }

  async function complete(target: Reserved): Promise<void> {
    setPhase({ kind: 'completing' });
    const res = await fetch(`/api/creator/uploads/${encodeURIComponent(target.versionId)}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(facts.current ?? { durationSeconds: null, width: null, height: null }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
    if (body.ok) {
      setPhase({ kind: 'done', contentId: target.contentId });
      router.refresh();
      return;
    }
    if (body.reason === 'NOT_UPLOADED') {
      setPhase({ kind: 'failed', message: 'Storage has not received the file yet. Retry to send it again.', retryable: true });
      return;
    }
    setPhase({ kind: 'failed', message: BEGIN_REASONS[body.reason ?? ''] ?? 'The upload could not be confirmed.', retryable: body.reason === 'UNREACHABLE' });
  }

  async function send(target: Reserved): Promise<void> {
    if (!file) return;
    if (Date.parse(target.expiresAt) < Date.now()) {
      setPhase({ kind: 'failed', message: 'The upload link expired before the file was sent. Choose the file again to start over.', retryable: false });
      reserved.current = null;
      return;
    }
    setPhase({ kind: 'uploading', percent: 0 });
    try {
      await putFile(target, file, (percent) => setPhase({ kind: 'uploading', percent }));
    } catch (e) {
      setPhase({ kind: 'failed', message: e instanceof Error ? e.message : 'The upload failed.', retryable: true });
      return;
    }
    await complete(target);
  }

  async function start(): Promise<void> {
    if (!file || !kind) return;
    const name = title.trim();
    if (!name) {
      setPhase({ kind: 'failed', message: 'Give the content a name.', retryable: false });
      return;
    }
    setPhase({ kind: 'reading' });
    facts.current = await readFacts(file, kind);
    setPhase({ kind: 'reserving' });
    const res = await fetch('/api/creator/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'CREATOR_NEW_CONTENT', title: name, kind, fileName: file.name, contentType: file.type, byteSize: file.size, deliverableId: deliverableId || null }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; detail?: string; contentId?: string; versionId?: string; upload?: { url: string; headers: Record<string, string>; expiresAt: string } };
    if (!body.ok || !body.upload || !body.contentId || !body.versionId) {
      setPhase({ kind: 'failed', message: [BEGIN_REASONS[body.reason ?? ''] ?? 'Loop could not start the upload.', body.detail].filter(Boolean).join(' '), retryable: false });
      return;
    }
    reserved.current = { contentId: body.contentId, versionId: body.versionId, url: body.upload.url, headers: body.upload.headers, expiresAt: body.upload.expiresAt };
    await send(reserved.current);
  }

  function retry() {
    if (reserved.current) void send(reserved.current);
    else void start();
  }

  function reset() {
    setFile(null);
    setTitle('');
    setPhase({ kind: 'idle' });
    reserved.current = null;
    facts.current = null;
    if (inputRef.current) inputRef.current.value = '';
  }

  return (
    <div className="ch-uploader" data-phase={phase.kind}>
      {phase.kind === 'done' ? (
        <div className="loop-state loop-state--empty loop-state--compact" data-state="done">
          <span className="loop-state__mark" aria-hidden="true">
            ✓
          </span>
          <div>
            <p className="loop-state__title">Uploaded.</p>
            <p className="loop-state__body">It is now a record you can send to EMG, review and publish.</p>
            <div className="loop-btnrow" style={{ marginTop: 10 }}>
              <a className="loop-btn loop-btn--primary" href={`${props.recordBase}/${encodeURIComponent(phase.contentId)}`}>
                Open the record
              </a>
              <button type="button" className="loop-btn" onClick={reset}>
                Upload another
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="ch-form">
          <label className="loop-field">
            <span className="loop-label">File</span>
            <input ref={inputRef} className="loop-input" type="file" accept={props.accept} disabled={busy} onChange={(e) => choose(e.target.files?.[0] ?? null)} />
            <span className="loop-note">
              Video up to {megabytes(props.videoLimitBytes)}; photo up to {megabytes(props.imageLimitBytes)}. {kind ? `This is a ${kind === 'VIDEO' ? 'video' : 'photo'}.` : ''}
            </span>
          </label>
          <label className="loop-field">
            <span className="loop-label">Name</span>
            <input className="loop-input" type="text" value={title} maxLength={140} disabled={busy} placeholder="What you call this piece" onChange={(e) => setTitle(e.target.value)} />
          </label>
          {props.deliverables.length > 0 ? (
            <label className="loop-field">
              <span className="loop-label">For a deliverable</span>
              <select className="loop-select" value={deliverableId} disabled={busy} onChange={(e) => setDeliverableId(e.target.value)}>
                <option value="">Not for a deliverable (independent content)</option>
                {props.deliverables.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title} · {d.campaignName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="ch-uploader__row">
            {phase.kind === 'uploading' ? <ProgressRing percent={phase.percent} /> : null}
            {phase.kind === 'reading' ? <span className="loop-note">Reading the file…</span> : null}
            {phase.kind === 'reserving' ? <span className="loop-note">Preparing storage…</span> : null}
            {phase.kind === 'uploading' ? <span className="loop-note">{phase.percent}% sent</span> : null}
            {phase.kind === 'completing' ? <span className="loop-note">Confirming…</span> : null}
            {phase.kind === 'failed' ? (
              <span className="ch-uploader__error" role="alert">
                {phase.message}
              </span>
            ) : null}
            <span className="ch-uploader__actions">
              {phase.kind === 'failed' && phase.retryable ? (
                <button type="button" className="loop-btn" onClick={retry}>
                  Retry
                </button>
              ) : null}
              <button type="button" className="loop-btn loop-btn--primary" disabled={fileRefused || busy} onClick={() => void start()}>
                Upload
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
