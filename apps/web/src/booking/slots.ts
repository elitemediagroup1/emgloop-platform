import { zonedParts, zonedWallTimeToUtc } from '@emgloop/shared';
import { employeeWorkingHours, isAvailable, type BusyPeriod, type EmployeeAvailability } from './availability';

const minute = 60_000;

interface SlotRequest {
  availability: EmployeeAvailability;
  hostDate: string;
  now: number;
  durationMinutes: number;
  incrementMinutes: number;
  noticeMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  calendarBusy: readonly BusyPeriod[];
}

export function bookingSlots(input: SlotRequest): BusyPeriod[] {
  const { availability, hostDate, durationMinutes, incrementMinutes } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(hostDate) ||
      !Number.isInteger(durationMinutes) || durationMinutes < 1 ||
      !Number.isInteger(incrementMinutes) || incrementMinutes < 1 ||
      ![input.noticeMinutes, input.bufferBeforeMinutes, input.bufferAfterMinutes].every(
        (value) => Number.isInteger(value) && value >= 0,
      )) return [];

  const date = new Date(`${hostDate}T00:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== hostDate) return [];
  const hours = employeeWorkingHours(availability, hostDate, date.getUTCDay());
  const instantAt = (minutes: number) => {
    const instant = zonedWallTimeToUtc(
      availability.timeZone, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
      Math.floor(minutes / 60), minutes % 60,
    );
    const wall = zonedParts(instant, availability.timeZone);
    // Skip wall times that don't exist on spring-forward days.
    if (wall.hour * 60 + wall.minute !== minutes % 1440) return null;
    return instant.valueOf();
  };
  const slots = new Map<number, BusyPeriod>();
  for (const interval of hours) {
    const start = instantAt(interval.startMinute);
    const end = instantAt(interval.endMinute);
    if (start === null || end === null) continue;
    for (let offset = interval.startMinute; offset + durationMinutes <= interval.endMinute; offset += incrementMinutes) {
      const candidate = instantAt(offset);
      if (candidate === null || candidate < input.now + input.noticeMinutes * minute) continue;
      const slot = { start: candidate, end: candidate + durationMinutes * minute };
      if (!isAvailable(slot, [{ start, end }], [], [])) continue;
      const occupied = {
        start: slot.start - input.bufferBeforeMinutes * minute,
        end: slot.end + input.bufferAfterMinutes * minute,
      };
      if (!isAvailable(occupied, [{ start: -Infinity, end: Infinity }], availability.blockedTimes, input.calendarBusy)) continue;
      slots.set(slot.start, slot);
    }
  }
  return [...slots.values()].sort((a, b) => a.start - b.start);
}
