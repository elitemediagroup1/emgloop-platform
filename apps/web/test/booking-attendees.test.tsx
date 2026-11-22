import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBookingAttendees } from '../src/booking/attendees';
import { createGoogleMeetEvent, inviteGoogleMeetAttendees } from '../src/booking/google-calendar';

test('the booker and additional guests are each included once in the Calendar invite', async (t) => {
  const attendeeEmails = parseBookingAttendees('matt@example.com', 'charlie@example.com,\njonathan@example.com; MATT@example.com');
  assert.ok(attendeeEmails);

  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ id: 'booking1' }));
  await createGoogleMeetEvent('test-token', {
    calendarId: 'primary',
    eventId: 'booking1',
    title: 'Discovery call',
    slot: { start: 1_800_000_000_000, end: 1_800_001_800_000 },
  });

  const meeting = { hangoutLink: 'https://meet.google.com/abc-defg-hij', etag: '"booking"' };
  assert.equal(await inviteGoogleMeetAttendees('test-token', 'booking1', {}, attendeeEmails), false);
  assert.equal(await inviteGoogleMeetAttendees('test-token', 'booking1', meeting, attendeeEmails), true);
  assert.equal(fetch.mock.callCount(), 2);
  const [createUrl, createInit] = fetch.mock.calls[0]!.arguments as unknown as [string, RequestInit];
  assert.equal(new URL(createUrl).searchParams.get('sendUpdates'), 'none');
  assert.equal(JSON.parse(String(createInit.body)).conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  const [url, init] = fetch.mock.calls[1]!.arguments as unknown as [string, RequestInit];
  assert.equal(new URL(url).searchParams.get('sendUpdates'), 'all');
  assert.equal(new Headers(init.headers).get('If-Match'), meeting.etag);
  assert.deepEqual(JSON.parse(String(init.body)).attendees, [
    { email: 'matt@example.com' },
    { email: 'charlie@example.com' },
    { email: 'jonathan@example.com' },
  ]);
  assert.equal(await inviteGoogleMeetAttendees('test-token', 'booking1', {
    ...meeting, attendees: attendeeEmails.map((email) => ({ email })),
  }, attendeeEmails), true);
  assert.equal(fetch.mock.callCount(), 2, 'retry skips attendees Google already has');
});

test('an invalid additional email is rejected instead of silently dropping an attendee', () => {
  assert.equal(parseBookingAttendees('matt@example.com', 'charlie@example.com, broken'), null);
});
