// The send service, bound to this runtime. SERVER ONLY.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6.11a (GM-2).
//
// One assembly for the three places that touch an outbound attempt: the Send action, the "check
// Gmail again" and "it was not sent" actions, and the conversation page, which reconciles an
// attempt in doubt whenever the employee looks at it. That last one is the crash path: a process
// that died after Gmail accepted a message runs no failure handler, so the next view of the
// conversation is what settles it -- by looking in Sent mail, never by sending again.

import 'server-only';

import {
  MailSendService,
  WorkDraftRepository,
  WorkGraphRepository,
  employeeGmailIdentity,
  lookupEmployeeGmailSent,
  prisma,
  sendEmployeeGmailMessage,
} from '@emgloop/database';

import { readGoogleEnvironment } from '../google/google-environment';
import { googleSigningKeys } from '../google/google-runtime';

export function mailSendService(): MailSendService {
  const env = readGoogleEnvironment();
  const config = { prisma, google: env.state === 'CONFIGURED' ? env : null, signingKeys: googleSigningKeys() };
  return new MailSendService({
    drafts: new WorkDraftRepository(prisma),
    graph: new WorkGraphRepository(prisma),
    mail: {
      identity: (principal) => employeeGmailIdentity(config, principal),
      send: (principal, message) => sendEmployeeGmailMessage(config, principal, message),
      lookupSent: (principal, query) => lookupEmployeeGmailSent(config, principal, query),
    },
  });
}
