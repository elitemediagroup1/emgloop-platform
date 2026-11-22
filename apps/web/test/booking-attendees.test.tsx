import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBookingAttendees } from '../src/booking/attendees';
import { createGoogleMeetEvent } from '../src/booking/google-calendar';

test('the booker and additional guests are each included once in the Calendar invite', async (t) => {
  const attendeeEmails = parseBookingAttendees('matt@example.com', 'charlie@example.com,\njonathan@example.com; MATT@example.com');
  assert.ok(attendeeEmails);

  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'booking1' }));
  await createGoogleMeetEvent('test-token', {
    calendarId: 'primary',
    eventId: 'booking1',
    title: 'Discovery call',
    slot: { start: 1_800_000_000_000, end: 1_800_001_800_000 },
    attendeeEmails,
  });

  assert.equal(fetch.mock.callCount(), 1);
  const [url, init] = fetch.mock.calls[0]!.arguments as unknown as [string, RequestInit];
  assert.equal(new URL(url).searchParams.get('sendUpdates'), 'all');
  const body = JSON.parse(String(init.body));
  assert.deepEqual(body.attendees, [
    { email: 'matt@example.com' },
    { email: 'charlie@example.com' },
    { email: 'jonathan@example.com' },
  ]);
  assert.equal(body.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
});

test('an invalid additional email is rejected instead of silently dropping an attendee', () => {
  assert.equal(parseBookingAttendees('matt@example.com', 'charlie@example.com, broken'), null);
});
