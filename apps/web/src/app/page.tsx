import { redirect } from 'next/navigation';
import Link from 'next/link';
import { loopLoginAction } from '../workspaces/login-action';
import { getSession } from '../auth/auth';
import { ensureCrmIdentity, DEMO_OWNER_EMAIL, DEMO_DEFAULT_PASSWORD } from '../auth/bootstrap';
import { EmgLoopWordmark, EliteMediaGroupMark } from './crm/_brand/Logos';
import './crm/crm.css';
import './crm/sprint7.css';
import './crm/design-system.css';

// Loop OS — Universal entrance (Phase 2, PR #47).
//
// The homepage of Loop IS the login page. There is no marketing homepage and no
// CRM homepage: one entrance. An already-authenticated visitor is routed to
// their workspace via /app (the role router). Everything below reuses the
// existing brand + auth surface; the credential handling lives in the shared
// auth core, never here.

export default async function LoopEntrance({
  searchParams,
}: {
  searchParams: { error?: string; next?: string };
}) {
  await ensureCrmIdentity();
  const session = await getSession();
  if (session) redirect('/app');

  return (
    <div className="crm-auth-wrap">
      <div className="crm-auth-card">
        <div style={{ marginBottom: '1rem' }}>
          <EmgLoopWordmark height={30} />
        </div>
        <h1>EMG Loop</h1>
        <p className="crm-auth-sub">Your business operating system</p>

        {searchParams.error ? (
          <div className="crm-auth-error">{searchParams.error}</div>
        ) : null}

        <form action={loopLoginAction}>
          <input type="hidden" name="next" value={searchParams.next ?? ''} />
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
          <button className="crm-btn-primary" type="submit">Sign In</button>
        </form>

        <div className="crm-auth-links">
          <Link href="/crm/forgot-password">Forgot password?</Link>
        </div>

        <div className="crm-auth-hint">
          Demo sign-in: <code>{DEMO_OWNER_EMAIL}</code> / <code>{DEMO_DEFAULT_PASSWORD}</code>
          <br />You will be routed to your workspace automatically.
        </div>

        <div style={{ marginTop: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: 0.7 }}>
          <EliteMediaGroupMark height={16} />
        </div>
      </div>
    </div>
  );
}
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { loopLoginAction } from '../workspaces/login-action';
import { getSession } from '../auth/auth';
import { ensureCrmIdentity, DEMO_OWNER_EMAIL, DEMO_DEFAULT_PASSWORD } from '../auth/bootstrap';
import { EmgLoopWordmark, EliteMediaGroupMark } from './crm/_brand/Logos';
import './crm/crm.css';
import './crm/sprint7.css';
import './crm/design-system.css';

// Loop OS — Universal entrance (Phase 2, PR #47).
//
// The homepage of Loop IS the login page. There is no marketing homepage and no
// CRM homepage: one entrance. An already-authenticated visitor is routed to
// their workspace via /app (the role router). Everything below reuses the
// existing brand + auth surface; the credential handling lives in the shared
// auth core, never here.

export default async function LoopEntrance({
  searchParams,
}: {
  searchParams: { error?: string; next?: string };
}) {
  await ensureCrmIdentity();
  const session = await getSession();
  if (session) redirect('/app');

  return (
    <div className="crm-auth-wrap">
      <div className="crm-auth-card">
        <div style={{ marginBottom: '1rem' }}>
          <EmgLoopWordmark height={30} />
        </div>
        <h1>EMG Loop</h1>
        <p className="crm-auth-sub">Your business operating system</p>

        {searchParams.error ? (
          <div className="crm-auth-error">{searchParams.error}</div>
        ) : null}

        <form action={loopLoginAction}>
          <input type="hidden" name="next" value={searchParams.next ?? ''} />
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
          <button className="crm-btn-primary" type="submit">Sign In</button>
        </form>

        <div className="crm-auth-links">
          <Link href="/crm/forgot-password">Forgot password?</Link>
        </div>

        <div className="crm-auth-hint">
          Demo sign-in: <code>{DEMO_OWNER_EMAIL}</code> / <code>{DEMO_DEFAULT_PASSWORD}</code>
          <br />You will be routed to your workspace automatically.
        </div>

        <div style={{ marginTop: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: 0.7 }}>
          <EliteMediaGroupMark height={16} />
        </div>
      </div>
    </div>
  );
}
