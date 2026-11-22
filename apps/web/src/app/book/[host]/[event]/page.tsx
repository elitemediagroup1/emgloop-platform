import Link from 'next/link';
import { GuestTimeSlots, type BookingRequestState } from '../../_components/GuestTimeSlots';
import calendarStyles from '../../_components/guest-calendar.module.css';
import { BookingFrame } from '../../_components/BookingFrame';
import styles from '../../_components/public-booking.module.css';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { prisma } from '@emgloop/database';
import { zonedParts } from '@emgloop/shared';
import { notFound } from 'next/navigation';
import { parseBookingAttendees } from '../../../../booking/attendees';
import { bookingDirectory, managerEmail } from '../../../../booking/directory';
import { jointAvailability, withinManagerHours } from '../../../../booking/joint-availability';
import { bookingSlots } from '../../../../booking/slots';
import type { EmployeeAvailability } from '../../../../booking/availability';

export const dynamic = 'force-dynamic';

function isoDay(day: Date) {
  return day.toISOString().slice(0, 10);
}

async function loadSchedule(host: string, eventSlug: string, requested: string, creatorId?: string, month?: string) {
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
    ? requested : undefined;
  const creator = creatorId ? (await bookingDirectory()).creators.find(c => c.id === creatorId) : undefined;
  if (creatorId && (!creator || host !== 'matt')) notFound();
  const selectedMonth = date?.slice(0, 7) ?? month;
  const startMonth = selectedMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(selectedMonth) &&
    selectedMonth >= isoDay(firstDay).slice(0,7) && selectedMonth <= isoDay(lastDay).slice(0,7)
    ? selectedMonth : isoDay(firstDay).slice(0,7);
  const begin = new Date(startMonth + '-01T00:00:00Z');
  const joint = creator ? await jointAvailability(user.organizationId, event.profileUserId, {
    start: begin.valueOf() - 86400000, end: Date.UTC(begin.getUTCFullYear(), begin.getUTCMonth()+1, 2),
  }) : null;
  const slotsForDay = (hostDate: string) => bookingSlots({
    availability,
    hostDate,
    now,
    durationMinutes: event.durationMinutes,
    incrementMinutes: readSetting('incrementMinutes', 30, 1, 240),
    noticeMinutes: readSetting('noticeMinutes', 60, 0, 10080),
    bufferBeforeMinutes: readSetting('bufferBeforeMinutes', 0, 0, 240),
    bufferAfterMinutes: readSetting('bufferAfterMinutes', 0, 0, 240),
    calendarBusy: joint?.busy ?? [],
  }).filter(slot => !creator || (joint && withinManagerHours(slot, joint.hours)));
  return { creator, joint, event, user, availability, date, slotsForDay, firstDay, lastDay };

}

const requestsEnabled = () => process.env.LOOP_BOOKING_REQUESTS_ENABLED === 'true';

export default async function EventBookingPage({
  params,
  searchParams,
}: {
  params: { host: string; event: string };
  searchParams: { date?: string; month?: string; creator?: string };
}) {
  const { host, event: eventSlug } = params;
  const requested = typeof searchParams.date === 'string' ? searchParams.date : '';
  const { creator, joint, event, user, availability, date, slotsForDay, firstDay, lastDay } = await loadSchedule(host, eventSlug, requested, searchParams.creator, searchParams.month);
  const requestId = randomUUID();
  const prefix = headers().get('host') === 'book.emgloop.com' ? '' : '/book';
  const path = `${prefix}/${host}/${eventSlug}`;
  const suffix = creator ? '&creator=' + encodeURIComponent(creator.id) : '';
  const minMonth = isoDay(firstDay).slice(0, 7);
  const maxMonth = isoDay(lastDay).slice(0, 7);
  const requestedMonth = date?.slice(0, 7) ?? searchParams.month;
  const month = typeof requestedMonth === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth) &&
    minMonth <= requestedMonth && requestedMonth <= maxMonth ? requestedMonth : minMonth;
  const monthDate = new Date(`${month}-01T00:00:00Z`);
  const year = monthDate.getUTCFullYear();
  const monthIndex = monthDate.getUTCMonth();
  const previousMonth = isoDay(new Date(Date.UTC(year, monthIndex - 1, 1))).slice(0, 7);
  const nextMonth = isoDay(new Date(Date.UTC(year, monthIndex + 1, 1))).slice(0, 7);
  const dayLabel = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: 'UTC' });
  const monthLabel = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const days = Array.from({ length: new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate() }, (_, index) => {
    const day = new Date(Date.UTC(year, monthIndex, index + 1));
    const key = isoDay(day);
    const slots = key >= isoDay(firstDay) && key <= isoDay(lastDay) ? slotsForDay(key) : [];
    return { key, number: index + 1, label: dayLabel.format(day), slots };
  });
  const selectedDay = days.find((day) => day.key === date);

  async function requestBooking(_previous: BookingRequestState, form: FormData): Promise<BookingRequestState> {
    'use server';
    if (!requestsEnabled()) notFound();
    if (!date) notFound();
    const guestName = String(form.get('guestName') ?? '').trim();
    const guestEmail = String(form.get('guestEmail') ?? '').trim().toLowerCase();
    const attendeeEmails = parseBookingAttendees(guestEmail, String(form.get('additionalGuests') ?? ''));
    const introduction = String(form.get('introduction') ?? '').trim();
    const start = Number(form.get('start'));
    if ((creator && attendeeEmails && attendeeEmails.length >= 50 && !attendeeEmails.includes(managerEmail)) || !introduction || introduction.length > 800 || !guestName || guestName.length > 120 || !attendeeEmails || !Number.isSafeInteger(start)) {
      return 'invalid';
    }
    try {
      const latest = creator ? await loadSchedule(host, eventSlug, date, creator.id) : await loadSchedule(host, eventSlug, date);
      const slot = latest.date === date
        ? latest.slotsForDay(date).find((candidate) => candidate.start === start)
        : undefined;
      if (!slot) return 'unavailable';

      await prisma.booking.upsert({
        where: { id: requestId },
        update: {},
        create: {
          id: requestId,
          organizationId: latest.user.organizationId,
          title: latest.creator ? latest.creator.displayName + ' · Creator management' : latest.event.title,
          status: 'REQUESTED',
          startAt: new Date(slot.start),
          endAt: new Date(slot.end),
          attributes: {
            source: 'employee-booking-request',
            profileUserId: latest.event.profileUserId,
            eventTypeId: latest.event.id,
            guestName,
            guestEmail,
            introduction,
            ...(latest.creator && latest.joint ? { creatorId: latest.creator.id, cohostUserId: latest.joint.manager.userId } : {}),
            attendeeEmails: latest.creator ? [...new Set([...attendeeEmails, managerEmail])] : attendeeEmails,
          },
        },
      });
      return 'received';
    } catch (error) {
      if (error && typeof error === 'object' && 'digest' in error && error.digest === 'NEXT_NOT_FOUND') return 'unavailable';
      return 'failed';
    }
  }

  return (
    <BookingFrame>
      <div className={styles.layout}>
        <aside className={styles.details}>
          <p className={calendarStyles.hostName}>{creator ? 'Matt Dunn and Charlie Brugnolotti' : user.name ?? 'EMG'}</p>
          <h1 className={calendarStyles.hostTitle}>{creator ? creator.displayName + ' · Creator inquiry' : event.title}</h1>
          <dl className={calendarStyles.meta}>
            <div><dt>Duration</dt><dd>{event.durationMinutes} min</dd></div>
            <div><dt>Location</dt><dd>Google Meet · Link sent after confirmation</dd></div>
          </dl>
          {event.description && <p>{event.description}</p>}
        </aside>
        <section className={`${styles.schedule} ${calendarStyles.schedule}`} aria-labelledby="booking-calendar-title">
          <h2 id="booking-calendar-title">Choose a date &amp; time</h2>
          {!requestsEnabled() && <p>Schedule preview. Booking is unavailable.</p>}
          <nav className={calendarStyles.navigation} aria-label="Calendar month navigation">
            {previousMonth >= minMonth ? <Link href={`${path}?month=${previousMonth}${suffix}`} aria-label="Previous month" prefetch={false}>‹</Link> : <span aria-hidden="true">‹</span>}
            <h3>{monthLabel.format(monthDate)}</h3>
            {nextMonth <= maxMonth ? <Link href={`${path}?month=${nextMonth}${suffix}`} aria-label="Next month" prefetch={false}>›</Link> : <span aria-hidden="true">›</span>}
          </nav>
          <div className={calendarStyles.grid} aria-label={`${monthLabel.format(monthDate)} dates`}>
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) =>
              <span key={day} className={calendarStyles.weekday}>{day}</span>,
            )}
            {Array.from({ length: monthDate.getUTCDay() }, (_, index) => <span key={`pad-${index}`} aria-hidden="true" />)}
            {days.map((day) => day.slots.length ? (
              <Link key={day.key} className={calendarStyles.day} href={`${path}?date=${day.key}${suffix}`}
                aria-label={day.label} aria-current={day.key === date ? 'date' : undefined} prefetch={false}>{day.number}</Link>
            ) : <span key={day.key} className={calendarStyles.day} aria-label={`${day.label}, unavailable`}>{day.number}</span>)}
          </div>
          {!days.some((day) => day.slots.length) && <p>{creator && !joint ? 'Joint booking is unavailable until both manager calendars are connected.' : 'No times are scheduled this month.'}</p>}
          <GuestTimeSlots key={date ?? month} slots={selectedDay?.slots.map((slot) => slot.start) ?? []}
            date={selectedDay?.key} timeZone={availability.timeZone} enabled={requestsEnabled()} requestBooking={requestBooking} />
        </section>
      </div>
    </BookingFrame>
  );
}
