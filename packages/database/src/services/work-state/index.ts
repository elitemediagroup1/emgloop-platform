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
  employeeGoogleAccessPort,
  employeeGoogleWorkspace,
  googleCalendarSensor,
  type EmployeeCalendarSyncConfig,
} from './calendar-sync-runtime';

// Gmail ingestion (GM-1): one employee's mailbox metadata into their own work state. Bodies
// are never persisted -- the sensor's sync read does not ask for them.
export {
  GmailSyncService,
  GMAIL_INITIAL_DAYS,
  type GmailAccessPort,
  type GmailSensorPort,
  type GmailSyncDeps,
  type GmailSyncMode,
  type GmailSyncOptions,
  type GmailSyncOutcome,
} from './gmail-sync.service';

// The Gmail sync as a runtime assembles it (GM-1): one assembly for the visit refresh, the
// manual refresh and the scheduled cycle, plus the two on-demand reads that are never stored.
export {
  createEmployeeGmailSync,
  googleGmailSensor,
  gmailAccessPort,
  readEmployeeGmailThread,
  sendEmployeeGmailMessage,
  employeeGmailIdentity,
  type EmployeeGmailConfig,
} from './gmail-sync-runtime';
