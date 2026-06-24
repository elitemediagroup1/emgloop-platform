// @emgloop/database
//
// Single source of the Prisma client for the whole platform.
// A singleton avoids exhausting Postgres connections in dev / serverless.

import { PrismaClient } from '@prisma/client';
import { createRepositories, type Repositories } from './repositories';

declare global {
  // eslint-disable-next-line no-var
  var __emgloopPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__emgloopPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.__emgloopPrisma = prisma;
}

// Repository layer (Sprint 4 — Real Data Layer). The whole platform persists
// through these classes, never via the Prisma client directly. A shared bundle
// bound to the singleton client is exported for convenience.
export * from './repositories';

export const repositories: Repositories = createRepositories(prisma);

export * from '@prisma/client';
export default prisma;
