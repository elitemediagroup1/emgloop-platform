'use server';

// Sprint 21 — Owner Setup Wizard server actions.
//
// The completion action is the only trusted persistence path. It re-derives
// the actor from the session, re-checks owner/admin access, persists the
// owner's profile (User.name + User.metadata.profile), updates organization
// profile/settings, and merges the onboarding marker into the LATEST
// Organization.settings using the existing read-modify-write patchSettings
// helper (which preserves branding, defaults, crmDefaults and every other
// unrelated key). Cross-organization writes are impossible: organizationId
// always comes from the session, never the client. The onboarding completion
// marker is written last, only after all profile/org writes succeed.

import { repositories } from '@emgloop/database';
import { requirePermission } from '../../../auth/guard';

const INDUSTRIES = [
  'GENERIC',
  'HOME_SERVICES',
  'NAIL_SALON',
  'BARBERSHOP',
  'MEDICAL',
  'DENTAL',
  'RESTAURANT',
  'PIZZERIA',
  'LAW_FIRM',
  'AUTOMOTIVE',
  'BEAUTY_SPA',
  'FITNESS',
] as const;

const LANDING_PAGES = ['dashboard', 'crm', 'work'] as const;
const THEMES = ['dark', 'light', 'system'] as const;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

interface SetupResult {
  ok: boolean;
  message?: string;
}

function clean(value: FormDataEntryValue | null, maxLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().slice(0, maxLength);
}

function pick<T extends string>(
  value: FormDataEntryValue | null,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = typeof value === 'string' ? value.trim() : '';
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function optional(value: string): string | null {
  return value.length > 0 ? value : null;
}

export async function completeSetupAction(
  formData: FormData,
): Promise<SetupResult> {
  // Identity is re-derived from the trusted server context. Never trust ids
  // coming from client form data. requirePermission also enforces the
  // owner/admin 'settings:manage' capability, so employees cannot complete setup.
  const session = await requirePermission('settings', 'manage');
  const orgId = session.organizationId;
  const actingUserId = session.userId;

  // ----- Step 1: owner profile (persisted to User.name + User.metadata.profile) -----
  const firstName = clean(formData.get('firstName'), 80);
  const lastName = clean(formData.get('lastName'), 80);
  const preferredName = clean(formData.get('preferredName'), 80);
  const jobTitle = clean(formData.get('jobTitle'), 120);
  const userPhone = clean(formData.get('userPhone'), 40);
  const userTimezone = clean(formData.get('userTimezone'), 80);

  if (!firstName) {
    return { ok: false, message: 'First name is required.' };
  }
  if (!lastName) {
    return { ok: false, message: 'Last name is required.' };
  }
  if (!jobTitle) {
    return { ok: false, message: 'Job title is required.' };
  }
  if (
    CONTROL_CHARS.test(firstName) ||
    CONTROL_CHARS.test(lastName) ||
    CONTROL_CHARS.test(preferredName) ||
    CONTROL_CHARS.test(jobTitle)
  ) {
    return { ok: false, message: 'Names and title contain invalid characters.' };
  }

  const displayName = preferredName || `${firstName} ${lastName}`;
  const ownerProfile = {
    firstName,
    lastName,
    preferredName: optional(preferredName),
    jobTitle,
    phone: optional(userPhone),
    timezone: optional(userTimezone),
    updatedAt: new Date().toISOString(),
  };

  // ----- Organization profile (only set provided values; never blank out) -----
  const orgName = clean(formData.get('orgName'), 200);
  const orgTimezone = clean(formData.get('orgTimezone'), 80);
  const orgIndustry = pick(formData.get('orgIndustry'), INDUSTRIES, 'GENERIC');

  const orgProfile: { name?: string; timezone?: string; industry?: string } = {};
  if (orgName) orgProfile.name = orgName;
  if (orgTimezone) orgProfile.timezone = orgTimezone;
  if (orgIndustry) orgProfile.industry = orgIndustry;

  // ----- Workspace + AI preferences (namespaced settings keys) -----
  const workspace = {
    name: clean(formData.get('workspaceName'), 200),
    landingPage: pick(formData.get('landingPage'), LANDING_PAGES, 'dashboard'),
    theme: pick(formData.get('theme'), THEMES, 'system'),
    website: clean(formData.get('orgWebsite'), 300),
    primaryEmail: clean(formData.get('orgEmail'), 200),
    primaryPhone: clean(formData.get('orgPhone'), 40),
    companySize: clean(formData.get('companySize'), 40),
  };

  const aiPreferences = {
    preferredName: clean(formData.get('aiPreferredName'), 80),
    communicationStyle: pick(
      formData.get('communicationStyle'),
      ['concise', 'balanced', 'detailed'] as const,
      'balanced',
    ),
    decisionStyle: pick(
      formData.get('decisionStyle'),
      ['execute', 'recommend', 'challenge'] as const,
      'recommend',
    ),
    dailyBrief: formData.get('dailyBrief') === 'true',
    weeklySummary: formData.get('weeklySummary') === 'true',
  };

  // Ordered writes. The onboarding completion marker is written LAST so that a
  // failure in any earlier write leaves setup incomplete and safely retryable.
  try {
    // 1) Owner profile. Org-scoped; verifies the user belongs to the org and
    //    merges metadata.profile while preserving unrelated metadata keys.
    await repositories.iam.updateUserProfile({
      organizationId: orgId,
      userId: actingUserId,
      name: displayName,
      profile: ownerProfile,
    });

    // 2) Organization profile + workspace/AI settings.
    await repositories.organizations.updateProfile(orgId, orgProfile);
    await repositories.organizations.patchSettings(orgId, {
      workspace,
      aiPreferences,
    });

    // 3) Completion marker LAST.
    await repositories.organizations.patchSettings(orgId, {
      onboarding: {
        completedAt: new Date().toISOString(),
        completedByUserId: actingUserId,
        version: 1,
      },
    });
  } catch {
    return { ok: false, message: 'We could not save your setup. Please try again.' };
  }

  // Audit logging is non-blocking; a completed setup must not be undone by an
  // audit failure. No personal profile values are included in audit metadata.
  try {
    await repositories.audit.record({
      organizationId: orgId,
      action: 'organization.setup.completed',
      actorType: 'HUMAN_AGENT',
      entityType: 'Organization',
      entityId: orgId,
      metadata: {
        version: 1,
        profileCompleted: true,
      },
    });
  } catch {
    // ignore audit failures
  }

  return { ok: true };
}
