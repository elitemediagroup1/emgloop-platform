// Repository-backed demo store — Sprint 4 (Real Data Layer).
//
// Replaces the Sprint 3 in-memory arrays (store.ts) with REAL PostgreSQL
// persistence via the @emgloop/database repository layer. The loop engine,
// seed, dashboard, and timeline all talk to this facade instead of pushing to
// process-local arrays.
//
// Responsibilities:
//   - Resolve the demo organization + default AI Employee (idempotently).
//   - Translate the loop's lightweight vocabulary (loopKind like "quote_request",
//     channels like "web_chat") to/from the canonical schema enums.
//   - Expose org-scoped reads/writes used by the loop and the UI.
//
// Nothing here calls an external provider — providers remain fully abstracted
// and mocked. This file only governs PERSISTENCE.

import {
  prisma,
  createRepositories,
  customerDisplayName,
  type ChannelType,
  type InteractionKind,
  type InteractionDirection,
} from '@emgloop/database';

const repos = createRepositories(prisma);

export const ORG_SLUG = 'servicesinmycity-demo';

// --- Loop vocabulary ---------------------------------------------------------
// The loop describes timeline steps with these stable labels; we persist them
// in interaction.payload.loopKind and map to the schema InteractionKind enum.
export type LoopKind =
  | 'quote_request'
  | 'system_note'
  | 'assignment'
  | 'outbound_message'
  | 'inbound_message'
  | 'booking_created'
  | 'booking_confirmed';

export type LoopChannel =
  | 'web_chat'
  | 'sms'
  | 'email'
  | 'phone'
  | 'in_person'
  | 'system';

const LOOP_KIND_TO_ENUM: Record<LoopKind, InteractionKind> = {
  quote_request: 'FORM_SUBMISSION',
  system_note: 'NOTE',
  assignment: 'NOTE',
  outbound_message: 'SMS',
  inbound_message: 'SMS',
  booking_created: 'APPOINTMENT',
  booking_confirmed: 'APPOINTMENT',
};

const CHANNEL_TO_ENUM: Record<LoopChannel, ChannelType> = {
  web_chat: 'WEB_CHAT',
  sms: 'SMS',
  email: 'EMAIL',
  phone: 'PHONE',
  in_person: 'IN_PERSON',
  system: 'OTHER',
};

// --- View models the UI renders (decoupled from Prisma row shapes) ----------
export interface CustomerView {
  id: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  state: string;
}

export interface TimelineEntry {
  id: string;
  loopKind: LoopKind | string;
  channel: string;
  summary: string;
  body?: string;
  actorType: string;
  occurredAt: string;
}

export interface BookingView {
  id: string;
  status: string;
  serviceType: string;
  calendarProvider?: string | null;
  calendarEventId?: string | null;
}

// --- Org + AI Employee resolution -------------------------------------------

/** Resolve (creating if needed) the demo organization. */
export async function ensureDemoOrganization(): Promise<{ id: string }> {
  const org = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    update: {},
    create: {
      name: 'ServicesInMyCity (Demo)',
      slug: ORG_SLUG,
      industry: 'HOME_SERVICES',
      status: 'ACTIVE',
      sourceKey: 'servicesinmycity',
      timezone: 'America/Chicago',
    },
    select: { id: true },
  });
  return org;
}

export async function ensureAIEmployee(organizationId: string) {
  return repos.aiEmployees.ensureDefault({
    organizationId,
    name: 'Ava',
    title: 'Front Desk AI Employee',
  });
}

// --- Mappers -----------------------------------------------------------------

function attr<T = unknown>(obj: unknown, key: string): T | undefined {
  if (obj && typeof obj === 'object' && key in (obj as Record<string, unknown>)) {
    return (obj as Record<string, T>)[key];
  }
  return undefined;
}

export function toCustomerView(c: {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  attributes: unknown;
}): CustomerView {
  return {
    id: c.id,
    name: customerDisplayName(c as never),
    email: c.email ?? '',
    phone: c.phone ?? '',
    city: attr<string>(c.attributes, 'city') ?? '',
    state: attr<string>(c.attributes, 'state') ?? '',
  };
}

export function toTimelineEntry(i: {
  id: string;
  kind: string;
  channel: string;
  summary: string | null;
  payload: unknown;
  occurredAt: Date;
}): TimelineEntry {
  return {
    id: i.id,
    loopKind: attr<string>(i.payload, 'loopKind') ?? i.kind,
    channel: (attr<string>(i.payload, 'loopChannel') ?? i.channel).toLowerCase(),
    summary: i.summary ?? '',
    body: attr<string>(i.payload, 'body'),
    actorType: attr<string>(i.payload, 'actorType') ?? 'system',
    occurredAt: i.occurredAt.toISOString(),
  };
}

// --- Repository access + enum maps (used by the loop engine) ----------------
export const store = repos;
export { LOOP_KIND_TO_ENUM, CHANNEL_TO_ENUM };

/** Helpers re-exported so the loop engine never imports Prisma maps directly. */
export function loopKindToEnum(kind: LoopKind): InteractionKind {
  return LOOP_KIND_TO_ENUM[kind];
}

export function channelToEnum(channel: LoopChannel): ChannelType {
  return CHANNEL_TO_ENUM[channel];
}

export function directionFor(
  d: 'inbound' | 'outbound' | 'internal',
): InteractionDirection {
  if (d === 'inbound') return 'INBOUND';
  if (d === 'outbound') return 'OUTBOUND';
  return 'INTERNAL';
}
