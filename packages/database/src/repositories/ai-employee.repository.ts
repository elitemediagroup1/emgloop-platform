// AIEmployeeRepository — Sprint 4 (Real Data Layer) + Sprint 7 (management).
//
// The loop assigns an AI Employee ('Ava') to each new customer. Sprint 4
// persisted this; Sprint 7 adds the full management surface administrators use
// to create, edit, and archive AI Employees and configure their department,
// status, channels, working hours, escalation behavior, DNA inheritance /
// overrides, and (configuration-only) voice + AI provider preferences. No real
// providers, no API keys — preferences are stored as plain config in the
// already-designed JSON columns.

import type { PrismaClient, AIEmployee, ChannelType } from '@prisma/client';
import { AIEmployeeStatus } from '@prisma/client';

export interface AIEmployeeView {
  id: string;
  name: string;
  title: string;
  department: string;
  status: string;
  channels: string[];
  inheritsDNA: boolean;
  voiceProvider: string;
  aiProvider: string;
  createdAt: string;
}

function jsonObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function toView(e: AIEmployee): AIEmployeeView {
  const attrs = jsonObj(e.attributes);
  const prefs = jsonObj(e.providerPrefs);
  return {
    id: e.id,
    name: e.name,
    title: e.title ?? '',
    department: str(attrs.department),
    status: e.status,
    channels: e.channels as unknown as string[],
    inheritsDNA: e.inheritsDNA,
    voiceProvider: str(prefs.voiceProvider),
    aiProvider: str(prefs.aiProvider),
    createdAt: e.createdAt.toISOString(),
  };
}

export class AIEmployeeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findActive(organizationId: string): Promise<AIEmployee | null> {
    return this.prisma.aIEmployee.findFirst({
      where: { organizationId, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Ensure a default front-desk AI Employee exists for the org. Returns the
   * existing one if present, otherwise creates 'Ava'.
   */
  async ensureDefault(args: {
    organizationId: string;
    name?: string;
    title?: string;
  }): Promise<AIEmployee> {
    const existing = await this.findActive(args.organizationId);
    if (existing) return existing;
    return this.prisma.aIEmployee.create({
      data: {
        organizationId: args.organizationId,
        name: args.name ?? 'Ava',
        title: args.title ?? 'Front Desk AI Employee',
        status: 'ACTIVE',
        channels: ['SMS', 'WEB_CHAT'],
      },
    });
  }

  listByOrganization(organizationId: string): Promise<AIEmployee[]> {
    return this.prisma.aIEmployee.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // --- Sprint 7: management surface ------------------------------------

  async listViews(organizationId: string): Promise<AIEmployeeView[]> {
    const rows = await this.listByOrganization(organizationId);
    return rows.map(toView);
  }

  async getView(id: string): Promise<AIEmployeeView | null> {
    const e = await this.prisma.aIEmployee.findUnique({ where: { id } });
    return e ? toView(e) : null;
  }

  async createEmployee(args: {
    organizationId: string;
    name: string;
    title?: string;
    department?: string;
    channels?: ChannelType[];
    inheritsDNA?: boolean;
    workingHours?: Record<string, unknown>;
    escalation?: Record<string, unknown>;
    dnaOverrides?: Record<string, unknown>;
    voiceProvider?: string;
    aiProvider?: string;
  }): Promise<AIEmployee> {
    return this.prisma.aIEmployee.create({
      data: {
        organizationId: args.organizationId,
        name: args.name.trim(),
        title: args.title ?? null,
        status: 'DRAFT',
        channels: args.channels ?? [],
        inheritsDNA: args.inheritsDNA ?? true,
        operatingHours: (args.workingHours ?? {}) as object,
        escalationRules: (args.escalation ?? {}) as object,
        dnaOverrides: (args.dnaOverrides ?? {}) as object,
        attributes: { department: args.department ?? '' } as object,
        providerPrefs: {
          voiceProvider: args.voiceProvider ?? '',
          aiProvider: args.aiProvider ?? '',
        } as object,
      },
    });
  }

  async updateEmployee(
    id: string,
    fields: {
      name?: string;
      title?: string;
      department?: string;
      status?: AIEmployeeStatus;
      channels?: ChannelType[];
      inheritsDNA?: boolean;
      workingHours?: Record<string, unknown>;
      escalation?: Record<string, unknown>;
      dnaOverrides?: Record<string, unknown>;
      voiceProvider?: string;
      aiProvider?: string;
    },
  ): Promise<AIEmployee> {
    const existing = await this.prisma.aIEmployee.findUnique({ where: { id } });
    const attrs = existing ? jsonObj(existing.attributes) : {};
    const prefs = existing ? jsonObj(existing.providerPrefs) : {};
    const data: Record<string, unknown> = {};
    if (fields.name !== undefined) data.name = fields.name.trim();
    if (fields.title !== undefined) data.title = fields.title;
    if (fields.status !== undefined) data.status = fields.status;
    if (fields.channels !== undefined) data.channels = fields.channels;
    if (fields.inheritsDNA !== undefined) data.inheritsDNA = fields.inheritsDNA;
    if (fields.workingHours !== undefined) data.operatingHours = fields.workingHours as object;
    if (fields.escalation !== undefined) data.escalationRules = fields.escalation as object;
    if (fields.dnaOverrides !== undefined) data.dnaOverrides = fields.dnaOverrides as object;
    if (fields.department !== undefined) {
      data.attributes = { ...attrs, department: fields.department } as object;
    }
    if (fields.voiceProvider !== undefined || fields.aiProvider !== undefined) {
      data.providerPrefs = {
        ...prefs,
        ...(fields.voiceProvider !== undefined ? { voiceProvider: fields.voiceProvider } : {}),
        ...(fields.aiProvider !== undefined ? { aiProvider: fields.aiProvider } : {}),
      } as object;
    }
    return this.prisma.aIEmployee.update({ where: { id }, data });
  }

  archive(id: string): Promise<AIEmployee> {
    return this.prisma.aIEmployee.update({
      where: { id },
      data: { status: 'ARCHIVED' },
    });
  }

  setStatus(id: string, status: AIEmployeeStatus): Promise<AIEmployee> {
    return this.prisma.aIEmployee.update({ where: { id }, data: { status } });
  }
}
