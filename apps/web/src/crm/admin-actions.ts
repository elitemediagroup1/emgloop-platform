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

// --- Users -------------------------------------------------------------

export async function inviteUserAction(formData: FormData): Promise<void> {
  const session = await requirePermission('users', 'create');
  const email = String(formData.get('email') ?? '').toLowerCase().trim();
  const name = String(formData.get('name') ?? '').trim();
  const role = parseRole(formData.get('role'));
  if (!email) return;
  const user = await repositories.iam.createUser({
    organizationId: session.organizationId,
    email,
    name: name || undefined,
    systemRole: role,
  });
  const token = newToken();
  await repositories.iam.createInvitation({
    organizationId: session.organizationId,
    email,
    systemRole: role,
    inviterId: session.userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  // Send the invitation email using the plaintext token (only the hash is stored).
  // The URL MUST be absolute (an email client mangles a relative path into
  // http:///…). invitationAcceptUrl builds it from the one canonical app origin;
  // the same value feeds the HTML button, the HTML fallback, and the text link.
  const inviteUrl = invitationAcceptUrl(token);
  await sendInviteEmail({ to: email, name: name || undefined, inviteUrl });
  await repositories.audit.record({
    organizationId: session.organizationId,
    userId: session.userId,
    actorName: session.name,
    action: 'user.created',
    entityType: 'user',
    entityId: user.id,
    metadata: { email, role },
  });
  revalidatePath('/app/admin/administration/team');
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
  revalidatePath('/app/admin/administration/team');
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
  revalidatePath('/app/admin/administration/team');
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
  revalidatePath('/app/admin/administration/team');
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
