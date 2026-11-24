import 'server-only';
import { bookingAttendeeEmails } from './attendees';
import type { BusyPeriod } from './availability';

const calendarApi = 'https://www.googleapis.com/calendar/v3';

async function calendarRequest(path: string, token: string, body: object) {
  const response = await fetch(`${calendarApi}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Google Calendar request failed (${response.status}).`);
  return response.json() as Promise<unknown>;
}

export async function googleBusyPeriods(
  token: string, calendarIds: readonly string[], window: BusyPeriod,
): Promise<BusyPeriod[]> {
  if (calendarIds.length === 0 || calendarIds.length > 50 || window.start >= window.end) {
    throw new Error('Invalid calendar availability request.');
  }
  const result = await calendarRequest('/freeBusy', token, {
    timeMin: new Date(window.start).toISOString(),
    timeMax: new Date(window.end).toISOString(),
    items: calendarIds.map((id) => ({ id })),
  }) as { calendars?: Record<string, { errors?: unknown[]; busy?: { start: string; end: string }[] }> };
  return calendarIds.flatMap((id) => {
    const returned = Object.values(result.calendars ?? {});
    const calendar = result.calendars?.[id] ??
      (id === 'primary' && calendarIds.length === 1 && returned.length === 1 ? returned[0] : undefined);
    if (calendar?.errors?.length || !Array.isArray(calendar?.busy)) {
      throw new Error('Google Calendar availability is incomplete.');
    }
    return calendar.busy.map((interval) => {
      const start = Date.parse(interval.start);
      const end = Date.parse(interval.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
        throw new Error('Google Calendar returned an invalid busy period.');
      }
      return { start, end };
    });
  });
}

export async function findGoogleMeetEvent(token: string, eventId: string) {
  if (!/^[a-v0-9]{5,1024}$/.test(eventId)) throw new Error('Invalid Google Calendar event ID.');
  const response = await fetch(`${calendarApi}/calendars/primary/events/${eventId}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
    cache: 'no-store',
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Google Calendar request failed (${response.status}).`);
  return response.json() as Promise<GoogleBookingEvent>;
}

export interface GoogleBookingEvent {
  hangoutLink?: string;
  status?: string;
  etag?: string;
  description?: string;
  attendees?: { email?: string }[];
}

export async function createGoogleMeetEvent(token: string, event: {
  calendarId: string;
  eventId: string;
  title: string;
  introduction?: string;
  slot: BusyPeriod;
}) {
  // Reuse the persisted event ID and conference request ID when retrying this booking.
  if (!/^[a-v0-9]{5,1024}$/.test(event.eventId)) throw new Error('Invalid Google Calendar event ID.');
  return calendarRequest(
    `/calendars/${encodeURIComponent(event.calendarId)}/events?conferenceDataVersion=1&sendUpdates=none`,
    token,
    {
      id: event.eventId,
      summary: event.title,
      description: event.introduction,
      start: { dateTime: new Date(event.slot.start).toISOString() },
      end: { dateTime: new Date(event.slot.end).toISOString() },
      conferenceData: {
        createRequest: { requestId: event.eventId, conferenceSolutionKey: { type: 'hangoutsMeet' } },
      },
    },
  ) as Promise<GoogleBookingEvent>;
}

export const notetakerInvitationNotice = 'EMG Loop Notetaker is scheduled to join this meeting and automatically record audio once admitted. The host should confirm participants agree before admitting the Notetaker.';

/** Send invitations only after Google has finished provisioning the Meet link. */
export async function inviteGoogleMeetAttendees(
  token: string, eventId: string, meeting: GoogleBookingEvent, attendeeEmails: readonly string[],
  notetakerScheduled = false,
) {
  const [bookerEmail, ...guests] = attendeeEmails;
  const attendees = bookerEmail ? bookingAttendeeEmails(bookerEmail, guests) : null;
  if (!attendees || !/^[a-v0-9]{5,1024}$/.test(eventId)) throw new Error('Invalid booking invitation.');
  if (!meeting.hangoutLink?.startsWith('https://meet.google.com/') || meeting.status === 'cancelled') return false;
  const existing = new Map(
    (meeting.attendees ?? []).flatMap(({ email }) => email ? [[email.toLowerCase(), email] as const] : []),
  );
  const addNotice = notetakerScheduled && !meeting.description?.includes(notetakerInvitationNotice);
  if (!addNotice && attendees.every((email) => existing.has(email.toLowerCase()))) return true;
  if (!meeting.etag) return false;
  for (const email of attendees) existing.set(email.toLowerCase(), email);
  const response = await fetch(`${calendarApi}/calendars/primary/events/${eventId}?conferenceDataVersion=1&sendUpdates=all`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'If-Match': meeting.etag },
    body: JSON.stringify({
      attendees: [...existing.values()].map((email) => ({ email })),
      ...(addNotice ? { description: [meeting.description, notetakerInvitationNotice].filter(Boolean).join('\n\n') } : {}),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  return response.ok;
}
