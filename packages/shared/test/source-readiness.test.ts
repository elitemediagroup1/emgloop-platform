// Readiness: CONNECTED is not READY. What a person is told about a source they connected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_WORKSPACE_CAPABILITIES_IN_USE,
  GOOGLE_WORKSPACE_CAPABILITY_IN_USE,
  GOOGLE_WORKSPACE_CAPABILITY_READS,
  WORK_SYNC_IN_FLIGHT_MS,
  sourceReadiness,
  syncRunInFlight,
  workSourceFreshness,
  GMAIL_FRESHNESS_POLICY,
  type WorkSourceStateInput,
} from '../src';

const NOW = new Date('2026-09-19T13:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

const readiness = (input: Partial<WorkSourceStateInput>, inFlight = false) => {
  const state: WorkSourceStateInput = { configured: true, capability: 'CONNECTED', lastSyncCompletedAt: null, lastRunOutcome: null, ...input };
  return sourceReadiness({ freshness: workSourceFreshness(state, NOW, GMAIL_FRESHNESS_POLICY), inFlight, everRead: state.lastSyncCompletedAt !== null });
};

test('1. OAuth succeeded and nothing has been read: INITIALIZING, never READY', () => {
  assert.equal(readiness({}), 'INITIALIZING');
  assert.equal(readiness({}, true), 'INITIALIZING', 'a first read under way is still setting up');
  // A first read that failed and is being retried is still setting up, not "reading again".
  assert.equal(readiness({ lastRunOutcome: 'FAILED' }, true), 'INITIALIZING');
});

test('2. a completed read is READY, however old; a read under way after one is READING', () => {
  assert.equal(readiness({ lastSyncCompletedAt: ago(2 * MIN), lastRunOutcome: 'SUCCEEDED' }), 'READY');
  assert.equal(readiness({ lastSyncCompletedAt: ago(5 * 60 * MIN), lastRunOutcome: 'SUCCEEDED' }), 'READY', 'stale is ready, with its age shown');
  assert.equal(readiness({ lastSyncCompletedAt: ago(2 * MIN), lastRunOutcome: 'TRUNCATED' }), 'READY', 'a capped read is a read');
  assert.equal(readiness({ lastSyncCompletedAt: ago(2 * MIN), lastRunOutcome: 'SUCCEEDED' }, true), 'READING');
});

test('3. an expired or withdrawn grant is RECONNECT_REQUIRED; a partial grant is PERMISSION_NEEDED; none is NOT_CONNECTED', () => {
  // Google withdrawing access surfaces as an expired connection (the refresh is refused).
  assert.equal(readiness({ capability: 'EXPIRED', lastSyncCompletedAt: ago(MIN) }), 'RECONNECT_REQUIRED');
  assert.equal(readiness({ capability: 'INSUFFICIENT_SCOPE' }), 'PERMISSION_NEEDED');
  // Disconnected in Loop: the grant is gone, so there is nothing to reconnect -- only to connect.
  assert.equal(readiness({ capability: 'NOT_CONNECTED', lastSyncCompletedAt: ago(MIN) }), 'NOT_CONNECTED');
  assert.equal(readiness({ configured: false }), 'NOT_CONFIGURED');
});

test('4. a failed read is SYNC_FAILED, whether or not one ever succeeded', () => {
  assert.equal(workSourceFreshness({ configured: true, capability: 'CONNECTED', lastSyncCompletedAt: null, lastRunOutcome: 'FAILED' }, NOW, GMAIL_FRESHNESS_POLICY), 'SYNC_FAILED', 'a first read that failed is not "not read yet"');
  assert.equal(readiness({ lastRunOutcome: 'FAILED' }), 'SYNC_FAILED');
  assert.equal(readiness({ lastSyncCompletedAt: ago(90 * MIN), lastRunOutcome: 'FAILED' }), 'SYNC_FAILED');
  assert.equal(readiness({ lastSyncCompletedAt: ago(90 * MIN), lastRunOutcome: 'FAILED' }, true), 'READING', 'a retry under way');
});

test('a run with no finish time is "in flight" for five minutes, then it is a run that died', () => {
  assert.equal(WORK_SYNC_IN_FLIGHT_MS, 5 * MIN);
  assert.equal(syncRunInFlight({ startedAt: ago(4 * MIN), finishedAt: null }, NOW), true);
  assert.equal(syncRunInFlight({ startedAt: ago(6 * MIN), finishedAt: null }, NOW), false, 'a request the platform cut off is not "reading" forever');
  assert.equal(syncRunInFlight({ startedAt: ago(MIN), finishedAt: ago(0) }, NOW), false);
  assert.equal(syncRunInFlight(null, NOW), false);
});

test('13. Drive is authorized but not used, and its description claims no reading', () => {
  assert.equal(GOOGLE_WORKSPACE_CAPABILITY_IN_USE.drive, false);
  assert.deepEqual([...GOOGLE_WORKSPACE_CAPABILITIES_IN_USE], ['gmail', 'calendar']);
  assert.match(GOOGLE_WORKSPACE_CAPABILITY_READS.drive, /^Loop does not read Drive yet, so nothing from Drive appears in Loop\./);
});
