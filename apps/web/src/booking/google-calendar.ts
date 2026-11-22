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
    const calendar = result.calendars?.[id];
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

export async function createGoogleMeetEvent(token: string, event: {
  calendarId: string;
  eventId: string;
  title: string;
  slot: BusyPeriod;
  attendeeEmails: readonly string[];
}) {
  // Reuse the persisted event ID and conference request ID when retrying this booking.
  if (!/^[a-v0-9]{5,1024}$/.test(event.eventId)) throw new Error('Invalid Google Calendar event ID.');
  const [bookerEmail, ...guests] = event.attendeeEmails;
  const attendees = bookerEmail ? bookingAttendeeEmails(bookerEmail, guests) : null;
  if (!attendees) throw new Error('A valid booking attendee list is required.');
  return calendarRequest(
    `/calendars/${encodeURIComponent(event.calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`,
    token,
    {
      id: event.eventId,
      summary: event.title,
      start: { dateTime: new Date(event.slot.start).toISOString() },
      end: { dateTime: new Date(event.slot.end).toISOString() },
      attendees: attendees.map((email) => ({ email })),
      conferenceData: {
        createRequest: { requestId: event.eventId, conferenceSolutionKey: { type: 'hangoutsMeet' } },
      },
    },
  );
}
