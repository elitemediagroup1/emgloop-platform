import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasUnansweredHumanReply } from '../src/crm-outreach/crm-people-command.service';
import { MailContentTriageService } from '../src/services/ai-runtime/mail-content-triage.service';

const principal = { organizationId: 'org', userId: 'viewer' };
const input = { threadId: 'thread', subject: 'Pitch', messages: [{ direction: 'OUTBOUND' as const, occurredAt: new Date('2026-10-14T10:00:00Z'), fromLabel: null, text: 'Would you be interested?' }], truncated: false, lane: null };

test('outbound-only and already answered conversations cannot support Reply', () => {
  const sent = new Date('2026-10-14T10:00:00Z');
  assert.equal(hasUnansweredHumanReply([], [sent]), false);
  assert.equal(hasUnansweredHumanReply([sent], [sent]), false);
  assert.equal(hasUnansweredHumanReply([new Date('2026-10-14T09:00:00Z')], [sent]), false);
  assert.equal(hasUnansweredHumanReply([new Date('2026-10-14T11:00:00Z')], [sent]), true);
});

test('format repair is bounded to one attempt, retains original evidence and stricter instructions', async () => {
  const requests: any[] = [];
  const service = new MailContentTriageService({ async run(_p, request) { requests.push(request); return { outcome: 'REJECTED_OUTPUT', rejections: ['ANSWER_TOO_LONG', 'TOO_LONG_SUMMARY'], provenance: {} as never }; } });
  const result = await service.triage(principal, input);
  assert.equal(result.outcome, 'REJECTED_OUTPUT');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].context, requests[0].context);
  assert.equal(requests[1].evidence, requests[0].evidence);
  assert.match(requests[1].templateVersion, /repair1$/);
  assert.match(requests[1].instructions, /FORMAT REPAIR/);
});

test('grounding and privacy rejections do not trigger repair', async () => {
  for (const code of ['VERBATIM_CONTENT', 'UNGROUNDED_DEADLINE', 'UNGROUNDED_PARTY']) {
    let calls = 0;
    const service = new MailContentTriageService({ async run() { calls++; return { outcome: 'REJECTED_OUTPUT', rejections: [code] as never, provenance: {} as never }; } });
    assert.equal((await service.triage(principal, input)).outcome, 'REJECTED_OUTPUT');
    assert.equal(calls, 1);
  }
});
