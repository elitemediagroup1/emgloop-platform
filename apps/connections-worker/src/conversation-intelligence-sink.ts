// The conversation-intelligence sink (Chats Intelligence, 2026-09-25): where the content sweeps store one
// conversation's minimized reading as the person's private CHATS digest.
//
// THE PRINCIPAL IS THE AUTHORIZATION'S. The sweep passes the (organization, user) of the content
// authorization it is working for; nothing here widens or replaces it, and the repository's own scope
// makes any other principal's row unwritable from this call.
//
// CONSENT IS RE-CHECKED IN THE WRITE. IntelligenceDigestRepository.upsert (basis CONTENT_AUTHORIZATION)
// re-checks the Telegram content authorization and the membership INSIDE its write transaction, and
// refuses -- writing nothing -- when either has ended since the sweep began. A refusal is returned (and
// counted for a per-sweep log line of counts by refusal kind: never an id, never content).
//
// A DATABASE FAILURE IS THROWN, so the sweep holds its frontier (sink before cursor). The one exception
// is a MISSING TABLE (Prisma P2021 / P2022: the worker deployed ahead of the intelligence_digests
// migration): that is NOT_MIGRATED, logged as a count, and never holds -- holding would re-run the same
// AI calls every cycle for a write that cannot succeed until a human dispatches the migration.

import type { IntelligenceDigestInput, IntelligenceDigestRepository, WorkPrincipal } from '@emgloop/database';

import type { ConversationIntelligenceWrite } from './content-orchestrator';

const ABSENT_SCHEMA_CODES: ReadonlySet<string> = new Set(['P2021', 'P2022']);

export interface ConversationIntelligenceRecorder {
  record(principal: WorkPrincipal, digest: IntelligenceDigestInput): Promise<ConversationIntelligenceWrite>;
  /** Log this sweep's refusal counts (if any) and reset them. */
  flush(): void;
}

export function createConversationIntelligenceRecorder(
  digests: Pick<IntelligenceDigestRepository, 'upsert'>,
  sweep: 'content' | 'historical_content' | 'chats_hydration',
  log: (event: string, fields: Record<string, unknown>) => void,
): ConversationIntelligenceRecorder {
  const refusals = new Map<string, number>();
  const note = (kind: string) => refusals.set(kind, (refusals.get(kind) ?? 0) + 1);
  return {
    async record(principal, digest) {
      try {
        const outcome = await digests.upsert(principal, digest);
        if (outcome.outcome === 'REFUSED') {
          note(outcome.refusal);
          return { outcome: 'REFUSED', refusal: outcome.refusal };
        }
        return { outcome: outcome.outcome };
      } catch (err) {
        const code = (err as { code?: unknown })?.code;
        if (typeof code === 'string' && ABSENT_SCHEMA_CODES.has(code)) {
          note('NOT_MIGRATED');
          return { outcome: 'NOT_MIGRATED' };
        }
        throw err;
      }
    },
    flush() {
      if (refusals.size > 0) log('digest_refused', { sweep, ...Object.fromEntries(refusals) });
      refusals.clear();
    },
  };
}
