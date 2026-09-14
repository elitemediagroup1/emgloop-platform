import { redirect } from 'next/navigation';
import { getSession } from '../auth/auth';
import { LOOP_HOME, loginPathFor } from '../auth/landing';

export const dynamic = 'force-dynamic';

/**
 * Root entry point for EMG Loop.
 *
 * Signed in: Loop Home (/app). Signed out: the login screen, keeping a safe
 * requested destination so it survives sign-in.
 */
export default async function RootEntry({
  searchParams,
}: {
  searchParams?: { next?: string };
}) {
  const session = await getSession();
  redirect(session ? LOOP_HOME : loginPathFor(searchParams?.next));
}
