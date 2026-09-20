// The worker's ObservationSink: land content-free observations in the governed store. Idempotent by
// construction (the repository skips duplicates on providerEventId), which is what lets the sweep's
// cursor stay behind the sink. No content, ever -- the repository fences each event.

import { SourceObservationRepository } from '@emgloop/database';
import type { PrismaClient } from '@prisma/client';
import type { ConversationEvent } from '@emgloop/shared';

import type { ObservationSink } from './orchestrator';
import type { DueConnection } from '@emgloop/database';

export function createDbObservationSink(prisma: PrismaClient): ObservationSink {
  const observations = new SourceObservationRepository(prisma);
  return {
    async accept(connection: DueConnection, events: readonly ConversationEvent[]): Promise<void> {
      await observations.append(connection.organizationId, connection.userId, connection.provider, events);
    },
  };
}
