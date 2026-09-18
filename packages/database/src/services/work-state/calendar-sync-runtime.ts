// One employee's Calendar sync, assembled. ONE assembly, for every runtime that performs it.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §8.2, §13 (DL-3, DL-5).
//
// WHERE THE PIECES MEET, AND NOWHERE ELSE: the employee's own Google connection (through the ONE
// token path, `GoogleWorkspaceService.accessToken`), the DL-2 sensor, and the DL-1 store. It
// builds no request, holds no credential and opens no second Google path.
//
// TWO RUNTIMES, ONE ASSEMBLY. A person opening Loop syncs through the Next.js server; the
// scheduled cycle (DL-5) syncs the same way for employees who are not looking. Assembling this
// twice would mean two definitions of "read my calendar", and the one nobody watches would drift.
//
// THE PRINCIPAL IS STILL THE WHOLE AUTHORIZATION. Nothing here widens it: the token is fetched
// for the principal the caller passes, `authorize` is that principal's own IAM decision, and the
// rows are written for that principal. A runtime with no session -- the cycle -- therefore cannot
// read a calendar that IAM would not have given the employee themselves.

import { readGoogleCalendarChanges, readGoogleCalendarWindow } from '@emgloop/providers';
import type { GoogleSigningKeys } from '@emgloop/providers';
import type { GoogleWorkspaceCapability } from '@emgloop/shared';

import type { PrismaClient } from '@prisma/client';
import { GoogleConnectionRepository } from '../../repositories/google-connection.repository';
import { IamRepository } from '../../repositories/iam.repository';
import { WorkGraphRepository } from '../../repositories/work-state/work-graph.repository';
import { WorkSourceRepository } from '../../repositories/work-state/work-source.repository';
import type { WorkPrincipal } from '../../repositories/work-state/work-principal';
import { GoogleTokenSealer } from '../google/google-token-sealer';
import { createGoogleOAuthPort, googleFetch, type GoogleClientConfig, type GoogleFetch } from '../google/google-oauth-port';
import { GoogleWorkspaceService } from '../google/google-workspace.service';
import { CalendarSyncService, type CalendarAccessPort, type CalendarSensorPort } from './calendar-sync.service';

export interface EmployeeCalendarSyncConfig {
  readonly prisma: PrismaClient;
  /**
   * A validated Google client configuration, plus the key that seals refresh tokens at rest --
   * or null when this deployment has no Google client, which every token read then refuses as
   * NOT_CONFIGURED, before a connection is opened.
   */
  readonly google: (GoogleClientConfig & { readonly tokenKey: Uint8Array }) | null;
  readonly fetchImpl?: GoogleFetch;
  /** Shared by a long-lived server so Google's cache headers decide when keys are fetched again. */
  readonly signingKeys?: GoogleSigningKeys;
  readonly now?: () => Date;
}

/** The DL-2 adapter, with the network bound and nothing else added. */
export function googleCalendarSensor(fetchImpl: GoogleFetch = googleFetch): CalendarSensorPort {
  return {
    readWindow: (request) => readGoogleCalendarWindow({ fetchImpl, ...request }),
    readChanges: (request) => readGoogleCalendarChanges({ fetchImpl, ...request }),
  };
}

/**
 * The connection, as ingestion needs it: a token for this person's own grant, and the two facts
 * that make attendance countable.
 *
 * `internalDomains` is deterministic and narrow -- the Workspace domain the connected account
 * belongs to, plus any domain the organization configured. With neither, external attendance is
 * reported UNKNOWN rather than guessed.
 */
export function employeeGoogleAccessPort(
  prisma: PrismaClient,
  google: GoogleWorkspaceService,
  capability: GoogleWorkspaceCapability,
): CalendarAccessPort {
  const connections = new GoogleConnectionRepository(prisma);
  return {
    accessToken: async (principal: WorkPrincipal) => {
      const result = await google.accessToken(principal, capability);
      return result.ok ? { ok: true, accessToken: result.accessToken } : { ok: false, state: result.state };
    },
    identity: async (principal: WorkPrincipal) => {
      const connection = await connections.find(principal.organizationId, principal.userId);
      const configured = await connections.allowedHostedDomains(principal.organizationId);
      const hosted = connection?.hostedDomain ? [connection.hostedDomain.toLowerCase()] : [];
      return {
        selfAddress: connection?.emailAtLink ?? null,
        internalDomains: [...new Set([...hosted, ...configured])],
      };
    },
  };
}

/**
 * The Google Workspace service as a calendar read needs it: this deployment's client, and each
 * principal's OWN IAM decision. The authorization is never the caller's -- there is no caller.
 */
export function employeeGoogleWorkspace(config: EmployeeCalendarSyncConfig): GoogleWorkspaceService {
  const iam = new IamRepository(config.prisma);
  const google = config.google;
  return new GoogleWorkspaceService(config.prisma, {
    configured: google
      ? {
          oauth: createGoogleOAuthPort(google, { fetchImpl: config.fetchImpl, signingKeys: config.signingKeys }),
          sealer: new GoogleTokenSealer(google.tokenKey),
        }
      : null,
    authorize: (principal, action) =>
      iam.can({ organizationId: principal.organizationId, userId: principal.userId, resource: 'googleWorkspace', action }),
  });
}

/** The sync service, wired for one deployment. Each call still names the employee it is for. */
export function createEmployeeCalendarSync(config: EmployeeCalendarSyncConfig): CalendarSyncService {
  return new CalendarSyncService({
    sources: new WorkSourceRepository(config.prisma),
    graph: new WorkGraphRepository(config.prisma),
    access: employeeGoogleAccessPort(config.prisma, employeeGoogleWorkspace(config), 'calendar'),
    sensor: googleCalendarSensor(config.fetchImpl),
    ...(config.now ? { now: config.now } : {}),
  });
}

/**
 * The names these had while Calendar was the only surface using them. Kept so a reader of DL-3
 * or DL-5 finds what those records describe; both are now capability-agnostic, because Gmail
 * reads a token through exactly the same path.
 */
export const calendarAccessPort = (prisma: PrismaClient, google: GoogleWorkspaceService): CalendarAccessPort =>
  employeeGoogleAccessPort(prisma, google, 'calendar');
export const calendarGoogleWorkspace = employeeGoogleWorkspace;
