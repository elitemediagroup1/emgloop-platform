import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesisRecipient } from '../src/intelligence/synthesis-recipient';
const person = (userId: string, hasBriefing: boolean) => ({
  organizationId: 'our-org',
  userId,
  timeZone: 'America/New_York',
  hasBriefing,
});
test('briefing slots prioritize missing daily delivery; situation slots retain their normal rotation', () => {
  const people = [person('a', true), person('z', false)];
  assert.equal(synthesisRecipient(people, 'briefing', 0, 0)?.userId, 'z');
  assert.equal(synthesisRecipient(people, 'private', 0, 0)?.userId, 'a');
  assert.equal(synthesisRecipient([], 'briefing', 0, 0), null);
});
test('once everyone has a brief, an unchanged oldest candidate cannot monopolize every scheduled pass', () => {
  const people = [person('c', true), person('a', true), person('b', true)];
  const selected = [0, 1, 2].map(
    (bucket) => synthesisRecipient(people, 'briefing', bucket * 15 * 60000, 0)?.userId,
  );
  assert.deepEqual(selected, ['a', 'b', 'c']);
  assert.equal(synthesisRecipient(people, 'briefing', 0, 1)?.userId, 'b');
});
