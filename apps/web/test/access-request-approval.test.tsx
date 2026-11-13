import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');

test('the public form persists to trusted routing before notifying; no public role grant or invitation', () => {
  const action = read('app/crm/login/access-request-action.ts');
  assert.ok(action.indexOf('accessRequests().submit(') < action.indexOf('await sendAccessRequestEmail('));
  assert.match(action, /const organizationId = accessRequestOrganizationId\(\)/);
  assert.doesNotMatch(action, /prepareInvitation|createInvitation|sendInviteEmail|input\.organizationId/);
  assert.match(action, /if \(!organizationId\) return GENERIC_FAILURE/);
});
test('approval uses persisted identity, explicit administrator role, hash-only tokens and existing email acceptance URL', () => {
  const source = read('crm/admin-actions.ts');
  const action = source.slice(source.indexOf('export async function inviteUserAction'), source.indexOf('export async function rejectAccessRequestAction'));
  assert.ok(action.indexOf("requirePermission('users', 'create')") < action.indexOf('accessRequests().get('));
  assert.match(action, /const email = request\?\.email \?\?/);
  assert.match(action, /const name = request\?\.fullName \?\?/);
  assert.match(action, /const role = parseRole\(formData.get\('role'\)\)/);
  assert.ok(action.indexOf('accessRequests().claim(') < action.indexOf('repositories.iam.prepareInvitation('));
  assert.ok(action.indexOf('accessRequests().attach(') < action.indexOf('await sendInviteEmail('));
  assert.ok(action.indexOf('await sendInviteEmail(') < action.indexOf("claimId, 'INVITED'"));
  assert.match(action, /tokenHash: hashToken\(token\)/);
  assert.match(action, /inviteUrl: invitationAcceptUrl\(token\)/);
  assert.match(action, /claimId, 'FAILED'/);
});
test('queue decisions are scoped, creator identity remains explicit, and legacy requests can be recorded without sending', () => {
  const action = read('crm/admin-actions.ts');
  const record = action.slice(action.indexOf('export async function recordAccessRequestAction'), action.indexOf('export async function setUserRoleAction'));
  assert.match(record, /requirePermission\('users', 'create'\)/);
  assert.match(record, /submit\(session.organizationId/);
  assert.doesNotMatch(record, /sendInviteEmail|createInvitation/);
  const panel = read('app/app/admin/administration/team/access-requests.tsx');
  assert.match(panel, /Approve &amp; send invitation|Approve & send invitation/);
  assert.match(panel, /name="role"/);
  assert.match(panel, /name="creatorPartyId"/);
  assert.doesNotMatch(panel, /name="email" value=\{request.email\}/);
  assert.match(read('app/app/admin/administration/team/page.tsx'), /if \(canManage\)/);
});
