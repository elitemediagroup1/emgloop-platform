// The worker's HELD-refresh retention step against a REAL Postgres (local only). Before the refresh
// queue's migration it is a no-op -- not a failure; after it, it purges through the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { IntelligenceRefreshQueueRepository, forgetIntelligenceFabricPresence } from '@emgloop/database';

import { runHeldRefreshRetention } from '../src/refresh-retention';

const LOCAL = (url: string) => /^postgres(ql)?:\/\/[^@]*@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url);
const PRE_URL = process.env.LOOP_TEST_PRE_FABRIC_POSTGRES_URL ?? '';
const skipPre = !PRE_URL ? 'LOOP_TEST_PRE_FABRIC_POSTGRES_URL is not set' : !LOCAL(PRE_URL) ? 'refusing a non-local database' : false;

test('PRE-MIGRATION: the retention step is a no-op, not a worker failure', { skip: skipPre }, async () => {
  const prisma = new PrismaClient({ datasources: { db: { url: PRE_URL } } });
  forgetIntelligenceFabricPresence();
  try {
    const logs: string[] = [];
    const queue = new IntelligenceRefreshQueueRepository(prisma);
    const out = await runHeldRefreshRetention({ purgeHeld: (cutoff) => queue.purgeHeld(cutoff), now: () => new Date(), log: (e) => void logs.push(e) });
    assert.deepEqual(out, { purged: 0 });
    assert.deepEqual(logs, [], 'no error, nothing to say');
  } finally {
    await prisma.$disconnect();
  }
});
