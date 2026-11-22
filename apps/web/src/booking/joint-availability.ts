import 'server-only';
import { prisma } from '@emgloop/database';
import { zonedParts } from '@emgloop/shared';
import { googleWorkspace } from '../google/google-runtime';
import { googleBusyPeriods } from './google-calendar';
import { managerEmail } from './directory';
import { employeeWorkingHours, type BusyPeriod, type EmployeeAvailability } from './availability';

export function withinManagerHours(slot: BusyPeriod, profile: EmployeeAvailability) {
  const first = zonedParts(new Date(slot.start), profile.timeZone);
  const last = zonedParts(new Date(slot.end - 1), profile.timeZone);
  if (first.day !== last.day || first.month !== last.month || first.year !== last.year) return false;
  const date = new Date(Date.UTC(first.year, first.month - 1, first.day));
  return employeeWorkingHours(profile, date.toISOString().slice(0,10), date.getUTCDay()).some(h =>
    h.startMinute <= first.hour * 60 + first.minute && last.hour * 60 + last.minute < h.endMinute
  ) && !profile.blockedTimes.some(block => block.start < slot.end && slot.start < block.end);
}

export async function jointAvailability(organizationId: string, organizerId: string, window: BusyPeriod) {
  const manager = await prisma.employeeBookingProfile.findFirst({
    where: { isPublished: true, user: { organizationId, email: { equals: managerEmail, mode: 'insensitive' }, status: 'ACTIVE' } },
    select: { userId: true, weeklyHours: true, timeZone: true, blockedTimes: true, dateOverrides: true },
  });
  if (!manager) return null;
  const ids = [organizerId, manager.userId];
  try {
    const calendars = await Promise.all(ids.map(async userId => {
      const token = await googleWorkspace().accessToken({ organizationId, userId }, 'booking');
      if (!token.ok) throw new Error('Calendar unavailable');
      return googleBusyPeriods(token.accessToken, ['primary'], window);
    }));
    return { manager, busy: calendars.flat(), hours: manager as unknown as EmployeeAvailability };
  } catch { return null; }
}
