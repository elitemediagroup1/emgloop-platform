'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { MAX_GUEST_EMAIL_INPUT } from '../../../booking/attendees';
import styles from './guest-calendar.module.css';
import publicStyles from './public-booking.module.css';

export type BookingRequestState = 'idle' | 'received' | 'invalid' | 'unavailable' | 'failed';

function RequestButton() {
  const { pending } = useFormStatus();
  return (
    <button className={publicStyles.button} type="submit" disabled={pending}>
      {pending ? 'Sending request…' : 'Request meeting'}
    </button>
  );
}

const requestErrors = {
  invalid: 'Check your name and the attendee email addresses, then try again.',
  unavailable: 'That time is no longer available. Choose another date or time.',
  failed: 'We couldn’t save your request. Please try again.',
};

export function GuestTimeSlots({
  slots, date, timeZone, enabled, requestBooking,
}: {
  slots: number[];
  date?: string;
  timeZone: string;
  enabled: boolean;
  requestBooking: (state: BookingRequestState, form: FormData) => Promise<BookingRequestState>;
}) {
  const [zone, setZone] = useState(timeZone);
  const [requestState, submitRequest] = useFormState(requestBooking, 'idle');
  const [selection, select] = useState<{ date: string; start: number } | null>(null);
  const selected = selection && selection.date === date && slots.includes(selection.start) ? selection.start : null;
  const zones = [...new Set([
    timeZone, 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Phoenix', 'Pacific/Honolulu', 'Europe/London', 'Europe/Paris', 'Asia/Kolkata',
    'Asia/Tokyo', 'Australia/Sydney', 'UTC',
  ])];
  const fullTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: zone });
  const slotTime = zone === timeZone
    ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone })
    : fullTime;
  return (
    <>
      <label className={styles.zone}>Time zone
        <select value={zone} onChange={(event) => setZone(event.target.value)}>
          {zones.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
        </select>
      </label>
      {zone !== timeZone && <p className={styles.hint}>Times use your selection. Calendar dates follow {timeZone.replaceAll('_', ' ')}.</p>}
      {date && (
        <div className={styles.slotSection}>
          <h3>{new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))}</h3>
          {slots.length ? (
            <div className={styles.slotGrid} aria-label="Available times">
              {slots.map((start) => enabled ? (
                <button type="button" key={start} aria-pressed={selected === start} onClick={() => select({ date, start })} disabled={requestState === 'received'}>
                  {slotTime.format(start)}
                </button>
              ) : <span key={start}>{slotTime.format(start)}</span>)}
            </div>
          ) : <p>No times remain for this date.</p>}
        </div>
      )}
      {requestState === 'received' && (
        <div className={styles.confirmation} role="status" tabIndex={-1} ref={(node) => node?.focus()}>
          <h3>Request sent</h3>
          <p>The host received your request. Watch for the Google Meet invitation after they confirm.</p>
        </div>
      )}
      {enabled && selected !== null && requestState !== 'received' && (
        <form className={`${publicStyles.form} ${styles.requestForm}`} action={submitRequest}>
          <h3>Request this meeting</h3>
          <p><strong>{fullTime.format(selected)}</strong> · {zone.replaceAll('_', ' ')}</p>
          <input name="start" type="hidden" value={selected} />
          <label>Your name <input name="guestName" autoComplete="name" maxLength={120} required /></label>
          <label>Email <input name="guestEmail" type="email" autoComplete="email" maxLength={254} required /></label>
          <label>Additional attendee emails <small>Optional. Separate addresses with commas or line breaks.</small>
            <textarea name="additionalGuests" maxLength={MAX_GUEST_EMAIL_INPUT} rows={2} />
          </label>
          {requestState !== 'idle' && <p className={styles.error} role="alert">{requestErrors[requestState]}</p>}
          <RequestButton />
          <small>The host confirms your request before Google sends an invitation.</small>
        </form>
      )}
    </>
  );
}
