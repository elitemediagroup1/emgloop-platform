import { redirect } from 'next/navigation';
import { getSession } from '../auth/auth';

export const dynamic = 'force-dynamic';

/**
 * Root entry point for EMG Loop.
 *
 * There is a single public login surface at /crm/login. Unauthenticated
 * visitors to the root are sent there. Authenticated visitors continue to
 * /app, which resolves their correct workspace home via the existing
 * role router (unchanged).
 */
export default async function RootEntry() {
  const session = await getSession();
  redirect(session ? '/app' : '/crm/login');
}
