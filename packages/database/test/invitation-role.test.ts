import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invitationSystemRole } from '../src/repositories/iam.repository';

// Blocker 3 — the selected invitation role must survive, sourced from
// metadata.systemRole (the Invitation.systemRole column is a never-written
// EMPLOYEE default). These lock the propagation so no invitee is silently
// downgraded to EMPLOYEE and none is silently elevated.

test('an ADMIN invitation resolves to ADMIN even though the column defaulted to EMPLOYEE', () => {
  assert.equal(invitationSystemRole({ systemRole: 'EMPLOYEE', metadata: { systemRole: 'ADMIN' } }), 'ADMIN');
});

test('a MANAGER selection survives', () => {
  assert.equal(invitationSystemRole({ systemRole: 'EMPLOYEE', metadata: { systemRole: 'MANAGER' } }), 'MANAGER');
});

test('metadata role always wins over the column — never auto-downgrades', () => {
  assert.equal(invitationSystemRole({ systemRole: 'EMPLOYEE', metadata: { systemRole: 'OWNER' } }), 'OWNER');
});

test('an invalid metadata role falls back to a valid column role', () => {
  assert.equal(invitationSystemRole({ systemRole: 'MANAGER', metadata: { systemRole: 'BOGUS' } }), 'MANAGER');
});

test('no valid role anywhere → EMPLOYEE (safe default, never Super Admin)', () => {
  assert.equal(invitationSystemRole({ metadata: {} }), 'EMPLOYEE');
  assert.equal(invitationSystemRole({ systemRole: null, metadata: null }), 'EMPLOYEE');
  assert.equal(invitationSystemRole({ systemRole: 'BOGUS', metadata: { systemRole: 'ALSO_BOGUS' } }), 'EMPLOYEE');
});

test('EMPLOYEE stays EMPLOYEE', () => {
  assert.equal(invitationSystemRole({ systemRole: 'EMPLOYEE', metadata: { systemRole: 'EMPLOYEE' } }), 'EMPLOYEE');
});
