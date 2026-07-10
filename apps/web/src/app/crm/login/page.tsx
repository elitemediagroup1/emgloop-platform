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

const CAPABILITIES = [
  'CRM',
  'Work OS',
  'AI Employees',
  'Marketplace',
  'Automation',
  'Intelligence',
];

type Onboard = {
  icon: string;
  key: string;
  title: string;
  desc: string;
  cta: string;
  href?: string;
  available: boolean;
  note?: string;
};

const ONBOARDING: Onboard[] = [
  {
    icon: '🏢',
    key: 'business',
    title: 'Business',
    desc: 'Run your company with CRM, Work OS, AI Employees, automation, and customer management.',
    cta: 'Start a Business Workspace',
    available: false,
  },
  {
    icon: '🎨',
    key: 'creator',
    title: 'Creator',
    desc: 'Build your creator profile, publish work, collaborate with brands, and grow your audience.',
    cta: 'Join as a Creator',
    available: false,
  },
  {
    icon: '👥',
    key: 'employee',
    title: 'Employee',
    desc: "Joining an existing company? Use the invitation your administrator sent you.",
    cta: 'Accept Invitation',
    href: '/crm/accept-invite',
    available: true,
    note: 'Invitation-based access',
  },
];

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
            One Operating System.
            <br />Every Business.
            <br />Every Employee.
            <br />Every Creator.
          </h2>
          <p className="loop-auth__lede">
            The front door to the entire Loop ecosystem — where businesses,
            employees, creators, and AI work together.
          </p>
          <ul className="loop-auth__caps" aria-label="Loop platform capabilities">
            {CAPABILITIES.map((c) => (
              <li key={c} className="loop-auth__cap">{c}</li>
            ))}
          </ul>
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
              <Link href="/dashboard">Back to dashboard</Link>
            </div>
          </section>

          <section className="loop-auth__onboard" aria-labelledby="loop-onboard-title">
            <div className="loop-auth__onboard-head">
              <h2 id="loop-onboard-title" className="loop-auth__onboard-title">New to Loop?</h2>
              <p className="loop-auth__onboard-sub">Choose how you'll use Loop.</p>
            </div>
            <div className="loop-auth__cards">
              {ONBOARDING.map((o) =>
                o.available && o.href ? (
                  <Link
                    key={o.key}
                    href={o.href}
                    className="loop-auth__choice"
                    aria-label={o.cta}
                  >
                    <span className="loop-auth__choice-icon" aria-hidden="true">{o.icon}</span>
                    <span className="loop-auth__choice-title">{o.title}</span>
                    <span className="loop-auth__choice-desc">{o.desc}</span>
                    {o.note ? <span className="loop-auth__choice-note">{o.note}</span> : null}
                    <span className="loop-auth__choice-cta">{o.cta}</span>
                  </Link>
                ) : (
                  <div
                    key={o.key}
                    className="loop-auth__choice loop-auth__choice--soon"
                    aria-disabled="true"
                  >
                    <span className="loop-auth__choice-badge">Coming soon</span>
                    <span className="loop-auth__choice-icon" aria-hidden="true">{o.icon}</span>
                    <span className="loop-auth__choice-title">{o.title}</span>
                    <span className="loop-auth__choice-desc">{o.desc}</span>
                    <span className="loop-auth__choice-cta loop-auth__choice-cta--muted">{o.cta}</span>
                  </div>
                )
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
