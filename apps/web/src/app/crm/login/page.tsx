// CRM Login — Sprint 7 (Identity, Authentication & Organizations).
// Sprint 17: Authentication Experience Redesign (UX only). Split-screen
// front-door presentation for the Loop ecosystem (Businesses, Employees,
// Creators). Auth logic, action, session and redirect below are UNCHANGED
// from Sprint 13 — only layout, copy, and onboarding choices were redesigned.
//
// Sprint 17.1 (launch safety): Business & Creator are shown as non-interactive
// "Coming soon" cards (no links, no routes). Only the Employee card is
// actionable and links to the real invitation acceptance page.
//
// Email/password sign-in for the operations console. On submit, the
// loginAction verifies the password (scrypt) and sets the session cookie.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loginAction } from '../../../auth/actions';
import { getSession } from '../../../auth/auth';
import { ensureCrmIdentity } from '../../../auth/bootstrap';
import { EmgLoopWordmark, EliteMediaGroupMark } from '../_brand/Logos';

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
            <br />Keep your team moving.
          </h2>
          <p className="loop-auth__lede">
            CRM, work management, automation, and intelligence&mdash;all
            connected in Loop.
          </p>
          <p className="loop-auth__statement">
            Understand what is happening. Assign what comes next. Keep every
            workflow moving.
          </p>
        </div>
        <div className="loop-auth__brand-foot">
          <EliteMediaGroupMark height={16} />
        </div>
      </aside>

      {/* Right — authentication */}
      <main className="loop-auth__panel">
        <div className="loop-auth__panel-inner">
          <div className="loop-auth__mobile-brand">
            <EmgLoopWordmark height={26} />
          </div>

          <section className="loop-auth__card" aria-labelledby="loop-signin-title">
            <h1 id="loop-signin-title" className="loop-auth__title">Sign in</h1>
            <p className="loop-auth__sub">Welcome back to your Loop workspace.</p>

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

          <section className="loop-auth__onboard" aria-labelledby="loop-onboard-title">
            <div className="loop-auth__onboard-head">
              <h2 id="loop-onboard-title" className="loop-auth__onboard-title">New to Loop?</h2>
              <p className="loop-auth__onboard-sub">Choose the access that fits you.</p>
            </div>
            <ul className="loop-auth__access" role="list">
              <li className="loop-auth__row loop-auth__row--soon" aria-disabled="true">
                <div className="loop-auth__row-main">
                  <span className="loop-auth__row-title">Business workspace</span>
                  <span className="loop-auth__row-desc">Create and operate your company in Loop.</span>
                </div>
                <span className="loop-auth__row-badge">Coming soon</span>
              </li>
              <li className="loop-auth__row loop-auth__row--soon" aria-disabled="true">
                <div className="loop-auth__row-main">
                  <span className="loop-auth__row-title">Creator workspace</span>
                  <span className="loop-auth__row-desc">Manage your profile, collaborations, and opportunities.</span>
                </div>
                <span className="loop-auth__row-badge">Coming soon</span>
              </li>
              <li className="loop-auth__row loop-auth__row--action">
                <Link href="/crm/accept-invite" className="loop-auth__row-link">
                  <span className="loop-auth__row-main">
                    <span className="loop-auth__row-title">Employee access</span>
                    <span className="loop-auth__row-desc">Joining an existing company? Use the invitation your administrator sent.</span>
                  </span>
                  <span className="loop-auth__row-cta" aria-hidden="true">&rarr;</span>
                  <span className="loop-auth__row-action-label">Accept invitation</span>
                </Link>
              </li>
            </ul>
          </section>
        </div>
      </main>
    </div>
  );
}
