'use server';

// Admin server actions — Sprint 7 (Identity, Authentication & Organizations).
//
// Mutations for the management surfaces (Users, Organizations, AI Employees,
// Settings). Every action enforces a deny-by-default permission check via the
// guard, persists through the @emgloop/database repository layer, and writes an
// immutable AuditLog entry. No email delivery, no providers, no fake data.
//
// 'Remove user' is implemented as a soft removal (status DISABLED + a metadata
// flag + session revocation), never a hard delete, so the audit trail and
// historical attribution survive.

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { repositories } from '@emgloop/database';
import { SystemRole } from '@emgloop/database';
import { invitationAcceptUrl } from '@emgloop/shared';
import { newToken, hashToken } from '../auth/auth';
import { requirePermission } from '../auth/guard';
import { sendInviteEmail } from '../lib/email/email-service';

function parseRole(v: unknown): SystemRole {
  const s = String(v ?? '');
  return (Object.values(SystemRole) as string[]).includes(s)
    ? (s as SystemRole)
    : SystemRole.EMPLOYEE;
}

const TEAM_PATH = '/app/admin/administration/team';

/**
 * Build the redirect target back to the Team page carrying a single feedback
 * message. Team actions redirect here (rather than silently revalidating) so the
 * page always re-renders the real persisted state AND can show the operator why
 * an action succeeded or was refused — never optimistic, never a silent no-op.
 */
function teamUrl(message: string, kind: 'notice' | 'error'): string {
  return TEAM_PATH + '?' + kind + '=' + encodeURIComponent(message);
}

// --- Users -------------------------------------------------------------

export async function inviteUserAction(formData: FormData): Promise<void> {
  const session = await requirePermission('users', 'create');
  const email = String(formData.get('email') ?? '').toLowerCase().trim();
  const name = String(formData.get('name') ?? '').trim();
  const role = parseRole(formData.get('role'));

  // The redirect is the LAST statement, computed here — never inside the try, so
  // its NEXT_REDIRECT control-flow throw is not swallowed by the catch.
  let result: { message: string; kind: 'notice' | 'error' };

  if (!email) {
    result = { message: 'Enter an email address to send an invitation.', kind: 'error' };
  } else {
    try {
      // Lifecycle-aware: resolves the one (org,email) row and reinstates it rather
      // than blindly inserting. This is the fix for the P2002 that crashed the page
      // and blocked re-inviting a removed teammate.
      const outcome = await repositories.iam.prepareInvitation({
        organizationId: session.organizationId,
        email,
        name: name || undefined,
        systemRole: role,
      });
      if (!outcome.ok) {
        result = {
          kind: 'error',
          message: outcome.reason === 'active_member'
            ? `${email} is already an active member of your team.`
            : `${email} already has a pending invitation — use Resend to send a new link.`,
        };
      } else {
        // A reinstated row may have had live sessions; revoke them so a removed
        // member cannot ride an old session back in during re-invitation.
        if (outcome.reused) await repositories.auth.revokeAllForUser(outcome.userId);
        const token = newToken();
        await repositories.iam.createInvitation({
          organizationId: session.organizationId,
          email,
          systemRole: role,
          inviterId: session.userId,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
        // Send the invitation email using the plaintext token (only the hash is
        // stored). The URL MUST be absolute (an email client mangles a relative
        // path into http:///…). invitationAcceptUrl builds it from the one
        // canonical app origin; the same value feeds the button and text links.
        await sendInviteEmail({ to: email, name: name || undefined, inviteUrl: invitationAcceptUrl(token) });
        await repositories.audit.record({
          organizationId: session.organizationId,
          userId: session.userId,
          actorName: session.name,
          action: 'user.invited',
          entityType: 'user',
          entityId: outcome.userId,
          metadata: { email, role },
        });
        result = { message: `Invitation sent to ${email}.`, kind: 'notice' };
      }
    } catch (err) {
      // Fail visibly, not with a crash digest. Structured + secret-safe: no token,
      // no password, no payload — just enough to locate the failing op on deploy.
      console.error('[team.invite] failed', {
        op: 'prepareInvitation',
        model: 'user/invitation',
        organizationId: session.organizationId,
        code: (err as { code?: string } | null)?.code ?? 'unknown',
      });
      result = {
        message: 'Something went wrong sending the invitation. Please try again.',
        kind: 'error',
      };
    }
  }

  redirect(teamUrl(result.message, result.kind));
}

export async function setUserRoleAction(formData: FormData): Promise<void> {
  const session = await requirePermission('users', 'update');
  const userId = String(formData.get('userId') ?? '');
  const role = parseRole(formData.get('role'));
  if (!userId) return;
  await repositories.iam.updateUserRole(session.organizationId, userId, role);
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'user.permission_changed',
    entityType: 'user',
    entityId: userId,
    metadata: { role },
  });
  redirect(teamUrl('Role updated.', 'notice'));
}

export async function setUserStatusAction(formData: FormData): Promise<void> {
  const session = await requirePermission('users', 'update');
  const userId = String(formData.get('userId') ?? '');
  const status = String(formData.get('status') ?? '');
  if (!userId || (status !== 'ACTIVE' && status !== 'DISABLED')) return;
  if (status === 'DISABLED') {
    await repositories.iam.disableUser(session.organizationId, userId);
    await repositories.auth.revokeAllForUser(userId);
  } else {
    await repositories.iam.activateUser(session.organizationId, userId);
  }
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: status === 'DISABLED' ? 'user.disabled' : 'user.reactivated',
    entityType: 'user',
    entityId: userId,
  });
  redirect(teamUrl(status === 'DISABLED' ? 'Team member disabled.' : 'Team member reactivated.', 'notice'));
}

export async function removeUserAction(formData: FormData): Promise<void> {
  const session = await requirePermission('users', 'delete');
  const userId = String(formData.get('userId') ?? '');
  if (!userId || userId === session.userId) return;
  await repositories.iam.softRemoveUser(session.organizationId, userId);
  await repositories.auth.revokeAllForUser(userId);
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'user.removed',
    entityType: 'user',
    entityId: userId,
    metadata: { soft: true },
  });
  redirect(teamUrl('Team member removed. You can re-invite this email at any time.', 'notice'));
}

export async function revokeInvitationAction(formData: FormData): Promise<void> {
  const session = await requirePermission('users', 'create');
  const invitationId = String(formData.get('invitationId') ?? '');
  if (!invitationId) return;
  await repositories.iam.revokeInvitation(session.organizationId, invitationId);
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'invitation.revoked',
    entityType: 'invitation',
    entityId: invitationId,
  });
  redirect(teamUrl('Invitation revoked. The old link no longer works.', 'notice'));
}

export async function resendInvitationAction(formData: FormData): Promise<void> {
  const session = await requirePermission('users', 'create');
  const invitationId = String(formData.get('invitationId') ?? '');

  let result: { message: string; kind: 'notice' | 'error' };

  if (!invitationId) {
    result = { message: 'No invitation selected.', kind: 'error' };
  } else {
    try {
      // The stored token is hashed and cannot be re-sent, so "resend" supersedes:
      // revoke the pending invite and issue a fresh one (new token, same
      // email/role). listInvitations is org-scoped, so a cross-org id finds nothing.
      const invites = await repositories.iam.listInvitations(session.organizationId);
      const target = invites.find((i) => i.id === invitationId);
      if (!target) {
        result = { message: 'That invitation is no longer pending.', kind: 'error' };
      } else {
        await repositories.iam.revokeInvitation(session.organizationId, invitationId);
        const token = newToken();
        await repositories.iam.createInvitation({
          organizationId: session.organizationId,
          email: target.email,
          systemRole: parseRole(target.systemRole),
          inviterId: session.userId,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
        await sendInviteEmail({ to: target.email, inviteUrl: invitationAcceptUrl(token) });
        await repositories.audit.record({
          organizationId: session.organizationId,
          userId: session.userId,
          actorName: session.name,
          action: 'invitation.resent',
          entityType: 'invitation',
          entityId: invitationId,
          metadata: { email: target.email },
        });
        result = { message: `A fresh invitation was sent to ${target.email}. The old link no longer works.`, kind: 'notice' };
      }
    } catch (err) {
      console.error('[team.resend] failed', {
        op: 'resendInvitation',
        model: 'invitation',
        organizationId: session.organizationId,
        code: (err as { code?: string } | null)?.code ?? 'unknown',
      });
      result = { message: 'Something went wrong resending the invitation. Please try again.', kind: 'error' };
    }
  }

  redirect(teamUrl(result.message, result.kind));
}

// --- Organizations -----------------------------------------------------

export async function createOrganizationAction(formData: FormData): Promise<void> {
  const session = await requirePermission('organizations', 'create');
  const name = String(formData.get('name') ?? '').trim();
  const timezone = String(formData.get('timezone') ?? 'UTC');
  if (!name) return;
  const org = await repositories.organizations.createOrganization({ name, timezone });
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'organization.created',
    entityType: 'organization',
    entityId: org.id,
    metadata: { name, slug: org.slug },
  });
  revalidatePath('/crm/organizations');
}

export async function updateOrgProfileAction(formData: FormData): Promise<void> {
  const session = await requirePermission('organizations', 'update');
  // The organization ALWAYS comes from the signed session, never from the
  // submitted form. A client-supplied orgId was previously honoured here, which
  // let any holder of organizations:update rename any organization on the
  // platform while the audit row was attributed to the caller's own org.
  const id = session.organizationId;
  await repositories.organizations.updateProfile(id, {
    name: formData.has('name') ? String(formData.get('name')) : undefined,
    timezone: formData.has('timezone') ? String(formData.get('timezone')) : undefined,
  });
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'organization.updated',
    entityType: 'organization',
    entityId: id,
  });
  revalidatePath('/crm/organizations');
  revalidatePath('/crm/settings');
}

export async function updateBrandingAction(formData: FormData): Promise<void> {
  const session = await requirePermission('settings', 'update');
  const id = session.organizationId;
  await repositories.organizations.setBranding(id, {
    primaryColor: formData.has('primaryColor') ? String(formData.get('primaryColor')) : undefined,
    accentColor: formData.has('accentColor') ? String(formData.get('accentColor')) : undefined,
    logoText: formData.has('logoText') ? String(formData.get('logoText')) : undefined,
    tagline: formData.has('tagline') ? String(formData.get('tagline')) : undefined,
  });
  await repositories.audit.record({
    organizationId: id,
    userId: session.userId,
    actorName: session.name,
    action: 'organization.branding_updated',
    entityType: 'organization',
    entityId: id,
  });
  revalidatePath('/crm/settings');
}

export async function updateCrmDefaultsAction(formData: FormData): Promise<void> {
  const session = await requirePermission('settings', 'update');
  const id = session.organizationId;
  await repositories.organizations.setCrmDefaults(id, {
    defaultPipelineStatus: formData.has('defaultPipelineStatus')
      ? String(formData.get('defaultPipelineStatus')) : undefined,
    defaultAIEmployee: formData.has('defaultAIEmployee')
      ? String(formData.get('defaultAIEmployee')) : undefined,
  });
  await repositories.audit.record({
    organizationId: id,
    userId: session.userId,
    actorName: session.name,
    action: 'organization.crm_defaults_updated',
    entityType: 'organization',
    entityId: id,
  });
  revalidatePath('/crm/settings');
}

// --- AI Employees ------------------------------------------------------

export async function createAIEmployeeAction(formData: FormData): Promise<void> {
  const session = await requirePermission('aiEmployees', 'create');
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return;
  const e = await repositories.aiEmployees.createEmployee({
    organizationId: session.organizationId,
    name,
    title: String(formData.get('title') ?? '') || undefined,
    department: String(formData.get('department') ?? '') || undefined,
    voiceProvider: String(formData.get('voiceProvider') ?? '') || undefined,
    aiProvider: String(formData.get('aiProvider') ?? '') || undefined,
  });
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'ai_employee.created',
    entityType: 'aiEmployee',
    entityId: e.id,
    metadata: { name },
  });
  revalidatePath('/crm/ai-employees');
}

export async function updateAIEmployeeAction(formData: FormData): Promise<void> {
  const session = await requirePermission('aiEmployees', 'update');
  const id = String(formData.get('id') ?? '');
  if (!id) return;
  const statusRaw = String(formData.get('status') ?? '');
  const validStatus = ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'].includes(statusRaw);
  // Scoped to the session organization: a cross-org id updates nothing and is
  // treated as not-found, so no audit entry is written for a write that did
  // not happen.
  const updated = await repositories.aiEmployees.updateEmployee(session.organizationId, id, {
    name: formData.has('name') ? String(formData.get('name')) : undefined,
    title: formData.has('title') ? String(formData.get('title')) : undefined,
    department: formData.has('department') ? String(formData.get('department')) : undefined,
    voiceProvider: formData.has('voiceProvider') ? String(formData.get('voiceProvider')) : undefined,
    aiProvider: formData.has('aiProvider') ? String(formData.get('aiProvider')) : undefined,
    status: validStatus ? (statusRaw as any) : undefined,
  });
  if (!updated) return;
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'ai_employee.updated',
    entityType: 'aiEmployee',
    entityId: id,
  });
  revalidatePath('/crm/ai-employees');
}

export async function archiveAIEmployeeAction(formData: FormData): Promise<void> {
  const session = await requirePermission('aiEmployees', 'update');
  const id = String(formData.get('id') ?? '');
  if (!id) return;
  // Scoped to the session organization: a cross-org id archives nothing.
  const archived = await repositories.aiEmployees.archive(session.organizationId, id);
  if (!archived) return;
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'ai_employee.archived',
    entityType: 'aiEmployee',
    entityId: id,
  });
  revalidatePath('/crm/ai-employees');
}
