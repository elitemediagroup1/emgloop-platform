// @emgloop/database
//
// Single source of the Prisma client for the whole platform.
// A singleton avoids exhausting Postgres connections in dev / serverless.

import { PrismaClient } from '@prisma/client';

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

export * from '@prisma/client';
export default prisma;
