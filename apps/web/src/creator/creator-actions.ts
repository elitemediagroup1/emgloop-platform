'use server';

// The creator seat's server actions (Creator Hub, 2026-09-22).
//
// EVERY ACTION BEGINS WITH THE SEAT. `requireCreator()` resolves the CREATOR authority and the
// profile bound to this login; nothing in the form names an organization, a creator or a person.
// The form carries only the ids of the things being acted on, and the service resolves each one
// within the seat's organization and profile -- another creator's content is not found, never
// forbidden.
//
// REFUSALS ARE SHOWN, NOT THROWN. A service answers { ok: false, reason }; the action sends the
// person back to the page they came from with `?refused=<reason>`, which that page renders as an
// attention block. A redirect is control flow in Next (it throws), so no action wraps one in a
// try/catch.
//
// TIME. A `datetime-local` value is the reader's wall clock with no zone. It is resolved in the
// reader's zone (the device zone TimeZoneSync recorded) through the Loop Time Authority, never by
// `new Date(local)` on a server whose clock is UTC.

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { INSTRUCTION_LIMITS, SOCIAL_PLATFORMS, resolveDisplayTimeZone, validateNotes, zonedWallTimeToUtc } from '@emgloop/shared';
import { readerTimeZone } from '../daily-loop/reader-zone';
import { CREATOR_HREFS, creatorDomain, requireCreator } from './creator-runtime';

const PROFILE_LIMITS = Object.freeze({ displayName: 120, handle: 60, bio: 2000, categories: 12, category: 40 });

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? '').trim();
}

/** A datetime-local value in the reader's zone as an instant; '' is "no date"; anything else is a bad date. */
function wallToInstant(local: string): { ok: true; value: Date | null } | { ok: false } {
  if (local === '') return { ok: true, value: null };
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return { ok: false };
  const zone = resolveDisplayTimeZone({ device: readerTimeZone() }).timeZone;
  const instant = zonedWallTimeToUtc(zone, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isFinite(instant.getTime()) ? { ok: true, value: instant } : { ok: false };
}

function refused(href: string, reason: string, detail?: string): never {
  const sep = href.includes('?') ? '&' : '?';
  redirect(`${href}${sep}refused=${encodeURIComponent(reason)}${detail ? `&detail=${encodeURIComponent(detail)}` : ''}`);
}

function revalidateRecord(contentId: string): void {
  revalidatePath(CREATOR_HREFS.contentRecord(contentId));
  revalidatePath(CREATOR_HREFS.content);
  revalidatePath(CREATOR_HREFS.tasks);
  revalidatePath(CREATOR_HREFS.home);
}

// ---- productions -----------------------------------------------------------------------------------

export async function requestEditAction(formData: FormData): Promise<void> {
  const seat = await requireCreator();
  const contentId = field(formData, 'contentId');
  if (!contentId) redirect(CREATOR_HREFS.content);
  const back = CREATOR_HREFS.requestEdit(contentId);
  const when = wallToInstant(field(formData, 'requestedReturnAt'));
  if (!when.ok) refused(back, 'BAD_DATE');
  const summary = field(formData, 'summary').slice(0, INSTRUCTION_LIMITS.maxSummaryChars);
  const result = await creatorDomain().productions.requestEdit(seat.actor, {
    contentId,
    sourceVersionId: field(formData, 'sourceVersionId'),
    summary: summary || null,
    notes: [],
    requestedReturnAt: when.value,
  });
  if (!result.ok) refused(back, result.reason, result.detail);
  revalidateRecord(contentId);
  redirect(CREATOR_HREFS.contentRecord(contentId));
}

export async function requestChangesAction(formData: FormData): Promise<void> {
  const seat = await requireCreator();
  const contentId = field(formData, 'contentId');
  if (!contentId) redirect(CREATOR_HREFS.content);
  const back = CREATOR_HREFS.contentRecord(contentId);
  let raw: unknown = [];
  try {
    raw = JSON.parse(field(formData, 'notes') || '[]');
  } catch {
    refused(back, 'BAD_NOTES');
  }
  if (!Array.isArray(raw)) refused(back, 'BAD_NOTES');
  const notes = validateNotes(raw as unknown[]);
  if (!notes.ok) refused(back, 'BAD_NOTES', notes.refusals.join(', '));
  const when = wallToInstant(field(formData, 'requestedReturnAt'));
  if (!when.ok) refused(back, 'BAD_DATE');
  const summary = field(formData, 'summary').slice(0, INSTRUCTION_LIMITS.maxSummaryChars);
  const result = await creatorDomain().productions.requestChanges(seat.actor, { contentId, summary: summary || null, notes: notes.notes, requestedReturnAt: when.value });
  if (!result.ok) refused(back, result.reason, result.detail);
  revalidateRecord(contentId);
  redirect(back);
}

export async function approveVersionAction(formData: FormData): Promise<void> {
  const seat = await requireCreator();
  const contentId = field(formData, 'contentId');
  if (!contentId) redirect(CREATOR_HREFS.content);
  const back = CREATOR_HREFS.contentRecord(contentId);
  const result = await creatorDomain().productions.approveVersion(seat.actor, { contentId, versionId: field(formData, 'versionId') });
  if (!result.ok) refused(back, result.reason, result.detail);
  revalidateRecord(contentId);
  redirect(back);
}

export async function submitOriginalAction(formData: FormData): Promise<void> {
  const seat = await requireCreator();
  const contentId = field(formData, 'contentId');
  if (!contentId) redirect(CREATOR_HREFS.content);
  const back = CREATOR_HREFS.contentRecord(contentId);
  const result = await creatorDomain().productions.submitOriginalForApproval(seat.actor, { contentId });
  if (!result.ok) refused(back, result.reason, result.detail);
  revalidateRecord(contentId);
  redirect(back);
}

export async function markPublishedAction(formData: FormData): Promise<void> {
  const seat = await requireCreator();
  const contentId = field(formData, 'contentId');
  if (!contentId) redirect(CREATOR_HREFS.content);
  const back = `${CREATOR_HREFS.contentRecord(contentId)}?publish=1`;
  const platform = field(formData, 'platform');
  if (!(SOCIAL_PLATFORMS as readonly string[]).includes(platform)) refused(back, 'BAD_PLATFORM');
  const url = field(formData, 'url');
  if (url && !/^https?:\/\/\S+$/i.test(url)) refused(back, 'BAD_URL');
  const when = wallToInstant(field(formData, 'publishedAt'));
  if (!when.ok) refused(back, 'BAD_DATE');
  const result = await creatorDomain().productions.markPublished(seat.actor, {
    contentId,
    versionId: field(formData, 'versionId'),
    platform,
    url: url || null,
    // No date given: the moment the creator told Loop, on the server clock (never the browser's).
    publishedAt: when.value ?? new Date(),
  });
  if (!result.ok) refused(back, result.reason, result.detail);
  revalidateRecord(contentId);
  redirect(CREATOR_HREFS.contentRecord(contentId));
}

export async function addCreatorNoteAction(formData: FormData): Promise<void> {
  const seat = await requireCreator();
  const contentId = field(formData, 'contentId');
  if (!contentId) redirect(CREATOR_HREFS.content);
  const back = CREATOR_HREFS.contentRecord(contentId);
  const body = field(formData, 'body').slice(0, INSTRUCTION_LIMITS.maxSummaryChars);
  if (!body) refused(back, 'INVALID', 'Write the note first.');
  const result = await creatorDomain().productions.addCreatorNote(seat.actor, { contentId, body });
  if (!result.ok) refused(back, result.reason, result.detail);
  revalidateRecord(contentId);
  redirect(`${back}#production`);
}

// ---- profile ---------------------------------------------------------------------------------------

export async function updateProfileAction(formData: FormData): Promise<void> {
  const seat = await requireCreator();
  const back = CREATOR_HREFS.profile;
  const displayName = field(formData, 'displayName').slice(0, PROFILE_LIMITS.displayName);
  if (!displayName) refused(back, 'INVALID', 'Your name cannot be empty.');
  const handle = field(formData, 'handle').replace(/^@+/, '').slice(0, PROFILE_LIMITS.handle);
  const bio = field(formData, 'bio').slice(0, PROFILE_LIMITS.bio);
  const categories = field(formData, 'categories')
    .split(',')
    .map((c) => c.trim().slice(0, PROFILE_LIMITS.category))
    .filter(Boolean)
    .slice(0, PROFILE_LIMITS.categories);
  const updated = await creatorDomain().creator.updateProfile(seat.actor.organizationId, seat.profileId, { displayName, handle: handle || null, bio: bio || null, categories });
  if (!updated) refused(back, 'NOT_FOUND');
  revalidatePath(back);
  revalidatePath(CREATOR_HREFS.home);
  redirect(`${back}?saved=profile`);
}

export async function updatePreferencesAction(formData: FormData): Promise<void> {
  const seat = await requireCreator();
  const back = CREATOR_HREFS.profile;
  const domain = creatorDomain();
  const profile = await domain.creator.profileById(seat.actor.organizationId, seat.profileId);
  if (!profile) refused(back, 'NOT_FOUND');
  // The bag is merged, never replaced (CLAUDE.md, Multi-Tenant Rules on metadata bags).
  const existing = profile.preferences && typeof profile.preferences === 'object' && !Array.isArray(profile.preferences) ? (profile.preferences as Record<string, unknown>) : {};
  const merged = { ...existing, notifyOnReturn: formData.get('notifyOnReturn') === 'on' };
  type Patch = Parameters<typeof domain.creator.updateProfile>[2];
  await domain.creator.updateProfile(seat.actor.organizationId, seat.profileId, { preferences: merged as unknown as NonNullable<Patch['preferences']> });
  revalidatePath(back);
  redirect(`${back}?saved=preferences`);
}
