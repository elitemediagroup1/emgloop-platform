import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetaApiError } from '@emgloop/providers';
import { metaCallbackFailure, metaConnectionMessage, metaFailureReference } from '../src/meta/meta-errors';

test('callback diagnostic projection never copies exception text, provider bodies or extra metadata', () => {
  const error = new MetaApiError('UNAVAILABLE', {
    stage: 'CODE_EXCHANGE', httpStatus: 400, graphCode: 101, graphSubcode: 123,
    ...{ message: 'private-app-secret', token: 'private-token', response: { access_token: 'private-token' } },
  });
  error.message = 'private-authorization-code';
  const result = metaCallbackFailure(error);
  assert.deepEqual(result, { outcome: 'TOKEN_EXCHANGE_FAILED', diagnostic: { stage: 'CODE_EXCHANGE', failure: 'UNAVAILABLE', httpStatus: 400, graphCode: 101, graphSubcode: 123 } });
  assert.doesNotMatch(JSON.stringify(result), /private-|access_token|message|response/);
  assert.deepEqual(metaCallbackFailure(new Error('private-database-url')), { outcome: 'CONNECTION_SAVE_FAILED', diagnostic: { stage: 'LOOP_CALLBACK', failure: 'UNAVAILABLE' } });
});

test('runtime diagnostic values outside the fixed enums and numeric fields are discarded', () => {
  const error = new MetaApiError('UNAVAILABLE');
  Object.assign(error.diagnostic, { stage: 'private-code', invalidResponse: 'private-token', httpStatus: 'private-secret', graphCode: Infinity, graphSubcode: -1 });
  Object.assign(error, { failure: 'private-provider-message' });
  assert.deepEqual(metaCallbackFailure(error), { outcome: 'FAILED', diagnostic: { stage: 'META_CALLBACK', failure: 'UNAVAILABLE' } });
});

test('a rejected code, token extension, expiry, identity and permission read have different creator outcomes', () => {
  const cases = [
    [{ stage: 'CODE_EXCHANGE' }, 'TOKEN_EXCHANGE_FAILED'],
    [{ stage: 'LONG_LIVED_EXCHANGE' }, 'TOKEN_EXTENSION_FAILED'],
    [{ stage: 'TOKEN_DEBUG_READ', invalidResponse: 'EXPIRY_MISSING' }, 'TOKEN_EXPIRY_UNAVAILABLE'],
    [{ stage: 'IDENTITY_READ' }, 'IDENTITY_UNAVAILABLE'],
    [{ stage: 'PERMISSIONS_READ' }, 'PERMISSION_CHECK_FAILED'],
  ] as const;
  for (const [diagnostic, expected] of cases) assert.equal(metaCallbackFailure(new MetaApiError('UNAVAILABLE', diagnostic)).outcome, expected);
  for (const failure of ['RATE_LIMITED', 'TOKEN_EXPIRED', 'PERMISSION_REQUIRED'] as const) assert.equal(metaCallbackFailure(new MetaApiError(failure, { stage: 'CODE_EXCHANGE' })).outcome, failure);
});

test('only generated reference shapes are echoed and unknown status text is never reflected', () => {
  const reference = 'b31cf746-1353-4fbe-b10d-c5e9290b85be';
  assert.equal(metaFailureReference(reference), reference);
  for (const value of ['private-token', reference + '?code=private', [reference], undefined]) assert.equal(metaFailureReference(value), undefined);
  assert.equal(metaConnectionMessage('private-provider-error'), metaConnectionMessage('FAILED'));
  assert.match(metaConnectionMessage('CONNECTED', false)!, /Facebook Page connected/);
  assert.match(metaConnectionMessage('CONNECTED', false)!, /Instagram analytics are not connected/);
  assert.doesNotMatch(metaConnectionMessage('TOKEN_EXCHANGE_FAILED')!, /linked professional/);
});
