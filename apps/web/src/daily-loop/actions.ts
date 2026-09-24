'use server';

// Daily Loop actions. One, and it acts on the person asking, for their own calendar only.
//
// WHOSE CALENDAR IS NOT AN ARGUMENT. `requirePermission` resolves the session and the authority;
// the principal is built from that session and nothing in the form is read. There is no input
// that could make this refresh somebody else's calendar, whatever role the caller holds.

import { revalidatePath } from 'next/cache';

import { requirePermission } from '../auth/guard';
import { LOOP_HOME } from '../auth/landing';
import { refreshYourDay } from './your-day';

export async function refreshCalendarAction(): Promise<void> {
  const session = await requirePermission('employeeIntelligence', 'update');
  await refreshYourDay({ organizationId: session.organizationId, userId: session.userId });
  revalidatePath(LOOP_HOME);
  // The Calendar page draws the same day; it offers the same control.
  revalidatePath('/app/calendar');
}
