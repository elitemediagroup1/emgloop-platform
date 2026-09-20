// Read-only acceptance verification for background-source observations (Teams, Telegram, ...).
//
// SAFE BY CONSTRUCTION. Every query here is an AGGREGATE (COUNT/FILTER) or a schema-metadata read;
// none selects a raw value. The report it returns holds ONLY numbers, booleans, a provider label and
// fixed criterion/detail wording -- there is NO field that can carry a raw id, a keyed hash, a
// timestamp value, or message content. It performs NO writes: it never mutates an observation, a
// connection, a cursor or a session. It is provider-neutral at this layer; a caller scopes it to one
// provider (the first acceptance run is Telegram).

import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { CONNECTION_PROVIDERS, type ConnectionProvider } from '@emgloop/shared';

export interface ObservationAcceptanceResult {
  readonly criterion: string;
  readonly pass: boolean;
  /** SAFE detail: counts and fixed words only -- never an id, hash, timestamp value, or content. */
  readonly detail: string;
}

export interface ObservationVerificationCounts {
  readonly observations: number;
  readonly distinctOwners: number;
  readonly orphanOwners: number;
  readonly inbound: number;
  readonly outbound: number;
  readonly otherDirection: number;
  readonly withConversationKey: number;
  readonly withOccurredAt: number;
  readonly withObservedAt: number;
  readonly hadTextTrue: number;
  readonly hadTextFalse: number;
  readonly contentColumns: number;
  readonly connectionsWithCursor: number;
}

export interface ObservationVerificationReport {
  readonly provider: ConnectionProvider;
  readonly overall: 'PASS' | 'FAIL';
  readonly counts: ObservationVerificationCounts;
  readonly results: readonly ObservationAcceptanceResult[];
}

/** Column-name fragments that would indicate a content-bearing column. There must be none. */
const CONTENT_COLUMN_PATTERNS = ['message', 'text', 'body', 'subject', 'content', 'title', 'preview', 'caption', 'media', 'name'];

function n(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : Number(value ?? 0);
}

/**
 * Verify the persisted observations for ONE provider, read-only. Returns a redacted report: only
 * counts, booleans and the criterion wording. Never selects or returns a raw id, key, timestamp or
 * any content.
 */
export async function verifyObservations(prisma: PrismaClient, provider: ConnectionProvider): Promise<ObservationVerificationReport> {
  // One aggregate read over the observations of this provider. Every column here is a COUNT.
  const [agg] = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT
      COUNT(*)                                                              AS observations,
      COUNT(DISTINCT ("organizationId", "userId"))                          AS distinct_owners,
      COUNT(*) FILTER (WHERE direction = 'INBOUND')                          AS inbound,
      COUNT(*) FILTER (WHERE direction = 'OUTBOUND')                         AS outbound,
      COUNT(*) FILTER (WHERE direction NOT IN ('INBOUND','OUTBOUND'))        AS other_direction,
      COUNT(*) FILTER (WHERE "conversationKey" IS NOT NULL AND "conversationKey" <> '') AS with_conversation_key,
      COUNT(*) FILTER (WHERE "occurredAt" IS NOT NULL)                       AS with_occurred_at,
      COUNT(*) FILTER (WHERE "observedAt" IS NOT NULL)                       AS with_observed_at,
      COUNT(*) FILTER (WHERE "hadText" = true)                               AS had_text_true,
      COUNT(*) FILTER (WHERE "hadText" = false)                              AS had_text_false,
      COUNT(*) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM source_connections sc
        WHERE sc."organizationId" = o."organizationId" AND sc."userId" = o."userId" AND sc.provider = o.provider
      ))                                                                     AS orphan_owners
    FROM source_observations o
    WHERE o.provider = ${provider}
  `);

  // Structural: the observation table must have NO content-bearing column. Column NAMES only.
  const [cols] = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT COUNT(*) AS content_columns
    FROM information_schema.columns
    WHERE table_name = 'source_observations'
      -- A content-bearing column is a TEXTUAL/binary column with a content-shaped name. A boolean
      -- flag such as hadText is not content even though its name contains "text".
      AND data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'bytea')
      AND lower(column_name) ~ ${CONTENT_COLUMN_PATTERNS.join('|')}
  `);

  // Data-consistency for sink-before-cursor: this provider's connection has advanced a cursor.
  const [conn] = await prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT COUNT(*) AS connections_with_cursor
    FROM source_connections
    WHERE provider = ${provider} AND cursor IS NOT NULL AND cursor <> ''
  `);

  const counts: ObservationVerificationCounts = {
    observations: n(agg?.observations),
    distinctOwners: n(agg?.distinct_owners),
    orphanOwners: n(agg?.orphan_owners),
    inbound: n(agg?.inbound),
    outbound: n(agg?.outbound),
    otherDirection: n(agg?.other_direction),
    withConversationKey: n(agg?.with_conversation_key),
    withOccurredAt: n(agg?.with_occurred_at),
    withObservedAt: n(agg?.with_observed_at),
    hadTextTrue: n(agg?.had_text_true),
    hadTextFalse: n(agg?.had_text_false),
    contentColumns: n(cols?.content_columns),
    connectionsWithCursor: n(conn?.connections_with_cursor),
  };

  const total = counts.observations;
  const results: ObservationAcceptanceResult[] = [
    {
      criterion: 'A SourceObservation was persisted (worker observed activity)',
      pass: total >= 1,
      detail: `${total} observation(s) for provider ${provider}`,
    },
    {
      criterion: 'Provider is the one under test',
      pass: total >= 1, // the aggregate is scoped to this provider, so any row is this provider
      detail: `${total} observation(s), all scoped to provider ${provider}`,
    },
    {
      // INTEGRITY, not arity: every observation must belong to a real connected owner. distinctOwners
      // is reported for context (it is 1 on single-user staging) but does not gate, so the verifier
      // stays reusable when more than one employee is connected.
      criterion: 'Employee/org ownership is correct (every observation belongs to a real connected owner)',
      pass: total >= 1 && counts.orphanOwners === 0,
      detail: `${counts.distinctOwners} distinct owner(s), ${counts.orphanOwners} not matching a connection`,
    },
    {
      criterion: 'Conversation/participant identity remains keyed',
      pass: total >= 1 && counts.withConversationKey === total,
      detail: `${counts.withConversationKey}/${total} carry a keyed conversation identity`,
    },
    {
      criterion: 'Provenance, timestamp and direction are present',
      pass: total >= 1 && counts.withOccurredAt === total && counts.withObservedAt === total && counts.inbound + counts.outbound === total && counts.otherDirection === 0,
      detail: `${counts.withOccurredAt}/${total} occurredAt, ${counts.withObservedAt}/${total} observedAt, ${counts.inbound} inbound + ${counts.outbound} outbound`,
    },
    {
      criterion: 'Raw message text/content was NOT stored',
      pass: counts.contentColumns === 0,
      detail: `${counts.contentColumns} content-bearing column(s) on the observation store (hadText is a boolean flag, not text)`,
    },
    {
      criterion: 'Stored before the cursor advanced (sink-before-cursor)',
      pass: total >= 1 && counts.connectionsWithCursor >= 1,
      detail: `observations present and the ${provider} connection cursor is advanced (strict ordering is a code invariant, covered by the orchestrator test)`,
    },
  ];

  return { provider, overall: results.every((r) => r.pass) ? 'PASS' : 'FAIL', counts, results };
}

/** True if the value is a provider this verifier understands. */
export function isVerifiableProvider(v: unknown): v is ConnectionProvider {
  return typeof v === 'string' && (CONNECTION_PROVIDERS as readonly string[]).includes(v);
}
