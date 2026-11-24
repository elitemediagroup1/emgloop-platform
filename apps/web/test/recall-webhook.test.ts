import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { verifyWebhook } from '../src/notetaker/verify-webhook';

test('Recall signatures bind the raw payload and reject stale deliveries', () => {
  const key = Buffer.from('test-signing-key');
  const secret = 'whsec_' + key.toString('base64');
  const timestamp = '1700000000';
  const body = Buffer.from('{"example": "å"}');
  const signature = createHmac('sha256', key).update('msg_test.' + timestamp + '.').update(body).digest('base64');
  const headers = new Headers({
    'webhook-id': 'msg_test',
    'webhook-timestamp': timestamp,
    'webhook-signature': 'v1,' + signature,
  });
  const now = Number(timestamp) * 1000;
  assert.equal(verifyWebhook(headers, body, secret, now), true);
  assert.equal(verifyWebhook(headers, Buffer.from('{"example":"å"}'), secret, now), false);
  assert.equal(verifyWebhook(headers, body, secret, now + 300_001), false);
  assert.equal(verifyWebhook(new Headers(), body, secret, now), false);
});
