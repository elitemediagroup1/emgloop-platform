// Party read loaders -- identity slice P1.
//
// Server-only loaders a page calls to render People, Companies, the establishment
// review queue and a Party record (`@emgloop/shared` party-read-model.ts). Each
// resolves the session first; `PartyRecordService` then checks
// identityResolution:view before reading anything, and returns the viewer's
// capabilities so the UI offers only the acts the server would allow.
//
// People are established PERSON Parties, never Intake Records (legacy Customer
// rows). An empty list is the correct answer while no Party is established.

import 'server-only';
import { PartyRecordService, prisma } from '@emgloop/database';
import type { PartyType } from '@emgloop/shared';
import { requireCrmContext } from './crm-data';

const records = new PartyRecordService(prisma);

export async function loadPeople(opts: { cursor?: string | null; limit?: number } = {}) {
  const ctx = await requireCrmContext();
  return records.listPeople(ctx.organizationId, ctx.userId, opts);
}

export async function loadCompanies(opts: { cursor?: string | null; limit?: number } = {}) {
  const ctx = await requireCrmContext();
  return records.listCompanies(ctx.organizationId, ctx.userId, opts);
}

export async function loadEstablishmentQueue(
  opts: { cursor?: string | null; limit?: number; partyType?: PartyType | null } = {},
) {
  const ctx = await requireCrmContext();
  return records.listEstablishmentQueue(ctx.organizationId, ctx.userId, opts);
}

export async function loadPartyRecord(partyId: string) {
  const ctx = await requireCrmContext();
  return records.getRecord(ctx.organizationId, ctx.userId, partyId);
}
