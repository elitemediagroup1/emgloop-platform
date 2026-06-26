import 'server-only';

// Live organization (ServicesInMyCity) — Sprint 11 (First Live Integration).
//
// Phase 1: promote ServicesInMyCity from a demo org into a first-class PRODUCTION
// organization. This bootstrap is idempotent and additive — it reuses the
// existing seeded org (slug "servicesinmycity-demo", created by the Sprint 7
// identity bootstrap) so all existing identity, CRM data and intake keep working,
// and layers on the production profile: branding, Organization DNA, a default AI
// Employee, default workflows, default CRM settings, and a default pipeline.
//
// It deliberately does NOT create customers — live customers arrive only through
// the CallGrid webhook and the live intake (Phases 2-3). All writes go through
// the repository layer / Prisma; nothing is mocked.

import { prisma, repositories } from '@emgloop/database';

export const LIVE_ORG_SLUG = 'servicesinmycity-demo';
export const LIVE_ORG_NAME = 'ServicesInMyCity';

// Default sales pipeline for the live org.
export const LIVE_PIPELINE: string[] = [
  'New',
  'Contacted',
  'Qualified',
  'Quoted',
  'Won',
  'Lost',
];

const LIVE_BRANDING = {
  primaryColor: '#16b364',
  accentColor: '#22d3ee',
  logoText: 'ServicesInMyCity',
  tagline: 'Home services, handled.',
};

let promoted = false;
let schemaChecked = false;

/** Resolve the live organization id (or null if not bootstrapped yet). */
export async function resolveLiveOrganizationId(): Promise<string | null> {
  const org = await prisma.organization.findUnique({
    where: { slug: LIVE_ORG_SLUG },
    select: { id: true },
  });
  return org ? org.id : null;
}

/**
 * Transitional schema-compatibility shim. The canonical fix lives in the Prisma
 * migration 20250626000000_sprint_11_provider_category_ingestion_analytics,
 * which adds the INGESTION/ANALYTICS members to the ProviderCategory enum.
 *
 * Because the Netlify build pipeline runs only `prisma generate` (never
 * `migrate deploy`), a long-lived database that predates Sprint 10 may still be
 * missing those enum members. This shim closes that gap ONCE per server
 * instance — it is no longer invoked on the per-request hot path. The DDL is
 * idempotent (ADD VALUE IF NOT EXISTS); once `migrate deploy` runs everywhere
 * this shim becomes a no-op and can be deleted.
 */
async function ensureSchemaCompatibility(): Promise<void> {
  if (schemaChecked) return;
  schemaChecked = true;
  try {
    await prisma.$executeRawUnsafe(`ALTER TYPE "ProviderCategory" ADD VALUE IF NOT EXISTS 'INGESTION'`);
    await prisma.$executeRawUnsafe(`ALTER TYPE "ProviderCategory" ADD VALUE IF NOT EXISTS 'ANALYTICS'`);
  } catch {
    // enum already current, or insufficient privileges — proceed regardless.
  }
}

/**
 * Idempotently promote ServicesInMyCity to a production organization. Safe to
 * call on every CRM/admin load: it short-circuits per server instance and each
 * underlying write is an upsert/merge.
 */
export async function ensureLiveOrganization(): Promise<{ organizationId: string }> {
  // One-time schema compatibility check (no per-request DDL). The proper fix is
  // the Sprint 11 Prisma migration; this only matters for un-migrated databases.
  await ensureSchemaCompatibility();

  // Reuse the org seeded by the identity bootstrap; create it if missing so the
  // live integration works even on a fresh database.
  const org = await prisma.organization.upsert({
    where: { slug: LIVE_ORG_SLUG },
    update: { status: 'ACTIVE', industry: 'HOME_SERVICES' },
    create: {
      name: LIVE_ORG_NAME,
      slug: LIVE_ORG_SLUG,
      industry: 'HOME_SERVICES',
      status: 'ACTIVE',
      sourceKey: 'servicesinmycity',
      timezone: 'America/Chicago',
    },
    select: { id: true },
  });

  if (promoted) return { organizationId: org.id };

  // 1. Profile + branding + CRM defaults + pipeline (org.settings JSON).
  await repositories.organizations.setBranding(org.id, LIVE_BRANDING);
  await repositories.organizations.setCrmDefaults(org.id, {
    defaultPipelineStatus: 'New',
    defaultAIEmployee: 'Ava',
    defaultTags: ['lead'],
  });
  await repositories.organizations.patchSettings(org.id, {
    pipeline: LIVE_PIPELINE,
    production: true,
    liveSince: new Date().toISOString(),
  });

  // 2. Organization DNA (brand voice, hours, escalation) — production identity.
  await prisma.organizationDNA.upsert({
    where: { organizationId: org.id },
    update: {},
    create: {
      organizationId: org.id,
      industry: 'HOME_SERVICES',
      brand: LIVE_BRANDING as object,
      voice: { tone: 'friendly-professional', persona: 'helpful dispatcher' } as object,
      communicationStyle: { greeting: 'Thanks for calling ServicesInMyCity!' } as object,
      businessHours: {
        timezone: 'America/Chicago',
        mon_fri: '07:00-19:00',
        sat: '08:00-16:00',
        sun: 'closed',
        emergency: '24/7',
      } as object,
      escalationRules: { emergencyToHuman: true } as object,
      aiDefaults: { firstResponder: 'Ava' } as object,
    },
  });

  // 3. Default AI Employee for first response.
  await repositories.aiEmployees.ensureDefault({
    organizationId: org.id,
    name: 'Ava',
    title: 'Front Desk AI Employee',
  });

  // 4. Default workflows bound to live CallGrid events. Idempotent by name.
  await ensureWorkflow(org.id, {
    name: 'New inbound call — first touch',
    description: 'Tag and stage every inbound call as a new lead.',
    eventName: 'integration.call.inbound',
    steps: [
      { type: 'add_tag', config: { tag: 'inbound-call' } },
      { type: 'set_pipeline_status', config: { status: 'New' } },
    ],
  });
  await ensureWorkflow(org.id, {
    name: 'Missed call — recovery',
    description: 'Flag missed calls for prompt callback.',
    eventName: 'integration.call.missed',
    steps: [
      { type: 'add_tag', config: { tag: 'missed-call' } },
      { type: 'set_pipeline_status', config: { status: 'Contacted' } },
      { type: 'create_note', config: { text: 'Missed inbound call — return promptly.' } },
    ],
  });

  promoted = true;
  return { organizationId: org.id };
}

async function ensureWorkflow(
  organizationId: string,
  args: {
    name: string;
    description: string;
    eventName: string;
    steps: { type: string; config: Record<string, unknown> }[];
  },
): Promise<void> {
  const existing = await prisma.workflow.findFirst({
    where: { organizationId, name: args.name },
    select: { id: true },
  });
  if (existing) return;
  const wf = await repositories.workflows.createWorkflow({
    organizationId,
    name: args.name,
    description: args.description,
    trigger: 'EVENT',
    triggerConfig: { eventName: args.eventName },
    definition: { steps: args.steps as { type: any; config: Record<string, unknown> }[] },
  });
  await repositories.workflows.setActive(wf.id, true);
}
