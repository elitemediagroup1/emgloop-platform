'use server';

// EMG Creator Operations: the server actions behind the EMG seat's forms (Creator Hub, 2026-09-22).
//
// EVERY ACTION BEGINS WITH THE EMG SEAT. `requireEmgActor()` resolves the organization and the
// person from the signed session; an ADMIN authority may act on any production step, an
// EMPLOYEE only on their own (the service re-checks). Nothing here reads an organization, a
// creator or a role from the form. Ids in the form are resolved WITHIN the session's
// organization by the domain services, which answer not-found for anything foreign.
//
// A REFUSAL IS A REDIRECT, NOT A THROW. The page the form was on renders `?refused=<reason>`
// as an attention block, so a refused act never becomes a crash and never records anything.
//
// TIME: a datetime-local value is a wall-clock time in the reader's zone (the device zone the
// browser reported). It becomes an instant through the Loop Time Authority's zone math, never
// through `new Date(local)`, which would read the server's clock.

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { repositories, userSystemRole, type DeclareDeliverableInput } from '@emgloop/database';
import {
  CAMPAIGN_STATES,
  CREATOR_VISIBLE_OPPORTUNITY_STATES,
  DELIVERABLE_TYPES,
  resolveDisplayTimeZone,
  validateNotes,
  zonedWallTimeToUtc,
  type AddressedNote,
  type DeliverableRequirement,
  type DeliverableRequirementKey,
} from '@emgloop/shared';
import { safeNextPath } from '../auth/landing';
import { readerTimeZone } from '../daily-loop/reader-zone';
import { creatorDomain, requireEmgActor, EMG_HREFS } from './creator-runtime';

/** The refusal words the pages know how to render. Service refusals pass through by name. */
export type EmgRefusal =
  | 'NOT_FOUND'
  | 'NOT_YOURS'
  | 'NOT_ALLOWED'
  | 'INVALID'
  | 'PRODUCTION_ACTIVE'
  | 'NO_ACTIVE_PRODUCTION'
  | 'NOT_YOUR_STEP'
  | 'VERSION_NOT_READY'
  | 'BAD_DATE'
  | 'BAD_NOTES'
  | 'NOT_A_CREATOR_LOGIN';

const str = (formData: FormData, key: string): string => String(formData.get(key) ?? '').trim();
const on = (formData: FormData, key: string): boolean => {
  const v = formData.get(key);
  return v === 'on' || v === 'true' || v === '1';
};

/** Where the form came from: a safe application path, else the roster. Never an external URL. */
function returnPath(formData: FormData, fallback: string = EMG_HREFS.creators): string {
  return safeNextPath(formData.get('returnTo')) ?? fallback;
}

function withRefusal(path: string, reason: EmgRefusal): string {
  const [base, hash] = path.split('#', 2);
  const joiner = base!.includes('?') ? '&' : '?';
  return `${base}${joiner}refused=${encodeURIComponent(reason)}${hash ? `#${hash}` : ''}`;
}

function done(path: string, ...alsoRevalidate: string[]): never {
  revalidatePath(path.split('?')[0]!.split('#')[0]!);
  for (const p of alsoRevalidate) revalidatePath(p);
  redirect(path);
}

function refuse(path: string, reason: EmgRefusal): never {
  redirect(withRefusal(path, reason));
}

/**
 * A datetime-local value ("YYYY-MM-DDTHH:mm") in the reader's zone, as an instant. Empty is
 * null (the field was left blank); malformed is undefined (a refusal).
 */
function wallTimeToInstant(raw: string): Date | null | undefined {
  if (raw === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (!m) return undefined;
  const zone = resolveDisplayTimeZone({ preference: null, device: readerTimeZone() });
  const instant = zonedWallTimeToUtc(zone.timeZone, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  return Number.isFinite(instant.getTime()) ? instant : undefined;
}

function parseAddressed(raw: string): AddressedNote[] | null {
  if (raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: AddressedNote[] = [];
  for (const item of parsed) {
    const o = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    if (typeof o.noteId !== 'string' || o.noteId === '') return null;
    const reply = typeof o.reply === 'string' ? o.reply.trim().slice(0, 500) : '';
    out.push({ noteId: o.noteId, addressed: o.addressed === true, reply: reply || null });
  }
  return out;
}

// ---- productions (Work OS) ----------------------------------------------------------------------

export async function setExpectedReturnAction(formData: FormData): Promise<void> {
  const { actor, workspace } = await requireEmgActor();
  const workInstanceId = str(formData, 'workInstanceId');
  const back = returnPath(formData, workspace === 'ADMIN' ? EMG_HREFS.adminWork(workInstanceId) : EMG_HREFS.employeeWork(workInstanceId));
  if (!workInstanceId) refuse(back, 'INVALID');
  // Committing a turnaround is the manager's call; an editor asks for one.
  if (workspace !== 'ADMIN') refuse(back, 'NOT_ALLOWED');
  const expectedReturnAt = wallTimeToInstant(str(formData, 'expectedReturnAt'));
  if (expectedReturnAt === undefined) refuse(back, 'BAD_DATE');
  const result = await creatorDomain().productions.setExpectedReturn(actor, { workInstanceId, expectedReturnAt: expectedReturnAt! });
  if (!result.ok) refuse(back, result.reason);
  done(back, EMG_HREFS.requests);
}

export async function returnVersionForReviewAction(formData: FormData): Promise<void> {
  const { actor, workspace } = await requireEmgActor();
  const workInstanceId = str(formData, 'workInstanceId');
  const back = returnPath(formData, workspace === 'ADMIN' ? EMG_HREFS.adminWork(workInstanceId) : EMG_HREFS.employeeWork(workInstanceId));
  const versionId = str(formData, 'versionId');
  if (!workInstanceId || !versionId) refuse(back, 'INVALID');
  const addressed = parseAddressed(str(formData, 'addressed'));
  if (addressed === null) refuse(back, 'BAD_NOTES');
  const result = await creatorDomain().productions.returnVersionForReview(actor, {
    workInstanceId,
    versionId,
    noteToCreator: str(formData, 'noteToCreator').slice(0, 2000) || null,
    addressed: addressed!,
  });
  if (!result.ok) refuse(back, result.reason);
  done(back, EMG_HREFS.requests, EMG_HREFS.creators);
}

export async function addProductionCommentAction(formData: FormData): Promise<void> {
  const { actor, workspace } = await requireEmgActor();
  const workInstanceId = str(formData, 'workInstanceId');
  const back = returnPath(formData, workspace === 'ADMIN' ? EMG_HREFS.adminWork(workInstanceId) : EMG_HREFS.employeeWork(workInstanceId));
  const body = str(formData, 'body').slice(0, 4000);
  if (!workInstanceId || !body) refuse(back, 'INVALID');
  // Internal unless the person chose otherwise: the default never widens visibility.
  const visibility = str(formData, 'visibility') === 'creator_visible' ? 'creator_visible' : 'internal';
  const result = await creatorDomain().productions.addEmgComment(actor, { workInstanceId, body, visibility });
  if (!result.ok) refuse(back, result.reason);
  done(back);
}

// ---- approvals and relayed feedback (the Content record) -----------------------------------------

/** The version a mark lands on: separate fields, or one "contentId|versionId" choice from a select. */
function targetOf(formData: FormData): { contentId: string; versionId: string } {
  const contentId = str(formData, 'contentId');
  const versionId = str(formData, 'versionId');
  if (contentId && versionId) return { contentId, versionId };
  const [c = '', v = ''] = str(formData, 'target').split('|', 2);
  return { contentId: c.trim(), versionId: v.trim() };
}

export async function recordEmgApprovalAction(formData: FormData): Promise<void> {
  const { actor } = await requireEmgActor();
  const back = returnPath(formData);
  const { contentId, versionId } = targetOf(formData);
  if (!contentId || !versionId) refuse(back, 'INVALID');
  const result = await creatorDomain().productions.recordEmgApproval(actor, { contentId, versionId, note: str(formData, 'note').slice(0, 2000) || null });
  if (!result.ok) refuse(back, result.reason);
  done(back);
}

export async function recordBrandApprovalAction(formData: FormData): Promise<void> {
  const { actor } = await requireEmgActor();
  const back = returnPath(formData);
  const { contentId, versionId } = targetOf(formData);
  const originatorLabel = str(formData, 'originatorLabel').slice(0, 120);
  if (!contentId || !versionId || !originatorLabel) refuse(back, 'INVALID');
  const result = await creatorDomain().productions.recordBrandApproval(actor, { contentId, versionId, originatorLabel, note: str(formData, 'note').slice(0, 2000) || null });
  if (!result.ok) refuse(back, result.reason);
  done(back);
}

export async function relayBrandFeedbackAction(formData: FormData): Promise<void> {
  const { actor } = await requireEmgActor();
  const back = returnPath(formData);
  const contentId = str(formData, 'contentId');
  const originatorLabel = str(formData, 'originatorLabel').slice(0, 120);
  if (!contentId || !originatorLabel) refuse(back, 'INVALID');
  const summary = str(formData, 'summary').slice(0, 2000) || null;
  const notesRaw = str(formData, 'notes');
  let notes: ReturnType<typeof validateNotes> = { ok: true, notes: [] };
  if (notesRaw !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(notesRaw);
    } catch {
      refuse(back, 'BAD_NOTES');
    }
    if (!Array.isArray(parsed)) refuse(back, 'BAD_NOTES');
    notes = validateNotes(parsed as unknown[]);
  }
  if (!notes.ok) refuse(back, 'BAD_NOTES');
  const requestedReturnAt = wallTimeToInstant(str(formData, 'requestedReturnAt'));
  if (requestedReturnAt === undefined) refuse(back, 'BAD_DATE');
  const result = await creatorDomain().productions.relayBrandFeedback(actor, {
    contentId,
    originatorLabel,
    summary,
    notes: notes.ok ? notes.notes : [],
    requestedReturnAt: requestedReturnAt!,
  });
  if (!result.ok) refuse(back, result.reason);
  done(back, EMG_HREFS.requests, EMG_HREFS.creators);
}

// ---- commercial designations (CRM records, EMG side) ---------------------------------------------

export async function designateOpportunityAction(formData: FormData): Promise<void> {
  const { actor } = await requireEmgActor();
  const back = returnPath(formData);
  const opportunityId = str(formData, 'opportunityId');
  if (!opportunityId) refuse(back, 'INVALID');
  const stateRaw = str(formData, 'creatorVisibleState');
  if (stateRaw !== '' && !(CREATOR_VISIBLE_OPPORTUNITY_STATES as readonly string[]).includes(stateRaw)) refuse(back, 'INVALID');
  // Brand visibility is a keep / show / hide choice: the EMG projection does not report the
  // current value, so a form must never reset it as a side effect of saving something else.
  const brand = str(formData, 'brandVisibility');
  if (brand !== '' && brand !== 'show' && brand !== 'hide') refuse(back, 'INVALID');
  const updated = await creatorDomain().commercial.designateOpportunity(actor.organizationId, opportunityId, {
    creatorVisibleState: stateRaw === '' ? null : stateRaw,
    ...(brand === '' ? {} : { brandVisibleToCreator: brand === 'show' }),
    summaryForCreator: str(formData, 'summaryForCreator').slice(0, 2000) || null,
  });
  if (!updated) refuse(back, 'NOT_FOUND');
  done(back);
}

export async function transitionCampaignAction(formData: FormData): Promise<void> {
  const { actor } = await requireEmgActor();
  const back = returnPath(formData);
  const campaignId = str(formData, 'campaignId');
  const toState = str(formData, 'toState');
  if (!campaignId || !(CAMPAIGN_STATES as readonly string[]).includes(toState)) refuse(back, 'INVALID');
  const updated = await creatorDomain().commercial.transitionCampaign({
    organizationId: actor.organizationId,
    campaignId,
    toState,
    actorUserId: actor.userId,
    note: str(formData, 'note').slice(0, 1000) || null,
  });
  if (!updated) refuse(back, 'NOT_FOUND');
  done(back);
}

const REQUIREMENT_LABELS: Record<DeliverableRequirementKey, string> = {
  creator: 'Your approval',
  emg: 'EMG approval',
  brand: 'Brand approval',
  published: 'Published',
};

export async function declareDeliverableAction(formData: FormData): Promise<void> {
  const { actor } = await requireEmgActor();
  const back = returnPath(formData);
  const domain = creatorDomain();
  const profileId = str(formData, 'profileId');
  const campaignId = str(formData, 'campaignId');
  const title = str(formData, 'title').slice(0, 140);
  const deliverableType = str(formData, 'deliverableType');
  if (!profileId || !campaignId || !title || !(DELIVERABLE_TYPES as readonly string[]).includes(deliverableType)) refuse(back, 'INVALID');
  // The creator party comes from the profile in this organization, never from the form; the
  // campaign must be that creator's.
  const profile = await domain.creator.profileById(actor.organizationId, profileId);
  if (!profile) refuse(back, 'NOT_FOUND');
  const campaign = await domain.commercial.getCampaign(actor.organizationId, campaignId);
  if (!campaign || campaign.creatorPartyId !== profile!.partyId) refuse(back, 'NOT_FOUND');
  const dueAt = wallTimeToInstant(str(formData, 'dueAt'));
  if (dueAt === undefined) refuse(back, 'BAD_DATE');
  const requirements: DeliverableRequirement[] = (['creator', 'emg', 'brand', 'published'] as const)
    .filter((key) => on(formData, `req_${key}`))
    .map((key) => ({ key, label: REQUIREMENT_LABELS[key], required: true }));
  await domain.commercial.declareDeliverable({
    organizationId: actor.organizationId,
    campaignId: campaign!.id,
    creatorPartyId: profile!.partyId,
    title,
    deliverableType,
    dueAt: dueAt!,
    // Plain JSON objects; the repository's Prisma JSON type cannot see that through the interface.
    requirements: requirements as unknown as DeclareDeliverableInput['requirements'],
    acceptsUnedited: on(formData, 'acceptsUnedited'),
    createdByUserId: actor.userId,
  });
  done(back);
}

// ---- the creator's login --------------------------------------------------------------------------

/** Bind a creator profile to an ACTIVE login that holds the CREATOR role, chosen by email. */
export async function bindCreatorLoginAction(formData: FormData): Promise<void> {
  const { actor, workspace } = await requireEmgActor();
  const back = returnPath(formData);
  if (workspace !== 'ADMIN') refuse(back, 'NOT_ALLOWED');
  const profileId = str(formData, 'profileId');
  const email = str(formData, 'email').toLowerCase();
  if (!profileId) refuse(back, 'INVALID');
  const domain = creatorDomain();
  if (email === '') {
    // Unbind: the profile keeps everything; nobody can sign in as this creator until rebound.
    const cleared = await domain.creator.bindUser(actor.organizationId, profileId, null);
    if (!cleared) refuse(back, 'NOT_FOUND');
    done(back);
  }
  // An ACTIVE member of THIS organization, through the repository (never prisma here).
  const user = await repositories.auth.findUserByEmail(actor.organizationId, email);
  if (!user || user.status !== 'ACTIVE') refuse(back, 'NOT_FOUND');
  if (userSystemRole(user!) !== 'CREATOR') refuse(back, 'NOT_A_CREATOR_LOGIN');
  const bound = await domain.creator.bindUser(actor.organizationId, profileId, user!.id);
  if (!bound) refuse(back, 'NOT_FOUND');
  done(back);
}
