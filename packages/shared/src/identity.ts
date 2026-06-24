// @emgloop/shared — Identity & OS-core vocabulary (Sprint 2)
//
// Shared, framework-agnostic constants/types for organizations, roles,
// permissions, capabilities, and Organization DNA. Mirrors the Prisma enums but
// is usable by web/api without importing the database client.

// --- System roles (mirror Prisma enum SystemRole) ---
export const SYSTEM_ROLES = [
  'owner',
  'admin',
  'manager',
  'employee',
  'ai_employee',
  'read_only',
] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

// Rough capability ceiling per role (for UI hints only; the authoritative
// decision is always the deny-by-default permission resolver).
export const ROLE_RANK: Record<SystemRole, number> = {
  owner: 100,
  admin: 80,
  manager: 60,
  employee: 40,
  ai_employee: 40,
  read_only: 10,
};

// --- Permissions (deny-by-default) ---
export type PermissionEffect = 'allow' | 'deny';

export interface PermissionRule {
  resource: string; // e.g. "scheduling.booking"
  action: string;   // e.g. "create"
  effect: PermissionEffect;
  conditions?: Record<string, unknown>;
}

// Core resource/action vocabulary (extended by capabilities/modules).
export const PERMISSION_ACTIONS = ['create', 'read', 'update', 'delete', 'manage'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/**
 * Deny-by-default resolver: access is granted only if at least one ALLOW
 * matches and no DENY matches. No matching rule => denied.
 */
export function isAllowed(
  rules: PermissionRule[],
  resource: string,
  action: string,
): boolean {
  let allowed = false;
  for (const r of rules) {
    if (r.resource !== resource || (r.action !== action && r.action !== 'manage')) continue;
    if (r.effect === 'deny') return false; // explicit deny always wins
    if (r.effect === 'allow') allowed = true;
  }
  return allowed;
}

// --- Capability keys (mirror future Capability registry) ---
export const CAPABILITY_KEYS = [
  'crm',
  'messaging',
  'ai.receptionist',
  'ai.phone',
  'ai.ordering',
  'scheduling',
  'estimates',
  'payments',
  'reviews',
  'reputation',
  'marketing',
  'analytics',
  'knowledge_base',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export type CapabilityStatus =
  | 'available'
  | 'enabled'
  | 'configured'
  | 'paused'
  | 'disabled';

export interface CapabilityDefinition {
  key: CapabilityKey | string;
  name: string;
  category?: string;
  dependencies?: (CapabilityKey | string)[];
  isCore?: boolean;
}

// --- Organization DNA shape (inherited by AI Employees) ---
export interface OrganizationDNAShape {
  brand?: Record<string, unknown>;
  voice?: Record<string, unknown>;
  communicationStyle?: Record<string, unknown>;
  businessHours?: Record<string, unknown>;
  knowledgeSources?: unknown[];
  complianceRules?: Record<string, unknown>;
  escalationRules?: Record<string, unknown>;
  aiDefaults?: Record<string, unknown>;
  providerDefaults?: Partial<Record<string, string>>;
}

// --- Auth provider types (mirror Prisma enum AuthProviderType) ---
export const AUTH_PROVIDER_TYPES = [
  'password',
  'google_oauth',
  'microsoft_oauth',
  'saml_sso',
  'oidc_sso',
  'magic_link',
] as const;
export type AuthProviderType = (typeof AUTH_PROVIDER_TYPES)[number];
