/**
 * CRM Login — Loop front door.
 * Presentation layer only. Authentication, sessions, and routing are unchanged.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loginAction } from '../../../auth/actions';
import { getSession } from '../../../auth/auth';
import { ensureCrmIdentity } from '../../../auth/bootstrap';
import { EmgLoopWordmark } from '../_brand/Logos';

export const dynamic = 'force-dynamic';




export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; reset?: string; next?: string };
}) {
  await ensureCrmIdentity();
  const session = await getSession();
  if (session) redirect('/crm');

  return (
    <div className="loop-auth">
      {/* Left — marketing / brand */}
      <aside className="loop-auth__brand">
        <div className="loop-auth__brand-top">
          <EmgLoopWordmark height={30} />
        </div>
        <div className="loop-auth__brand-body">
          <h2 className="loop-auth__headline">
            Run your business.
            <br />
            Keep your team moving.
          </h2>
          <p className="loop-auth__lede">
            Loop brings together CRM, work management, automation, AI employees,
            customer activity, and reporting into one operating system.
          </p>
          <p className="loop-auth__mission">
            Everything your team needs to manage customers, work, automation, and
            AI from one workspace.
          </p>
        </div>
      </aside>

      {/* Right — authentication */}
      <main className="loop-auth__panel">
        <div className="loop-auth__panel-inner">
          <div className="loop-auth__mobile-brand">
            <EmgLoopWordmark height={26} />
          </div>

          <section className="loop-auth__card" aria-labelledby="loop-signin-title">
            <h1 className="loop-auth__title">Sign in</h1>
            <p className="loop-auth__sub">Access your Loop workspace.</p>

            {searchParams.error ? (
              <div className="crm-auth-error" role="alert">{searchParams.error}</div>
            ) : null}
            {searchParams.reset ? (
              <div className="crm-auth-ok" role="status">Password updated. Sign in with your new password.</div>
            ) : null}

            <form action={loginAction}>
              <label className="crm-field">
                <span>Email</span>
                <input className="crm-input" type="email" name="email" autoComplete="email" required />
              </label>
              <label className="crm-field">
                <span>Password</span>
                <input className="crm-input" type="password" name="password" autoComplete="current-password" required />
              </label>
              <label className="crm-checkrow">
                <input type="checkbox" name="remember" value="1" /> Remember me for 30 days
              </label>
              <button className="crm-btn-primary" type="submit">Sign in</button>
            </form>

            <div className="loop-auth__links">
              <Link href="/crm/forgot-password">Forgot password?</Link>
            </div>
          </section>

          <section className="loop-auth__needaccess">
            <div className="loop-auth__divider" role="presentation" />
            <h2 className="loop-auth__needaccess-title">Need access?</h2>
            <p className="loop-auth__needaccess-sub">
              Employees receive an invitation from their administrator.
            </p>
            <Link className="loop-auth__invite-btn" href="/crm/accept-invite">
              Accept Invitation
            </Link>
          </section>
        </div>
      </main>
    </div>
  );
}
