import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickActiveHref } from '../src/nav-match';

// The real ADMIN global sidebar hrefs.
const NAV = [
  '/app/admin',
  '/app/admin/marketplace',
  '/app/admin/crm',
  '/app/admin/creator-hub',
  '/app/admin/work',
  '/app/admin/accounting',
  '/app/admin/administration/team',
  '/app/admin/administration/work-types',
];

test('Start Work highlights Work OS (not Dashboard) and Work Types stays under Administration', () => {
  // 2L — the shared resolver must keep Work OS active across every work route,
  // including the rebuilt Start Work page, and must not confuse the two
  // sibling Administration routes.
  assert.equal(pickActiveHref(NAV, '/app/admin/work/new'), '/app/admin/work');
  assert.equal(pickActiveHref(NAV, '/app/admin/administration/work-types'), '/app/admin/administration/work-types');
  assert.equal(pickActiveHref(NAV, '/app/admin/administration/team'), '/app/admin/administration/team');
});

test('Work OS home highlights Work OS, not Dashboard', () => {
  assert.equal(pickActiveHref(NAV, '/app/admin/work'), '/app/admin/work');
});

test('nested Work OS routes all highlight Work OS', () => {
  assert.equal(pickActiveHref(NAV, '/app/admin/work/new'), '/app/admin/work');
  assert.equal(pickActiveHref(NAV, '/app/admin/work/abc123'), '/app/admin/work');
  assert.equal(pickActiveHref(NAV, '/app/admin/work/team'), '/app/admin/work');
  assert.equal(pickActiveHref(NAV, '/app/admin/work/blueprints/new'), '/app/admin/work');
});

test('Dashboard is highlighted ONLY on the exact Dashboard route', () => {
  assert.equal(pickActiveHref(NAV, '/app/admin'), '/app/admin');
});

test('CallGrid child routes highlight CallGrid Intelligence', () => {
  assert.equal(pickActiveHref(NAV, '/app/admin/marketplace/buyers'), '/app/admin/marketplace');
  assert.equal(pickActiveHref(NAV, '/app/admin/marketplace/buyers/xyz'), '/app/admin/marketplace');
});

test('Administration routes highlight Administration', () => {
  assert.equal(pickActiveHref(NAV, '/app/admin/administration/team'), '/app/admin/administration/team');
});

test('no path → nothing active (safe)', () => {
  assert.equal(pickActiveHref(NAV, null), null);
  assert.equal(pickActiveHref(NAV, '/somewhere/else'), null);
});
