import Link from 'next/link';
import { logoutAction } from '../auth/actions';
import { SidebarIcon } from '../app/crm/_brand/SidebarIcon';
import { LOOP_NAV, type NavGroup } from './config';
import { ShellNav } from './ShellNav';

function initials(name: string) {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'EM'
  );
}

/** Creator-only chrome. Navigation authority and all account actions stay with the shared shell. */
export function CreatorHeader({
  name,
  roleLabel,
  groups,
  workHref,
}: {
  name: string;
  roleLabel: string;
  groups: readonly NavGroup[];
  workHref: string | null;
}) {
  return (
    <header className="ch-topbar">
      <Link
        href={LOOP_NAV.home}
        className="ch-topbar__brand"
        aria-label="EMG Talent Group and EMG Loop Home"
      >
        <img
          className="ch-talent-logo"
          src="/brand/emg-talent-original.png"
          alt="EMG Talent Group"
          width={120}
          height={80}
        />
        <span className="ch-brand-divider" aria-hidden="true" />
        <img
          className="ch-loop-logo"
          src="/brand/emg-loop-original.png"
          alt="EMG Loop"
          width={188}
          height={36}
        />
      </Link>
      <details className="ch-mobile-menu">
        <summary>Menu</summary>
        <ShellNav groups={groups} label={LOOP_NAV.label} />
      </details>
      <div className="ch-desktop-nav">
        <ShellNav groups={groups} label={LOOP_NAV.label} />
      </div>
      <div className="ch-topbar__account">
        {workHref ? (
          <Link className="loop-iconbtn" href={workHref} aria-label="View work notifications">
            <SidebarIcon name="bell" />
          </Link>
        ) : null}
        <details className="ch-account-menu">
          <summary aria-label="Your account">
            <span className="ch-account-avatar">{initials(name)}</span>
            <span className="ch-account-label">Account ▾</span>
          </summary>
          <div>
            <strong>{name}</strong>
            <span>{roleLabel}</span>
            <Link href="/app/creator/profile">Manage profile</Link>
            <Link href="/app/creator/tasks#team">Message EMG</Link>
            <Link href="/app/creator/profile#creator-documents">Agreements and briefs</Link>
            <form action={logoutAction}>
              <button type="submit" className="loop-btn">
                Sign out
              </button>
            </form>
          </div>
        </details>
      </div>
    </header>
  );
}
