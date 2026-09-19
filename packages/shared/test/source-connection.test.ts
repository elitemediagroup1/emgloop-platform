import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION_PROVIDERS, CONNECTION_STATES, deriveConnectionState, isConnectionProvider,
} from '../src/source-connection';

test('providers and states are the truthful vocabulary', () => {
  assert.deepEqual([...CONNECTION_PROVIDERS], ['MICROSOFT_TEAMS', 'TELEGRAM']);
  assert.ok(CONNECTION_STATES.includes('CONNECTED_LIMITED'));
  assert.ok(CONNECTION_STATES.includes('READY'));
  assert.equal(isConnectionProvider('TELEGRAM'), true);
  assert.equal(isConnectionProvider('SLACK'), false);
});

test('authentication alone is never READY', () => {
  // Authenticated but background capability not operational -> CONNECTED_LIMITED, not READY.
  assert.equal(deriveConnectionState({ authenticated: true, backgroundObservation: 'GATED', reconnectRequired: false, failed: false, disconnected: false }), 'CONNECTED_LIMITED');
  assert.equal(deriveConnectionState({ authenticated: true, backgroundObservation: 'UNAVAILABLE', reconnectRequired: false, failed: false, disconnected: false }), 'CONNECTED_LIMITED');
  // Only an operational background capability is READY.
  assert.equal(deriveConnectionState({ authenticated: true, backgroundObservation: 'OPERATIONAL', reconnectRequired: false, failed: false, disconnected: false }), 'READY');
});

test('terminal and precedence states', () => {
  assert.equal(deriveConnectionState({ authenticated: false, backgroundObservation: 'UNAVAILABLE', reconnectRequired: false, failed: false, disconnected: false }), 'NOT_CONNECTED');
  assert.equal(deriveConnectionState({ authenticated: true, backgroundObservation: 'OPERATIONAL', reconnectRequired: true, failed: false, disconnected: false }), 'RECONNECT_REQUIRED');
  assert.equal(deriveConnectionState({ authenticated: true, backgroundObservation: 'OPERATIONAL', reconnectRequired: false, failed: true, disconnected: false }), 'FAILED');
  assert.equal(deriveConnectionState({ authenticated: true, backgroundObservation: 'OPERATIONAL', reconnectRequired: false, failed: false, disconnected: true }), 'DISCONNECTED');
});
