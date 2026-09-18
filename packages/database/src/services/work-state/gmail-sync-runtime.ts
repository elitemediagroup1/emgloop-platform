// One employee's Gmail sync, assembled. ONE assembly, for every runtime that performs it (GM-1).
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6 and §26.
//
// THREE RUNTIMES PERFORM THIS SYNC and they must perform the same one: the Next.js server when
// an employee opens Loop (visit refresh), the same server when they ask for it by hand, and the
// scheduled cycle when nobody is looking. Assembling it three times would be three definitions
// of "read my mail", and the one nobody watches would drift.
//
// THE PRINCIPAL IS THE WHOLE AUTHORIZATION. The token is fetched for the principal the caller
// passes, `authorize` is that principal's own IAM decision, and the rows are written for that
// principal. A runtime with no session -- the cycle -- therefore cannot read a mailbox that IAM
// would not have given the employee themselves.

import {
  googleAddressHash,
  readGoogleGmailChanges,
  readGoogleGmailThread,
  readGoogleGmailWindow,
  sendGoogleGmailMessage,
  type GmailCallOptions,
} from '@emgloop/providers';
import type { GmailSendResult, GmailThreadResult } from '@emgloop/shared';

import type { PrismaClient } from '@prisma/client';
import type { WorkPrincipal } from '../../repositories/work-state/work-principal';
import { WorkGraphRepository } from '../../repositories/work-state/work-graph.repository';
import { WorkSourceRepository } from '../../repositories/work-state/work-source.repository';
import { googleFetch, type GoogleFetch } from '../google/google-oauth-port';
import { employeeGoogleAccessPort, employeeGoogleWorkspace, type EmployeeCalendarSyncConfig } from './calendar-sync-runtime';
import { GmailSyncService, type GmailAccessPort, type GmailSensorPort } from './gmail-sync.service';

/** The same deployment configuration the Calendar assembly takes. One Google client, one key. */
export type EmployeeGmailConfig = EmployeeCalendarSyncConfig & { readonly initialDays?: number };

/** The GM-1 adapter, with the network bound and nothing else added. */
export function googleGmailSensor(fetchImpl: GoogleFetch = googleFetch): GmailSensorPort {
  return {
    readWindow: (request) => readGoogleGmailWindow({ fetchImpl, ...request }),
    readChanges: (request) => readGoogleGmailChanges({ fetchImpl, ...request }),
  };
}

/** The Gmail access port: this principal's own token, for the Gmail capability only. */
export function gmailAccessPort(config: EmployeeGmailConfig): GmailAccessPort {
  return employeeGoogleAccessPort(config.prisma, employeeGoogleWorkspace(config), 'gmail');
}

/** The sync service, wired for one deployment. Each call still names the employee it is for. */
export function createEmployeeGmailSync(config: EmployeeGmailConfig): GmailSyncService {
  return new GmailSyncService({
    sources: new WorkSourceRepository(config.prisma),
    graph: new WorkGraphRepository(config.prisma),
    access: gmailAccessPort(config),
    sensor: googleGmailSensor(config.fetchImpl),
    addressHash: googleAddressHash,
    ...(config.now ? { now: config.now } : {}),
    ...(config.initialDays !== undefined ? { initialDays: config.initialDays } : {}),
  });
}

/**
 * Read one conversation, with bodies, for the employee who asked for it.
 *
 * NOTHING HERE IS PERSISTED. The thread is read, handed to the caller that is rendering it or
 * assembling a governed AI context, and forgotten. The access check is the same token path as
 * the sync: no token, no thread, and no role can supply one for somebody else.
 */
export async function readEmployeeGmailThread(
  config: EmployeeGmailConfig,
  principal: WorkPrincipal,
  threadId: string,
): Promise<GmailThreadResult> {
  const access = gmailAccessPort(config);
  const token = await access.accessToken(principal);
  if (!token.ok) {
    const { gmailFailureForConnectionState } = await import('@emgloop/shared');
    return { ok: false, failure: gmailFailureForConnectionState(token.state) };
  }
  const identity = await access.identity(principal);
  const options: GmailCallOptions = {
    fetchImpl: config.fetchImpl ?? googleFetch,
    accessToken: token.accessToken,
    selfAddress: identity.selfAddress,
  };
  return readGoogleGmailThread({ ...options, threadId });
}

/**
 * Send one already-composed message as the employee who asked.
 *
 * IT COMPOSES NOTHING AND DECIDES NOTHING. The raw RFC 5322 message was built and checked by
 * the caller (@emgloop/shared `buildGmailReply`) from content that employee submitted. This
 * function's only job is to hand it to Gmail under that employee's own token -- which is also
 * why there is no path here that could send as anybody else.
 */
export async function sendEmployeeGmailMessage(
  config: EmployeeGmailConfig,
  principal: WorkPrincipal,
  message: { readonly rawMessage: string; readonly threadId: string | null },
): Promise<GmailSendResult> {
  const access = gmailAccessPort(config);
  const token = await access.accessToken(principal);
  if (!token.ok) {
    const { gmailFailureForConnectionState } = await import('@emgloop/shared');
    return { ok: false, failure: gmailFailureForConnectionState(token.state) };
  }
  return sendGoogleGmailMessage({
    fetchImpl: config.fetchImpl ?? googleFetch,
    accessToken: token.accessToken,
    rawMessage: message.rawMessage,
    threadId: message.threadId,
  });
}

/** The connected account's own address, which a composer needs to write `From`. */
export async function employeeGmailIdentity(config: EmployeeGmailConfig, principal: WorkPrincipal): Promise<{ readonly selfAddress: string | null }> {
  return gmailAccessPort(config).identity(principal);
}
