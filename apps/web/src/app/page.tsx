import { redirect } from 'next/navigation';
import Link from 'next/link';
import { loopLoginAction } from '../workspaces/login-action';
import { getSession } from '../auth/auth';
import { ensureCrmIdentity, DEMO_OWNER_EMAIL, DEMO_DEFAULT_PASSWORD } from '../auth/bootstrap';
import { EmgLoopWordmark } from './crm/_brand/Logos';
import './crm/crm.css';
import './crm/sprint7.css';
import './crm/design-system.css';
import './loop-os.css';

export const dynamic = 'force-dynamic';

const READY = ['Brain', 'Marketplace', 'CRM', 'Creator Studio'];

export default async function LoopEntrance({
  searchParams,
}: {
  searchParams: { error?: string; next?: string };
}) {
  const session = await getSession();
  if (session) redirect('/app');
  await ensureCrmIdentity();

  const errorCode = searchParams?.error;
  const errorMessage =
    errorCode === 'invalid'
      ? 'Those credentials were not recognized. Please try again.'
      : errorCode
        ? 'Unable to sign in. Please try again.'
        : null;

  return (
    <div className="loop-os">
      <div className="loop-auth">
        <section className="loop-auth__stage">
          <svg className="loop-auth__net" viewBox="0 0 600 800" preserveAspectRatio="xMidYMid slice" aria-hidden>
            <path className="edge" d="M80 120 L300 240 L520 160" />
            <path className="edge" d="M300 240 L240 480 L470 560" />
            <path className="edge" d="M240 480 L90 620" />
            <path className="edge" d="M470 560 L520 160" />
            <circle className="node n1" cx="80" cy="120" r="5" />
            <circle className="node n2" cx="300" cy="240" r="6" />
            <circle className="node n3" cx="520" cy="160" r="5" />
            <circle className="node n4" cx="240" cy="480" r="6" />
            <circle className="node n5" cx="470" cy="560" r="5" />
            <circle className="node n2" cx="90" cy="620" r="4" />
          </svg>
          <div className="loop-auth__brandrow">
            <EmgLoopWordmark height={26} />
            <span className="loop-auth__osbadge">OS</span>
          </div>
          <div className="loop-auth__hero">
            <h1 className="loop-auth__headline">The Operating System for Modern Businesses</h1>
            <div className="loop-auth__verbs">
              <span className="loop-auth__verb">Monitor</span>
              <span className="loop-auth__verb">Understand</span>
              <span className="loop-auth__verb">Decide</span>
              <span className="loop-auth__verb">Execute</span>
            </div>
          </div>
          <div className="loop-auth__ready">
            <div className="loop-auth__ready-title">Initialized</div>
            {READY.map((name) => (
              <div className="loop-ready-item" key={name}>
                <span className="tick">✓</span>
                <span>{name} Ready</span>
              </div>
            ))}
          </div>
        </section>
        <section className="loop-auth__panel">
          <div className="loop-auth__card">
            <h2>Sign in to Loop</h2>
            <p className="sub">Where companies run their business.</p>
            {errorMessage ? <div className="loop-auth__error">{errorMessage}</div> : null}
            <form action={loopLoginAction}>
              <label className="loop-field">
                <span className="loop-field__label">Email</span>
                <input className="loop-input" type="email" name="email" autoComplete="username" placeholder="you@company.com" defaultValue={DEMO_OWNER_EMAIL} required />
              </label>
              <label className="loop-field">
                <span className="loop-field__label">Password</span>
                <input className="loop-input" type="password" name="password" autoComplete="current-password" placeholder="••••••••••" defaultValue={DEMO_DEFAULT_PASSWORD} required />
              </label>
              <div className="loop-authrow">
                <label className="loop-check">
                  <input type="checkbox" name="remember" defaultChecked />
                  <span>Remember me</span>
                </label>
                <Link className="loop-link" href="/app">Forgot password?</Link>
              </div>
              <button className="loop-btn" type="submit">Sign In</button>
            </form>
            <div className="loop-auth__foot">
              Need access? Contact your administrator.
              <div className="loop-auth__demo">Demo: <code>{DEMO_OWNER_EMAIL}</code></div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
