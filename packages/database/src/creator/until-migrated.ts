// A read that may run against a database the Creator Hub migration has not reached yet.
//
// WHY THIS EXISTS. Netlify deploys `main` to production on every merge, but a migration reaches
// production only when a human dispatches the migration workflow — so there is always a window in
// which the code knows tables the database does not have. Pages that existed before the Creator
// Hub (Work OS detail, the Person record) now read creator rows, and in that window those reads
// would throw and take a working page down with them. Wrapped here, a missing table or column
// (Prisma P2021 / P2022) reads as "absent", exactly as it would if nothing had been recorded, and
// every other error is still thrown. Use it ONLY on a read whose honest empty answer is null.

import { Prisma } from '@prisma/client';

const ABSENT_SCHEMA_CODES: ReadonlySet<string> = new Set(['P2021', 'P2022']);

export async function absentUntilMigrated<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && ABSENT_SCHEMA_CODES.has(error.code)) return null;
    throw error;
  }
}
