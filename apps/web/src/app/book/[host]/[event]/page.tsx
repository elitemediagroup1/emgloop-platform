import { prisma } from '@emgloop/database';
import { zonedParts } from '@emgloop/shared';
import { notFound } from 'next/navigation';
import { bookingSlots } from '../../../../booking/slots';
import type { EmployeeAvailability } from '../../../../booking/availability';

export const dynamic = 'force-dynamic';

function isoDay(day: Date) {
  return day.toISOString().slice(0, 10);
}

export default async function EventBookingPage({
  params,
  searchParams,
}: {
  params: { host: string; event: string };
  searchParams: { date?: string };
}) {
  const slug = /^[a-z0-9-]{1,64}$/;
  if (!slug.test(params.host) || !slug.test(params.event)) notFound();
  const event = await prisma.employeeBookingEventType.findFirst({
    where: {
      slug: params.event,
      isPublished: true,
      profile: { slug: params.host, isPublished: true, user: { status: 'ACTIVE' } },
    },
    select: {
      title: true, description: true, durationMinutes: true, settings: true,
      profile: {
        select: {
          timeZone: true, weeklyHours: true, dateOverrides: true, blockedTimes: true,
          user: { select: { name: true } },
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
  const requested = typeof searchParams.date === 'string' ? searchParams.date : '';
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
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: availability.timeZone });

  return (
    <main>
      <p>{user.name ?? 'EMG'} · {event.durationMinutes} minutes · Google Meet</p>
      <h1>{event.title}</h1>
      {event.description && <p>{event.description}</p>}
      <p>Schedule preview. Live calendar conflicts and booking are unavailable.</p>
      <form>
        <label>Date <input type="date" name="date" min={isoDay(firstDay)} max={isoDay(lastDay)} defaultValue={date} required /></label>
        <button type="submit">Show scheduled hours</button>
      </form>
      <h2>Scheduled start times ({availability.timeZone})</h2>
      {slots.length ? (
        <ul>{slots.map((slot) => (
          <li key={slot.start}><time dateTime={new Date(slot.start).toISOString()}>{time.format(slot.start)}</time></li>
        ))}</ul>
      ) : <p>No start times are scheduled for this date.</p>}
    </main>
  );
}
