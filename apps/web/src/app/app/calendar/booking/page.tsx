import { bookingSlug, provisionEmployeeBookingProfile } from '../../../../booking/provision-profile';
import { prisma, type Prisma } from '@emgloop/database';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requirePermission } from '../../../../auth/guard';
import WorkspaceShell from '../../../../workspaces/WorkspaceShell';
import { LoopPage, PageHead } from '../../_loop-os/record';

const path = '/app/calendar/booking';
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const policies = ['OFF', 'EXTERNAL_ONLY', 'ALL_MEETINGS'] as const;

async function employee() {
  const session = await requirePermission('employeeIntelligence', 'view');
  if (!['OWNER', 'ADMIN', 'MANAGER', 'EMPLOYEE'].includes(session.systemRole)) {
    redirect('/crm/unauthorized');
  }
  return session;
}

async function createProfile() {
  'use server';
  await provisionEmployeeBookingProfile(await employee());
  revalidatePath(path);
}

function intervals(value: string) {
  if (!value.trim()) return [];
  const result = value.split(',').map((entry) => {
    const match = /^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/.exec(entry.trim());
    if (!match) throw new Error('Use 24-hour time ranges such as 09:00-13:00.');
    const [, sh, sm, eh, em] = match.map(Number);
    const startMinute = sh! * 60 + sm!;
    const endMinute = eh! * 60 + em!;
    if (sm! > 59 || em! > 59 || endMinute > 1440 || startMinute >= endMinute) {
      throw new Error('Enter a valid time range.');
    }
    return { startMinute, endMinute };
  }).sort((a, b) => a.startMinute - b.startMinute);
  if (result.some((item, index) => index > 0 && result[index - 1]!.endMinute > item.startMinute)) {
    throw new Error('Working hours cannot overlap.');
  }
  return result;
}

async function saveSchedule(form: FormData) {
  'use server';
  const session = await employee();
  const timeZone = String(form.get('timeZone') ?? '').trim();
  if (!timeZone || timeZone.length > 100) throw new Error('Enter a time zone.');
  new Intl.DateTimeFormat('en-US', { timeZone });
  const notetakerDefault = policies.find((value) => value === form.get('policy'));
  if (!notetakerDefault) throw new Error('Choose a Notetaker setting.');
  const weeklyHours = Object.fromEntries(weekdays.map((_, index) => [index, intervals(String(form.get(`day-${index}`) ?? ''))]));
  const dateOverrides = Object.fromEntries(String(form.get('overrides') ?? '').split('\n')
    .map((line) => line.trim()).filter(Boolean).map((line) => {
      const match = /^(\d{4}-\d{2}-\d{2})(?:\s+(.*))?$/.exec(line);
      if (!match) throw new Error('Use YYYY-MM-DD for a day off.');
      const date = new Date(`${match[1]}T00:00:00Z`);
      if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== match[1]) throw new Error('Enter a valid date.');
      return [match[1]!, intervals(match[2] ?? '')];
    }));
  await prisma.employeeBookingProfile.update({
    where: { userId: session.userId },
    data: { timeZone, notetakerDefault, weeklyHours, dateOverrides },
  });
  revalidatePath(path);
}

async function addEvent(form: FormData) {
  'use server';
  const session = await employee();
  const title = String(form.get('title') ?? '').trim().slice(0, 100);
  const slug = bookingSlug(String(form.get('slug') || title));
  const durationMinutes = Number(form.get('duration'));
  const style = form.get('style') === 'GROUP' ? 'GROUP' : 'ONE_ON_ONE';
  const groupCapacity = style === 'GROUP' ? Number(form.get('capacity')) : null;
  if (!title || !slug || !Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 240 ||
      (groupCapacity !== null && (!Number.isInteger(groupCapacity) || groupCapacity < 2 || groupCapacity > 100))) {
    throw new Error('Enter a title, duration, and valid capacity.');
  }
  await prisma.employeeBookingEventType.create({
    data: { profileUserId: session.userId, title, slug, durationMinutes, style, groupCapacity },
  });
  revalidatePath(path);
}

async function saveEventSettings(form: FormData) {
  'use server';
  const session = await employee();
  const submitted = form.get('eventPolicy');
  const notetakerPolicy = submitted === 'INHERIT' ? null : policies.find((item) => item === submitted);
  if (notetakerPolicy === undefined) throw new Error('Choose a Notetaker setting.');
  const title = String(form.get('eventTitle') ?? '').trim().slice(0, 100);
  if (!title) throw new Error('Enter an event title.');
  const description = String(form.get('description') ?? '').trim().slice(0, 1500) || null;
  const limits = Object.fromEntries(
    ['noticeMinutes', 'incrementMinutes', 'bufferBeforeMinutes', 'bufferAfterMinutes', 'bookingWindowDays'].map((key) => {
      const value = Number(form.get(key));
      const minimum = key === 'incrementMinutes' || key === 'bookingWindowDays' ? 1 : 0;
      const maximum = key === 'bookingWindowDays' ? 365 : key === 'noticeMinutes' ? 10080 : 240;
      if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error('Enter valid booking limits.');
      return [key, value];
    }),
  );
  const { count } = await prisma.employeeBookingEventType.updateMany({
    where: { id: String(form.get('eventId') ?? ''), profileUserId: session.userId },
    data: { title, description, notetakerPolicy, settings: limits },
  });
  if (count !== 1) throw new Error('This event type could not be updated.');
  revalidatePath(path);
}

function displayHours(value: Prisma.JsonValue | undefined): string {
  if (!Array.isArray(value)) return '';
  const format = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        typeof entry.startMinute !== 'number' || typeof entry.endMinute !== 'number') return [];
    return `${format(entry.startMinute)}-${format(entry.endMinute)}`;
  }).join(', ');
}

export default async function BookingSettingsPage() {
  const session = await employee();
  const profile = await prisma.employeeBookingProfile.findUnique({
    where: { userId: session.userId }, include: { eventTypes: { orderBy: { createdAt: 'asc' } } },
  });
  const weekly = profile?.weeklyHours as Prisma.JsonObject | undefined;
  const overrides = profile?.dateOverrides as Prisma.JsonObject | undefined;
  return (
    <WorkspaceShell session={session}>
    <LoopPage label="Booking settings">
      <PageHead trail={[{ label: "Calendar", href: "/app/calendar" }, { label: "Booking settings" }]} title="Booking settings" subtitle="Manage your link, meeting types, and availability." />
      {!profile ? (
        <form action={createProfile}><button type="submit">Reserve my booking link</button></form>
      ) : (
        <>
          <p>Reserved link <strong>book.emgloop.com/{profile.slug}</strong></p>
          <form action={saveSchedule} className="loop-panel">
            <h2>Availability</h2>
            <p>Use 24-hour time ranges separated by commas. Leave a day blank to keep it unavailable.</p>
            {weekdays.map((day, index) => (
              <p key={day}><label>{day} <input name={`day-${index}`} defaultValue={displayHours(weekly?.[index])} placeholder="09:00-13:00, 15:00-16:00" maxLength={180} /></label></p>
            ))}
            <p><label>Time zone <input name="timeZone" defaultValue={profile.timeZone} required /></label></p>
            <p><label>Date overrides <textarea name="overrides" rows={5} maxLength={8000}
              defaultValue={Object.entries(overrides ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([date, hours]) => `${date} ${displayHours(hours)}`.trim()).join('\n')}
              placeholder={'2027-01-18\n2027-01-19 13:00-16:00'} /></label></p>
            <p>Enter a date by itself to block the full day, or add time ranges to specify the only hours available that day.</p>
            <p><label>Default Notetaker <select name="policy" defaultValue={profile.notetakerDefault}>
              <option value="OFF">Off</option><option value="EXTERNAL_ONLY">External meetings only</option><option value="ALL_MEETINGS">All eligible meetings</option>
            </select></label></p>
            <button type="submit">Save availability</button>
          </form>
          <section className="loop-panel">
            <h2>Event types</h2>
            <ul>{profile.eventTypes.map((event) => (
              <li key={event.id}>
                <p>{event.title} · {event.durationMinutes} min · /{profile.slug}/{event.slug} · {event.isPublished ? 'Published' : 'Draft'}</p>
                <form action={saveEventSettings}>
                  <input type="hidden" name="eventId" value={event.id} />
                  <p><label>Event title <input name="eventTitle" defaultValue={event.title} required maxLength={100} /></label></p>
                  <p><label>Description <textarea name="description" defaultValue={event.description ?? ''} maxLength={1500} /></label></p>
                  {[
                    { key: 'noticeMinutes', label: 'Minimum notice in minutes', initial: 60, min: 0, max: 10080 },
                    { key: 'incrementMinutes', label: 'Start-time interval in minutes', initial: 30, min: 1, max: 240 },
                    { key: 'bufferBeforeMinutes', label: 'Buffer before in minutes', initial: 0, min: 0, max: 240 },
                    { key: 'bufferAfterMinutes', label: 'Buffer after in minutes', initial: 0, min: 0, max: 240 },
                    { key: 'bookingWindowDays', label: 'How far ahead guests can book in days', initial: 30, min: 1, max: 365 },
                  ].map(({ key, label, initial, min, max }) => {
                    const stored = (event.settings as Prisma.JsonObject)[key];
                    return <p key={key}><label>{label} <input name={key} type="number" min={min} max={max} defaultValue={typeof stored === 'number' ? stored : initial} required /></label></p>;
                  })}
                  <label>Notetaker for {event.title} <select name="eventPolicy" defaultValue={event.notetakerPolicy ?? 'INHERIT'}>
                    <option value="INHERIT">Use my default</option>
                    <option value="OFF">Off</option>
                    <option value="EXTERNAL_ONLY">External meetings only</option>
                    <option value="ALL_MEETINGS">All eligible meetings</option>
                  </select></label>
                  <button type="submit">Save event settings</button>
                </form>
              </li>
            ))}</ul>
            <form action={addEvent}>
              <p><label>Title <input name="title" required maxLength={100} /></label></p>
              <p><label>Link ending <input name="slug" placeholder="30-minute-call" maxLength={48} /></label></p>
              <p><label>Duration in minutes <input name="duration" type="number" defaultValue={30} min={5} max={240} required /></label></p>
              <p><label>Meeting style <select name="style"><option value="ONE_ON_ONE">One-on-one</option><option value="GROUP">Group</option></select></label></p>
              <p><label>Group capacity <input name="capacity" type="number" min={2} max={100} defaultValue={2} /></label></p>
              <button type="submit">Create event draft</button>
            </form>
          </section>
        </>
      )}
    </LoopPage>
    </WorkspaceShell>
  );
}
