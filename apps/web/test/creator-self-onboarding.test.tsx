import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { postInvitationDestination, ONBOARDING_GOOGLE_PATH } from '../src/auth/landing';
const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');
test('creator invitations land at their own profile; employees keep the existing Google onboarding destination', () => {
  assert.equal(postInvitationDestination('CREATOR'), '/app/creator/profile?onboarding=1');
  assert.equal(postInvitationDestination(), ONBOARDING_GOOGLE_PATH);
  assert.equal(postInvitationDestination('EMPLOYEE'), ONBOARDING_GOOGLE_PATH);
  assert.equal(postInvitationDestination('ADMIN'), ONBOARDING_GOOGLE_PATH);
});
test('the creator acceptance branch derives its authority from the token, never a submitted identity or organization', () => {
  const action = read('auth/actions.ts');
  const creatorBranch = action.slice(action.indexOf("if (invitationSystemRole(invitation) === 'CREATOR')"), action.indexOf("// The invited employee's user record"));
  assert.match(creatorBranch, /acceptCreatorInvitation\(hashToken\(rawToken\)/);
  assert.doesNotMatch(creatorBranch, /formData\.get|activateUser|setPasswordHash|createUser/);
  assert.match(creatorBranch, /postInvitationDestination\('CREATOR'\)/);
  assert.match(read('app/crm/accept-invite/page.tsx'), /complete your own creator profile and social handles/);
  const admin = read('crm/admin-actions.ts');
  assert.match(admin, /creatorInvitationTarget\(session.organizationId, session.userId, creatorPartyId\)/);
  assert.match(admin, /creatorPartyId: target.creatorPartyId/);
});
