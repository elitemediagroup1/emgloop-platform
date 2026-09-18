// Daily Loop work-state services (DL-3).

export {
  CalendarSyncService,
  eventFactsFor,
  CALENDAR_LOOKBACK_DAYS,
  CALENDAR_LOOKAHEAD_DAYS,
  type CalendarAccessPort,
  type CalendarSensorPort,
  type CalendarSyncDeps,
  type CalendarSyncMode,
  type CalendarSyncOptions,
  type CalendarSyncOutcome,
  type CalendarConnectionState,
} from './calendar-sync.service';

// The assembly (DL-5): the same Calendar sync for the Next.js server and for the scheduled
// cycle, so "read my calendar" has one definition rather than one per runtime.
export {
  createEmployeeCalendarSync,
  calendarAccessPort,
  calendarGoogleWorkspace,
  googleCalendarSensor,
  type EmployeeCalendarSyncConfig,
} from './calendar-sync-runtime';
