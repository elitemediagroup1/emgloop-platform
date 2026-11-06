import { redirect } from 'next/navigation';
import { getSession } from '../auth/auth';
import { LOOP_HOME, loginPathFor } from '../auth/landing';
import { ProductHome } from './_public/product-site';
import './loop-os.css';
import './_public/product-site.css';

export const metadata = {
  title: 'EMG Loop — Creator partnerships, connected',
  description: 'The creator workspace from Elite Media Group. Follow brand conversations, manage content reviews and stay connected with your team.',
};

export const dynamic = 'force-dynamic';

/**
 * Root entry point for EMG Loop.
 *
 * Signed in: Loop Home. Signed out: the public product website. A safe requested
 * destination survives in the sign-in link; the private application's guards stay unchanged.
 */
export default async function RootEntry({
  searchParams,
}: {
  searchParams?: { next?: string };
}) {
  const session = await getSession();
  if (session) redirect(LOOP_HOME);
  return <ProductHome signInHref={loginPathFor(searchParams?.next)} />;
}
