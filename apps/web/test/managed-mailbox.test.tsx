import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createTimeView } from '@emgloop/shared';
import type { ManagedMailboxSummary } from '@emgloop/database';
import { ManagedMailboxPanelView } from '../src/creator/managed-mailbox-panel';

const time = createTimeView(
  { timeZone: 'America/New_York', source: 'device' },
  new Date('2026-11-02T17:00:00Z'),
);
const row = (email: string, profileId: string | null = null): ManagedMailboxSummary => ({
  id: email,
  expectedEmail: email,
  kind: profileId ? 'CREATOR' : 'STAFF',
  creatorProfileId: profileId,
  status: 'CONNECTED',
  connectedAt: time.now,
  lastFailureClass: null,
});
const view = (props: Partial<Parameters<typeof ManagedMailboxPanelView>[0]> = {}) =>
  renderToStaticMarkup(
    <ManagedMailboxPanelView
      rows={[]}
      expected={null}
      canUpdate
      configured
      time={time}
      {...props}
    />,
  );

test('staff sources connect once on the manager roster; assigned sources connect on the individual creator record', () => {
  const staff = view({
    rows: ['matt', 'charlie', 'francesca'].map((n) => row(`${n}@elitemediagroup.io`)),
  });
  for (const name of ['matt', 'charlie', 'francesca'])
    assert.match(staff, new RegExp(`${name}@elitemediagroup.io`));
  assert.match(staff, /once for the entire creator roster/);
  assert.match(staff, /as a shared source for creator brand activity across our roster/);
  assert.doesNotMatch(staff, /readonly=""/);
  const creator = view({
    rows: [row('trevon@emgtalentgroup.com', 'trevon')],
    expected: 'trevon@emgtalentgroup.com',
    profileId: 'trevon',
  });
  assert.match(creator, /readonly=""/);
  assert.match(creator, /Shared staff sources are configured once/);
  assert.match(creator, /for this creator’s brand activity/);
  assert.doesNotMatch(creator, /charlie@|francesca@|matt@/);
});

test('authorization never claims active capture; missing assignment or migration offers no connect action', () => {
  const ready = view();
  assert.match(
    ready,
    /Background ingestion and creator-summary attribution from these sources are not commissioned yet/,
  );
  assert.match(ready, /Existing creator tiles still use explicitly shared threads/);
  for (const props of [
    { rows: null },
    { configured: false },
    { profileId: 'missing', expected: null },
    { canUpdate: false },
  ]) {
    assert.doesNotMatch(view(props), /Authorize mailbox with Google/);
  }
  assert.match(view({ rows: null }), /awaiting their database migration/);
  assert.doesNotMatch(view({ outcome: '<script>private-token</script>' }), /private-token/);
});

test('connection controls are manager-side only and every action starts with the signed EMG seat', () => {
  const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
  const actions = read('creator/managed-mailbox-actions.ts');
  for (const name of ['connectManagedMailboxAction', 'disconnectManagedMailboxAction']) {
    const body = actions.slice(actions.indexOf(`export async function ${name}`));
    assert.match(body, /const \{ workspace, actor \} = await requireEmgActor\(\)/);
  }
  assert.doesNotMatch(actions, /data\.get\(['"](?:organizationId|userId|sessionId)['"]\)/);
  for (const path of ['app/app/creator/profile/page.tsx', 'app/app/creator/opportunities/page.tsx'])
    assert.doesNotMatch(read(path), /ManagedMailboxPanel|managed-mailbox-actions/);
});
