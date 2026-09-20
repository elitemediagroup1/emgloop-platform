import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationKeyOf, assertConversationEventContentFree, assertConversationAllowlistContentFree,
  CONVERSATION_EVENT_KEYS, type ConversationEvent,
} from '../src/conversation-event';

test('one-way key is stable, distinct, and not the raw id', () => {
  assert.equal(conversationKeyOf('conversation', 'chat-1', 's'), conversationKeyOf('conversation', 'chat-1', 's'));
  assert.notEqual(conversationKeyOf('conversation', 'chat-1', 's'), conversationKeyOf('conversation', 'chat-2', 's'));
  assert.notEqual(conversationKeyOf('conversation', 'x', 's'), conversationKeyOf('participant', 'x', 's'));
  assert.equal(conversationKeyOf('conversation', 'chat-1', 's').includes('chat-1'), false);
});

test('a well-formed event passes and carries no content-shaped key', () => {
  const ev: ConversationEvent = {
    provider: 'TELEGRAM', conversationKey: conversationKeyOf('conversation', 'c', 's'),
    providerEventId: 'upd-1', participantKeys: [conversationKeyOf('participant', 'u', 's')],
    senderKey: conversationKeyOf('participant', 'u', 's'), direction: 'INBOUND',
    occurredAt: '2026-09-19T18:25:10Z', observedAt: '2026-09-19T18:25:11Z', hadText: true, cursor: 'pts-1',
  };
  assert.doesNotThrow(() => assertConversationEventContentFree(ev as unknown as Record<string, unknown>));
  assert.deepEqual(Object.keys(ev).sort(), [...CONVERSATION_EVENT_KEYS].sort());
});

test('a body/title/unexpected field is rejected, and the allowlist itself is clean', () => {
  assert.throws(() => assertConversationEventContentFree({ provider: 'TEAMS', body: 'hi' } as never));
  assert.throws(() => assertConversationEventContentFree({ provider: 'TEAMS', messageText: 'x' } as never));
  assert.doesNotThrow(() => assertConversationAllowlistContentFree());
});
