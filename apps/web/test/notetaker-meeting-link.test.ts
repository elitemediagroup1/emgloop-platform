import assert from 'node:assert/strict';
import test from 'node:test';
import { supportedMeetingUrl } from '../src/notetaker/meeting-link';

test('accepts supported join links and preserves meeting passcodes', () => {
  assert.equal(supportedMeetingUrl('https://meet.google.com/abc-defg-hij/?authuser=1'), 'https://meet.google.com/abc-defg-hij');
  const zoom = 'https://us02web.zoom.us/j/12345678901?pwd=abc';
  const teams = 'https://teams.microsoft.com/meet/123456789?p=abc';
  const webex = 'https://example.webex.com/meet/matt';
  for (const url of [zoom, teams, webex]) assert.equal(supportedMeetingUrl(url), url);
});

test('rejects lookalike hosts, credentials, and nonmeeting pages', () => {
  for (const url of [
    'https://zoom.us.example.org/j/123456789',
    'https://host@meet.google.com/abc-defg-hij',
    'https://meet.google.com:8080/abc-defg-hij',
    'https://zoom.us/account',
    'http://meet.google.com/abc-defg-hij',
  ]) assert.equal(supportedMeetingUrl(url), null);
});
