// OrganizationRepository — Sprint 7 (Identity, Authentication & Organizations).
//
// Real organization management replacing the demo-only assumption. Wraps the
// Organization table plus its OrganizationSettings / OrganizationPreferences /
// OrganizationDNA satellites. Branding, timezone, and CRM defaults live in the
// already-designed JSON columns (settings.branding, dna.brand, settings.defaults)
// so nothing in the schema is reinvented. The seeded servicesinmycity-demo org
// keeps working untouched.

import type { PrismaClient, Organization } from '@prisma/client';

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  industry: string;
  status: string;
  timezone: string;
  userCount: number;
  customerCount: number;
  createdAt: string;
}

export interface OrgBranding {
  primaryColor: string;
  accentColor: string;
  logoText: string;
  tagline: string;
}

export interface OrgCrmDefaults {
  defaultPipelineStatus: string;
  defaultAssignee: string;
  defaultAIEmployee: string;
  defaultTags: string[];
}

function jsonObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export class OrganizationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findById(id: string): Promise<Organization | null> {
    return this.prisma.organization.findUnique({ where: { id } });
  }

  findBySlug(slug: string): Promise<Organization | null> {
    return this.prisma.organization.findUnique({ where: { slug } });
  }

  /** All organizations with light usage counts, for the switcher + list. */
  async listSummaries(): Promise<OrgSummary[]> {
    const orgs = await this.prisma.organization.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { users: true, customers: true } } },
    });
    return orgs.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      industry: o.industry,
      status: o.status,
      timezone: o.timezone,
      userCount: o._count.users,
      customerCount: o._count.customers,
      createdAt: o.createdAt.toISOString(),
    }));
  }

  /** Create a new organization (slugified, unique). */
  async createOrganization(args: {
    name: string;
    slug?: string;
    timezone?: string;
  }): Promise<Organization> {
    const base = (args.slug || args.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'org';
    let slug = base;
    let n = 1;
    while (await this.prisma.organization.findUnique({ where: { slug } })) {
      n += 1;
      slug = base + '-' + n;
    }
    return this.prisma.organization.create({
      data: {
        name: args.name.trim(),
        slug,
        status: 'ACTIVE',
        timezone: args.timezone || 'UTC',
      },
    });
  }

  /** Update core profile fields (name, timezone, industry). */
  async updateProfile(
    id: string,
    fields: { name?: string; timezone?: string; industry?: string },
  ): Promise<Organization> {
    const data: Record<string, unknown> = {};
    if (fields.name !== undefined) data.name = fields.name.trim();
    if (fields.timezone !== undefined) data.timezone = fields.timezone;
    if (fields.industry !== undefined) data.industry = fields.industry;
    return this.prisma.organization.update({ where: { id }, data });
  }

  // --- Branding (stored in organization.settings.branding) -------------

  async getBranding(id: string): Promise<OrgBranding> {
    const o = await this.prisma.organization.findUnique({
      where: { id },
      select: { settings: true },
    });
    const b = jsonObj(jsonObj(o?.settings).branding);
    return {
      primaryColor: str(b.primaryColor, '#7c5cff'),
      accentColor: str(b.accentColor, '#22d3ee'),
      logoText: str(b.logoText, 'EMG Loop'),
      tagline: str(b.tagline, ''),
    };
  }

  async setBranding(id: string, branding: Partial<OrgBranding>): Promise<Organization> {
    const o = await this.prisma.organization.findUnique({
      where: { id },
      select: { settings: true },
    });
    const settings = jsonObj(o?.settings);
    const current = jsonObj(settings.branding);
    settings.branding = { ...current, ...branding };
    return this.prisma.organization.update({
      where: { id },
      data: { settings: settings as object },
    });
  }

  // --- CRM defaults (stored in organization.settings.crmDefaults) ------

  async getCrmDefaults(id: string): Promise<OrgCrmDefaults> {
    const o = await this.prisma.organization.findUnique({
      where: { id },
      select: { settings: true },
    });
    const d = jsonObj(jsonObj(o?.settings).crmDefaults);
    return {
      defaultPipelineStatus: str(d.defaultPipelineStatus, 'New'),
      defaultAssignee: str(d.defaultAssignee, ''),
      defaultAIEmployee: str(d.defaultAIEmployee, ''),
      defaultTags: Array.isArray(d.defaultTags) ? (d.defaultTags as string[]) : [],
    };
  }

  async setCrmDefaults(
    id: string,
    defaults: Partial<OrgCrmDefaults>,
  ): Promise<Organization> {
    const o = await this.prisma.organization.findUnique({
      where: { id },
      select: { settings: true },
    });
    const settings = jsonObj(o?.settings);
    const current = jsonObj(settings.crmDefaults);
    settings.crmDefaults = { ...current, ...defaults };
    return this.prisma.organization.update({
      where: { id },
      data: { settings: settings as object },
    });
  }

  // --- Generic settings bag (business hours, pipeline defaults, tags) --

  async getSettingsBag(id: string): Promise<Record<string, unknown>> {
    const o = await this.prisma.organization.findUnique({
      where: { id },
      select: { settings: true },
    });
    return jsonObj(o?.settings);
  }

  async patchSettings(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Organization> {
    const o = await this.prisma.organization.findUnique({
      where: { id },
      select: { settings: true },
    });
    const settings = jsonObj(o?.settings);
    return this.prisma.organization.update({
      where: { id },
      data: { settings: { ...settings, ...patch } as object },
    });
  }
}
