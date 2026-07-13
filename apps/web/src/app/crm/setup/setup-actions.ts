'use server';

// Sprint 21 — Owner Setup Wizard server actions.
//
// The completion action is the only trusted persistence path. It re-derives
// the actor from the session, re-checks owner/admin access, and merges the
// onboarding marker into the LATEST Organization.settings using the existing
// read-modify-write patchSettings helper (which preserves branding, defaults,
// crmDefaults and every other unrelated key). Cross-organization writes are
// impossible: the organizationId always comes from the session, never the client.

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

function clean(value: FormDataEntryValue | null, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

function pick<T extends string>(
  value: FormDataEntryValue | null,
  allow: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && (allow as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export interface SetupResult {
  ok: boolean;
  message?: string;
}

export async function completeSetupAction(formData: FormData): Promise<SetupResult> {
  // Re-derive identity + authorization from the session (never the client).
  const session = await requirePermission('settings', 'manage');
  const orgId = session.organizationId;
  const userId = session.userId;

  // --- Organization profile (reuse existing columns; never blank out) ---
  const orgName = clean(formData.get('orgName'), 150);
  const orgTimezone = clean(formData.get('orgTimezone'), 64);
  const orgIndustry = pick(formData.get('orgIndustry'), INDUSTRIES, 'GENERIC');

  const profile: { name?: string; timezone?: string; industry?: string } = {};
  if (orgName) profile.name = orgName;
  if (orgTimezone) profile.timezone = orgTimezone;
  if (orgIndustry) profile.industry = orgIndustry;
  if (Object.keys(profile).length > 0) {
    await repositories.organizations.updateProfile(orgId, profile);
  }

  // --- Namespaced settings (workspace + AI prefs) via merge patch ---
  const workspace = {
    name: clean(formData.get('workspaceName'), 150) || orgName,
    landingPage: pick(formData.get('landingPage'), LANDING_PAGES, 'dashboard'),
    theme: pick(formData.get('theme'), THEMES, 'system'),
    website: clean(formData.get('orgWebsite'), 200),
    primaryEmail: clean(formData.get('orgEmail'), 254).toLowerCase(),
    primaryPhone: clean(formData.get('orgPhone'), 40),
    companySize: clean(formData.get('companySize'), 40),
  };

  const aiPreferences = {
    preferredName: clean(formData.get('aiPreferredName'), 100),
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
    dailyBrief: formData.get('dailyBrief') === 'on',
    weeklySummary: formData.get('weeklySummary') === 'on',
  };

  // --- Onboarding completion marker (server-authored) ---
  const onboarding = {
    completedAt: new Date().toISOString(),
    completedByUserId: userId,
    version: 1,
  };

  // Single merge patch. patchSettings reads the latest settings and spreads
  // { ...settings, ...patch } — unrelated top-level keys are preserved.
  await repositories.organizations.patchSettings(orgId, {
    workspace,
    aiPreferences,
    onboarding,
  });

  // --- Audit (best-effort; never blocks completion) ---
  try {
    await repositories.audit.record({
      organizationId: orgId,
      userId,
      action: 'organization.setup.completed',
      actorType: 'HUMAN_AGENT',
      entityType: 'Organization',
      entityId: orgId,
      metadata: { version: 1 },
    });
  } catch {
    // Auditing is non-critical for setup completion.
  }

  return { ok: true };
}
