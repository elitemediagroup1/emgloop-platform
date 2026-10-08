'use server';

// People command center write actions (CRM slice 6). THIN WRAPPERS.
//
// Each resolves the session, reads strings out of a FormData and calls the governed service --
// `CrmOutreachService` for human interpretation and notes, `CrmPeopleDiscoveryService` for Possible
// New People. Nothing here authorizes, validates, writes an audit row or an outbox row: that is the
// services', and repeating it here would make a second authority that drifts.
//
// THE ORGANIZATION AND THE ACTOR COME ONLY FROM THE SIGNED SESSION. A Possible New People form
// carries only the viewer's OWN correspondent hash -- never an address -- and the service re-reads
// the address from the viewer's own mail at click time.
//
// THE CLOCK IS THE SERVER'S. A due date is a calendar date the person picked; it is stored as that
// date at 00:00 UTC and shown as a date.

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { CrmOutreachService, CrmPeopleDiscoveryService, prisma } from '@emgloop/database';
import { isCrmHumanConversationState, type CrmDiscoveryDismissReason } from '@emgloop/shared';

import { requireCrmContext } from './crm-data';
import { DISCOVER_HREF } from './outreach-hrefs';
import { personHref, PEOPLE_HREF } from './crm-slice-data';

const outreach = new CrmOutreachService(prisma);
const discovery = new CrmPeopleDiscoveryService(prisma);

const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
};

async function actor() {
  const ctx = await requireCrmContext();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

function back(partyId: string, outcome: string): never {
  revalidatePath(PEOPLE_HREF);
  redirect(`${personHref(partyId)}?outcome=${encodeURIComponent(outcome)}#outreach`);
}

/** A YYYY-MM-DD the person picked, as that date at 00:00 UTC; null when blank; undefined when malformed. */
function dueDate(raw: string): Date | null | undefined {
  const s = raw.trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? undefined : d;
}

export async function setConversationStateAction(form: FormData): Promise<void> {
  const who = await actor();
  const partyId = field(form, 'partyId');
  const raw = field(form, 'state');
  const state = raw === 'CLEAR' ? null : isCrmHumanConversationState(raw) ? raw : undefined;
  if (state === undefined) back(partyId, 'INVALID');
  const r = await outreach.setState(who, partyId, state);
  back(partyId, r.outcome === 'INVALID' ? `INVALID_${r.violation}` : r.outcome);
}

export async function setNextActionAction(form: FormData): Promise<void> {
  const who = await actor();
  const partyId = field(form, 'partyId');
  if (field(form, 'clear') === '1') {
    const r = await outreach.setNextAction(who, partyId, null);
    back(partyId, r.outcome);
  }
  const due = dueDate(field(form, 'dueDate'));
  if (due === undefined) back(partyId, 'INVALID_DUE_DATE_INVALID');
  const r = await outreach.setNextAction(who, partyId, { text: field(form, 'text'), dueAt: due });
  back(partyId, r.outcome === 'INVALID' ? `INVALID_${r.violation}` : r.outcome);
}

export async function recordNoteAction(form: FormData): Promise<void> {
  const who = await actor();
  const partyId = field(form, 'partyId');
  const kind = field(form, 'kind');
  const r = kind === 'TITLE' ? await outreach.recordTitle(who, partyId, field(form, 'text')) : await outreach.recordNote(who, partyId, field(form, 'text'));
  back(partyId, r.outcome === 'INVALID' ? `INVALID_${r.violation}` : r.outcome);
}

export async function retractFactAction(form: FormData): Promise<void> {
  const who = await actor();
  const partyId = field(form, 'partyId');
  const r = await outreach.retractFact(who, field(form, 'factId'));
  back(partyId, r.outcome);
}

// --- Possible New People ------------------------------------------------------------------------

export async function addDiscoveredPersonAction(form: FormData): Promise<void> {
  const who = await actor();
  const r = await discovery.add(who, field(form, 'candidate'), field(form, 'name'));
  revalidatePath(DISCOVER_HREF);
  revalidatePath(PEOPLE_HREF);
  if (r.outcome === 'ADDED') redirect(`${personHref(r.partyId)}?outcome=ADDED_FROM_DISCOVERY`);
  if (r.outcome === 'ALREADY_EXISTS') redirect(`${personHref(r.partyId)}?outcome=ALREADY_EXISTS`);
  redirect(`${DISCOVER_HREF}?outcome=${encodeURIComponent(r.outcome === 'REFUSED' ? `REFUSED_${r.step}` : r.outcome)}`);
}

export async function dismissDiscoveredAction(form: FormData): Promise<void> {
  const who = await actor();
  const r = await discovery.dismiss(who, field(form, 'candidate'), field(form, 'reason') as CrmDiscoveryDismissReason);
  revalidatePath(DISCOVER_HREF);
  redirect(`${DISCOVER_HREF}?outcome=${r}`);
}

export async function restoreDiscoveredAction(form: FormData): Promise<void> {
  const who = await actor();
  const r = await discovery.restore(who, field(form, 'candidate'));
  revalidatePath(DISCOVER_HREF);
  redirect(`${DISCOVER_HREF}?outcome=${r}&show=dismissed`);
}
