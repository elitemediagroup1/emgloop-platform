'use client';

/**
 * Public "Request Access" section for the login page.
 *
 * Renders the "Need access?" copy, a Request Access button, and an accessible
 * modal dialog that collects an access request. On submit it calls the
 * server action `submitAccessRequest`, which validates again server-side and
 * emails EMG operations. This component never talks to Resend and never creates
 * a user, session, or invitation.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { submitAccessRequest } from './access-request-action';

const ACCESS_TYPE_OPTIONS = [
  'Employee',
  'Company Administrator',
  'Creator',
  'Partner / Vendor',
  'Other',
];

type Status = 'idle' | 'submitting' | 'success' | 'error';

export function RequestAccessModal() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [renderedAt, setRenderedAt] = useState(0);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const titleId = useId();
  const descId = useId();

  const openModal = useCallback(() => {
    setStatus('idle');
    setErrors({});
    setMessage('');
    setRenderedAt(Date.now());
    setOpen(true);
  }, []);

  const closeModal = useCallback(() => {
    if (status === 'submitting') return; // never close while submitting
    setOpen(false);
    // return focus to the trigger
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, [status]);

  // Lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

  return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Move focus into the dialog when opened.
  useEffect(() => {
    if (open && status !== 'success') {
      requestAnimationFrame(() => firstFieldRef.current?.focus());
    }
  }, [open, status]);

  // Escape to close + focus trap.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, closeModal]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === 'submitting') return;
    const form = e.currentTarget;
    const data = new FormData(form);
    setStatus('submitting');
    setErrors({});
    setMessage('');
    try {
      const result = await submitAccessRequest({
        fullName: String(data.get('fullName') ?? ''),
        email: String(data.get('email') ?? ''),
        company: String(data.get('company') ?? ''),
        accessType: String(data.get('accessType') ?? ''),
        website: String(data.get('website') ?? ''),
        renderedAt,
      });
      if (result.ok) {
        setStatus('success');
      } else {
        setStatus('error');
        setErrors(result.errors ?? {});
        setMessage(
          result.message ??
            "We couldn't submit your request right now. Please try again.",
        );
        // form values are preserved because we never reset the form on error
      }
    } catch {
      setStatus('error');
      setMessage("We couldn't submit your request right now. Please try again.");
    }
  }

  const overlayNode = (
        <div
          className="loop-reqaccess__overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div
            ref={dialogRef}
            className="loop-reqaccess__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descId}
          >
            <button
              type="button"
              className="loop-reqaccess__close"
              aria-label="Close"
              onClick={closeModal}
            >
              <span aria-hidden="true">&times;</span>
            </button>

            {status === 'success' ? (
              <div className="loop-reqaccess__confirm">
                <h2 id={titleId} className="loop-reqaccess__title">
                  Request received
                </h2>
                <p id={descId} className="loop-reqaccess__subtitle">
                  Complete the form below and we&apos;ll review your request. If
                  approved, you&apos;ll receive a secure email with instructions
                  to access Loop.
                </p>
                <div className="loop-reqaccess__actions">
                  <button
                    type="button"
                    className="loop-reqaccess__submit"
                    onClick={closeModal}
                  >
                    Close
                  </button>
                </div>
              </div>
            ) : (
              <form className="loop-reqaccess__form" onSubmit={handleSubmit} noValidate>
                <h2 id={titleId} className="loop-reqaccess__title">
                  Request Access
                </h2>
                <p id={descId} className="loop-reqaccess__subtitle">
                  Complete the form below and we&apos;ll review your request. If
                  approved, you&apos;ll receive a secure email with instructions
                  to access Loop.
                </p>

                {status === 'error' && message ? (
                  <p className="loop-reqaccess__error" role="alert">
                    {message}
                  </p>
                ) : null}

                {/* Honeypot: visually hidden, off-screen, not announced. */}
                <div className="loop-reqaccess__hp" aria-hidden="true">
                  <label htmlFor="website">Website</label>
                  <input
                    id="website"
                    name="website"
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                  />
                </div>

                <div className="loop-reqaccess__field">
                  <label htmlFor="ra-fullName">Full name</label>
                  <input
                    ref={firstFieldRef}
                    id="ra-fullName"
                    name="fullName"
                    type="text"
                    required
                    maxLength={100}
                    aria-invalid={Boolean(errors.fullName) || undefined}
                  />
                  {errors.fullName ? (
                    <span className="loop-reqaccess__fielderr">{errors.fullName}</span>
                  ) : null}
                </div>

                <div className="loop-reqaccess__field">
                  <label htmlFor="ra-email">Work email</label>
                  <input
                    id="ra-email"
                    name="email"
                    type="email"
                    required
                    maxLength={254}
                    aria-invalid={Boolean(errors.email) || undefined}
                  />
                  {errors.email ? (
                    <span className="loop-reqaccess__fielderr">{errors.email}</span>
                  ) : null}
                </div>

                <div className="loop-reqaccess__field">
                  <label htmlFor="ra-company">Company or organization</label>
                  <input
                    id="ra-company"
                    name="company"
                    type="text"
                    required
                    maxLength={150}
                    aria-invalid={Boolean(errors.company) || undefined}
                  />
                  {errors.company ? (
                    <span className="loop-reqaccess__fielderr">{errors.company}</span>
                  ) : null}
                </div>

                <div className="loop-reqaccess__field">
                  <label htmlFor="ra-accessType">
                    What type of access do you need?
                  </label>
                  <select
                    id="ra-accessType"
                    name="accessType"
                    required
                    defaultValue=""
                    aria-invalid={Boolean(errors.accessType) || undefined}
                  >
                    <option value="" disabled>
                      Select an option
                    </option>
                    {ACCESS_TYPE_OPTIONS.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                  {errors.accessType ? (
                    <span className="loop-reqaccess__fielderr">{errors.accessType}</span>
                  ) : null}
                </div>

                <p className="loop-reqaccess__hint">
                  We&apos;ll review your request before granting access.
                </p>

                <div className="loop-reqaccess__actions">
                  <button
                    type="button"
                    className="loop-reqaccess__cancel"
                    onClick={closeModal}
                    disabled={status === 'submitting'}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="loop-reqaccess__submit"
                    disabled={status === 'submitting'}
                  >
                    {status === 'submitting' ? 'Submitting…' : 'Submit Request'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="loop-auth__invite-btn"
        onClick={openModal}
      >
        Request Access
      </button>

      {open && mounted ? createPortal(overlayNode, document.body) : null}
    </>
  );
}
