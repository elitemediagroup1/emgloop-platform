import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { prisma } from '@emgloop/database';
import { zonedParts } from '@emgloop/shared';
import { notFound, redirect } from 'next/navigation';
import { MAX_GUEST_EMAIL_INPUT, parseBookingAttendees } from '../../../../booking/attendees';
import { bookingSlots } from '../../../../booking/slots';
import type { EmployeeAvailability } from '../../../../booking/availability';

export const dynamic = 'force-dynamic';

function isoDay(day: Date) {
  return day.toISOString().slice(0, 10);
}

async function loadSchedule(host: string, eventSlug: string, requested: string) {
  const slug = /^[a-z0-9-]{1,64}$/;
  if (!slug.test(host) || !slug.test(eventSlug)) notFound();
  const event = await prisma.employeeBookingEventType.findFirst({
    where: {
      slug: eventSlug,
      isPublished: true,
      profile: { slug: host, isPublished: true, user: { status: 'ACTIVE' } },
    },
    select: {
      id: true, profileUserId: true, title: true, description: true, durationMinutes: true, settings: true,
      profile: {
        select: {
          timeZone: true, weeklyHours: true, dateOverrides: true, blockedTimes: true,
          user: { select: { name: true, organizationId: true } },
        },
      },
    },
  });
  if (!event) notFound();

  const { user, ...profile } = event.profile;
  const availability = profile as unknown as EmployeeAvailability;
  const settings = event.settings as Record<string, unknown>;
  const readSetting = (key: string, fallback: number, min: number, max: number) => {
    const value = settings?.[key];
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  };
  const now = Date.now();
  const today = zonedParts(new Date(now), availability.timeZone);
  const firstDay = new Date(Date.UTC(today.year, today.month - 1, today.day));
  const windowDays = readSetting('bookingWindowDays', 30, 1, 365);
  const lastDay = new Date(firstDay.valueOf() + (windowDays - 1) * 86_400_000);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(requested) && isoDay(firstDay) <= requested && requested <= isoDay(lastDay)
    ? requested : isoDay(firstDay);
  const slots = bookingSlots({
    availability,
    hostDate: date,
    now,
    durationMinutes: event.durationMinutes,
    incrementMinutes: readSetting('incrementMinutes', 30, 1, 240),
    noticeMinutes: readSetting('noticeMinutes', 60, 0, 10080),
    bufferBeforeMinutes: readSetting('bufferBeforeMinutes', 0, 0, 240),
    bufferAfterMinutes: readSetting('bufferAfterMinutes', 0, 0, 240),
    calendarBusy: [],
  });
  return { event, user, availability, date, slots, firstDay, lastDay };
}

const requestsEnabled = () => process.env.LOOP_BOOKING_REQUESTS_ENABLED === 'true';

export default async function EventBookingPage({
  params,
  searchParams,
}: {
  params: { host: string; event: string };
  searchParams: { date?: string; request?: string };
}) {
  const { host, event: eventSlug } = params;
  const requested = typeof searchParams.date === 'string' ? searchParams.date : '';
  const { event, user, availability, date, slots, firstDay, lastDay } = await loadSchedule(host, eventSlug, requested);
  const requestId = randomUUID();
  const prefix = headers().get('host') === 'book.emgloop.com' ? '' : '/book';

  async function requestBooking(form: FormData) {
    'use server';
    if (!requestsEnabled()) notFound();
    const path = `${prefix}/${host}/${eventSlug}`;
    const returnTo = (status: string) => redirect(`${path}?date=${date}&request=${status}`);
    const guestName = String(form.get('guestName') ?? '').trim();
    const guestEmail = String(form.get('guestEmail') ?? '').trim().toLowerCase();
    const attendeeEmails = parseBookingAttendees(guestEmail, String(form.get('additionalGuests') ?? ''));
    const start = Number(form.get('start'));
    if (!guestName || guestName.length > 120 || !attendeeEmails || !Number.isSafeInteger(start)) {
      return returnTo('invalid');
    }
    const latest = await loadSchedule(host, eventSlug, date);
    const slot = latest.slots.find((candidate) => candidate.start === start);
    if (!slot || latest.date !== date) returnTo('unavailable');
    if (!slot) return;

    await prisma.booking.upsert({
      where: { id: requestId },
      update: {},
      create: {
        id: requestId,
        organizationId: latest.user.organizationId,
        title: latest.event.title,
        status: 'REQUESTED',
        startAt: new Date(slot.start),
        endAt: new Date(slot.end),
        attributes: {
          source: 'employee-booking-request',
          profileUserId: latest.event.profileUserId,
          eventTypeId: latest.event.id,
          guestName,
          guestEmail,
          attendeeEmails,
        },
      },
    });
    returnTo('received');
  }

  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: availability.timeZone });

  return (
    <main>
      <p>{user.name ?? 'EMG'} · {event.durationMinutes} minutes · Google Meet</p>
      <h1>{event.title}</h1>
      {event.description && <p>{event.description}</p>}
      {requestsEnabled() ? (
        <p>Request a time for this meeting. A request does not confirm the appointment or send a calendar invite.</p>
      ) : <p>Schedule preview. Live calendar conflicts and booking are unavailable.</p>}
      {searchParams.request === 'received' && <p role="status">Your request was received. The meeting is not confirmed.</p>}
      {searchParams.request === 'invalid' && <p role="alert">Enter your name, choose a time, and use valid email addresses for up to 50 attendees.</p>}
      {searchParams.request === 'unavailable' && <p role="alert">That time is no longer available. Choose another time.</p>}
      <form>
        <label>Date <input type="date" name="date" min={isoDay(firstDay)} max={isoDay(lastDay)} defaultValue={date} required /></label>
        <button type="submit">Show scheduled hours</button>
      </form>
      <h2>Scheduled start times ({availability.timeZone})</h2>
      {slots.length && requestsEnabled() ? (
        <form action={requestBooking}>
          <p><label>Start time <select name="start" required>
            <option value="">Choose a time</option>
            {slots.map((slot) => <option key={slot.start} value={slot.start}>{time.format(slot.start)}</option>)}
          </select></label></p>
          <p><label>Your name <input name="guestName" autoComplete="name" maxLength={120} required /></label></p>
          <p><label>Email <input name="guestEmail" type="email" autoComplete="email" maxLength={254} required /></label></p>
          <p>
            <label>Additional attendee emails (optional)
              <textarea name="additionalGuests" maxLength={MAX_GUEST_EMAIL_INPUT} rows={3} aria-describedby="guest-email-help" />
            </label>
            <span id="guest-email-help">Separate email addresses with a comma or put each on its own line.</span>
          </p>
          <button type="submit">Request meeting</button>
        </form>
      ) : slots.length ? (
        <ul>{slots.map((slot) => (
          <li key={slot.start}><time dateTime={new Date(slot.start).toISOString()}>{time.format(slot.start)}</time></li>
        ))}</ul>
      ) : <p>No start times are scheduled for this date.</p>}
    </main>
  );
}
