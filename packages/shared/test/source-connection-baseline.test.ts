// The historical-baseline vocabulary is pure: a closed window allowlist (no all-time option) and a
// priority-ordered state derivation that mirrors deriveConnectionState. No I/O, no DB.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SOURCE_CONNECTION_BASELINE_WINDOWS,
  SOURCE_CONNECTION_BASELINE_DEFAULT_WINDOW_DAYS,
  isBaselineWindowDays,
  deriveBaselineState,
  BASELINE_STATES,
  isBaselineState,
  isSourceBaselineActionOutcome,
} from '../src/source-connection';

test('the window allowlist is exactly [30, 90, 180, 365], default 90, and CLOSED (no all-time)', () => {
  assert.deepEqual([...SOURCE_CONNECTION_BASELINE_WINDOWS], [30, 90, 180, 365]);
  assert.equal(SOURCE_CONNECTION_BASELINE_DEFAULT_WINDOW_DAYS, 90);
  // Every allowed value passes; everything else -- including anything that could mean "all time" -- fails.
  for (const d of SOURCE_CONNECTION_BASELINE_WINDOWS) assert.equal(isBaselineWindowDays(d), true);
  for (const bad of [0, 7, 29, 45, 100, 366, 3650, -30, Infinity, NaN, 90.5]) assert.equal(isBaselineWindowDays(bad), false, `${bad} must be refused`);
  for (const bad of ['90', 'all', 'all-time', null, undefined, {}, [90]]) assert.equal(isBaselineWindowDays(bad as unknown), false);
});

test('deriveBaselineState is priority-ordered: revoked > complete > in-progress > not-started', () => {
  // Revoke wins absolutely, even over reaching the floor.
  assert.equal(deriveBaselineState({ revoked: true, reachedFloor: true, hasStarted: true }), 'REVOKED');
  assert.equal(deriveBaselineState({ revoked: true, reachedFloor: false, hasStarted: false }), 'REVOKED');
  // Then complete, once the floor is reached.
  assert.equal(deriveBaselineState({ revoked: false, reachedFloor: true, hasStarted: true }), 'COMPLETE');
  // Then in-progress, once any walk has begun.
  assert.equal(deriveBaselineState({ revoked: false, reachedFloor: false, hasStarted: true }), 'IN_PROGRESS');
  // Otherwise not-started.
  assert.equal(deriveBaselineState({ revoked: false, reachedFloor: false, hasStarted: false }), 'NOT_STARTED');
});

test('the state and outcome guards accept only their own members', () => {
  assert.deepEqual([...BASELINE_STATES], ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE', 'REVOKED']);
  for (const s of BASELINE_STATES) assert.equal(isBaselineState(s), true);
  for (const bad of ['READY', 'DISCONNECTED', '', null, 42]) assert.equal(isBaselineState(bad as unknown), false);
  for (const o of ['AUTHORIZED', 'SCOPE_CHANGED', 'REVOKED', 'NOT_IMPORTING', 'NOT_PERMITTED', 'NOT_CONFIGURED', 'NO_CONNECTION', 'INVALID']) {
    assert.equal(isSourceBaselineActionOutcome(o), true);
  }
  for (const bad of ['STARTED', 'ALL_TIME', '', null]) assert.equal(isSourceBaselineActionOutcome(bad as unknown), false);
});
