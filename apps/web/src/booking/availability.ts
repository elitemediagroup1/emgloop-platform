export interface WorkingHours {
  startMinute: number;
  endMinute: number;
}

export interface BusyPeriod {
  start: number;
  end: number;
}

export interface EmployeeAvailability {
  timeZone: string;
  weeklyHours: Partial<Record<number, readonly WorkingHours[]>>;
  dateOverrides: Readonly<Record<string, readonly WorkingHours[]>>;
  blockedTimes: readonly BusyPeriod[];
}

// The caller calculates the date and weekday in the employee's time zone.
// An empty override closes the entire date. An omitted override uses weekly hours.
export function employeeWorkingHours(
  availability: EmployeeAvailability,
  localDate: string,
  weekday: number,
): readonly WorkingHours[] {
  return availability.dateOverrides[localDate] ?? availability.weeklyHours[weekday] ?? [];
}

// All intervals here are absolute instants. Resolve working hours using the
// employee's zone before calling this, including on daylight-saving transitions.
export function isAvailable(
  slot: BusyPeriod,
  workingHours: readonly BusyPeriod[],
  blockedTimes: readonly BusyPeriod[],
  calendarBusyTimes: readonly BusyPeriod[],
): boolean {
  if (!Number.isFinite(slot.start) || !Number.isFinite(slot.end) || slot.start >= slot.end) {
    return false;
  }
  return (
    workingHours.some((hours) => hours.start <= slot.start && slot.end <= hours.end) &&
    ![...blockedTimes, ...calendarBusyTimes].some(
      (busy) => slot.start < busy.end && busy.start < slot.end,
    )
  );
}
