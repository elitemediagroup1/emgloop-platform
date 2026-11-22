'use client';

import { useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';
import { MAX_GUEST_EMAIL_INPUT } from '../../../booking/attendees';
import styles from './guest-calendar.module.css';
import publicStyles from './public-booking.module.css';

export type BookingRequestState = 'idle' | 'confirmed' | 'invalid' | 'unavailable' | 'failed' | 'pending' | 'calendarUnavailable';

function RequestButton() {
  const { pending } = useFormStatus();
  return (
    <button className={publicStyles.button} type="submit" disabled={pending}>
      {pending ? 'Confirming…' : 'Book meeting'}
    </button>
  );
}

const requestErrors = {
  invalid: 'Check your introduction, name and the attendee email addresses, then try again.',
  unavailable: 'That time is no longer available. Choose another date or time.',
  pending: 'We’re still confirming this booking. Submit again to check its status.',
  calendarUnavailable: 'The host’s calendar is temporarily unavailable. Please try again later.',
  failed: 'We couldn’t complete your booking. Please try again.',
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
                <button type="button" key={start} aria-pressed={selected === start} onClick={() => select({ date, start })} disabled={requestState === 'confirmed'}>
                  {slotTime.format(start)}
                </button>
              ) : <span key={start}>{slotTime.format(start)}</span>)}
            </div>
          ) : <p>No times remain for this date.</p>}
        </div>
      )}
      {requestState === 'confirmed' && (
        <div className={styles.confirmation} role="status" tabIndex={-1} ref={(node) => node?.focus()}>
          <h3>Booking confirmed</h3>
          <p>Check your email for the Google Calendar invitation and Meet link.</p>
        </div>
      )}
      {requestState === 'unavailable' && selected === null && (
        <p className={styles.error} role="alert">{requestErrors.unavailable}</p>
      )}
      {enabled && selected !== null && requestState !== 'confirmed' && (
        <form className={`${publicStyles.form} ${styles.requestForm}`} action={submitRequest}>
          <h3>Book this meeting</h3>
          <p><strong>{fullTime.format(selected)}</strong> · {zone.replaceAll('_', ' ')}</p>
          <input name="start" type="hidden" value={selected} />
          <label>Your name <input name="guestName" autoComplete="name" maxLength={120} required /></label>
          <label>Email <input name="guestEmail" type="email" autoComplete="email" maxLength={254} required /></label>
          <label>What would you like to discuss? <small>Optional</small> <textarea name="introduction" maxLength={800} rows={3} /></label>
          <label>Additional attendee emails <small>Optional. Separate addresses with commas or line breaks.</small>
            <textarea name="additionalGuests" maxLength={MAX_GUEST_EMAIL_INPUT} rows={2} />
          </label>
          {requestState !== 'idle' && <p className={styles.error} role="alert">{requestErrors[requestState]}</p>}
          <RequestButton />
        </form>
      )}
    </>
  );
}
