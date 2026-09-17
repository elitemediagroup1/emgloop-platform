// Calendar ingestion, assembled for a web request. SERVER ONLY.
//
// Architecture: daily-loop-employee-intelligence.md §13 (DL-3).
//
// WHERE THE PIECES MEET, AND NOWHERE ELSE. The employee's Google connection (through the ONE
// existing path, `GoogleWorkspaceService.accessToken`), the DL-2 sensor, and the DL-1 store.
// This module builds no request, holds no credential and opens no second Google path.
//
// THE PRINCIPAL IS THE WHOLE AUTHORIZATION. Every function takes the organization and the user
// the caller resolved from the signed session, and hands that same pair to the token path and
// to the store -- so the Google account read and the work state written belong to one person,
// and no role can point either at somebody else.

import 'server-only';

import {
  CalendarSyncService,
  GoogleConnectionRepository,
  WorkGraphRepository,
  WorkSourceRepository,
  prisma,
  type CalendarAccessPort,
  type CalendarSensorPort,
  type CalendarSyncOutcome,
  type WorkPrincipal,
} from '@emgloop/database';
import { readGoogleCalendarChanges, readGoogleCalendarWindow } from '@emgloop/providers';

import { googleWorkspace } from '../google/google-runtime';

const fetchImpl = (input: string, init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal }) =>
  fetch(input, { ...init, cache: 'no-store', redirect: 'error' });

/** The DL-2 adapter, with the network bound and nothing else added. */
const sensor: CalendarSensorPort = {
  readWindow: (request) => readGoogleCalendarWindow({ fetchImpl, ...request }),
  readChanges: (request) => readGoogleCalendarChanges({ fetchImpl, ...request }),
};

/**
 * The connection, as ingestion needs it: a token for this person's own grant, and the two facts
 * that make attendance countable.
 *
 * `internalDomains` is deterministic and narrow -- the Workspace domain the connected account
 * belongs to, plus any domain the organization configured. With neither, external attendance is
 * reported UNKNOWN rather than guessed.
 */
const access: CalendarAccessPort = {
  accessToken: async (principal: WorkPrincipal) => {
    const result = await googleWorkspace().accessToken(principal, 'calendar');
    return result.ok ? { ok: true, accessToken: result.accessToken } : { ok: false, state: result.state };
  },
  identity: async (principal: WorkPrincipal) => {
    const connections = new GoogleConnectionRepository(prisma);
    const connection = await connections.find(principal.organizationId, principal.userId);
    const configured = await connections.allowedHostedDomains(principal.organizationId);
    const hosted = connection?.hostedDomain ? [connection.hostedDomain.toLowerCase()] : [];
    return {
      selfAddress: connection?.emailAtLink ?? null,
      internalDomains: [...new Set([...hosted, ...configured])],
    };
  },
};

/** Synchronize the calendar of the person the caller resolved from the session. Nobody else's. */
export function syncEmployeeCalendar(principal: WorkPrincipal): Promise<CalendarSyncOutcome> {
  const service = new CalendarSyncService({
    sources: new WorkSourceRepository(prisma),
    graph: new WorkGraphRepository(prisma),
    access,
    sensor,
  });
  return service.syncCalendar(principal);
}
