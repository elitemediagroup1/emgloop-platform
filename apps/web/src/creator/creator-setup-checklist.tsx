import Link from 'next/link';
import { creatorDeclaredSocialHandles } from '@emgloop/shared';

type SetupProfile = {
  displayName: string;
  handle?: string | null;
  bio?: string | null;
  preferences?: unknown;
};

/** Presentation of existing profile facts only. A declared handle is not OAuth consent. */
export function CreatorSetupChecklist({ profile }: { profile: SetupProfile | null | undefined }) {
  const handles = creatorDeclaredSocialHandles(profile?.preferences);
  const profileReady = Boolean(profile?.displayName?.trim() && profile?.bio?.trim());
  const handlesReady = Boolean(profile?.handle?.trim() || Object.values(handles).some(Boolean));
  return (
    <section className="ch-setup-checklist" aria-label="Your creator setup">
      <header className="ch-section-head">
        <h2>Your creator setup</h2>
      </header>
      <p>
        Separate from campaign tasks. Complete your details, then review the connections you want to
        use.
      </p>
      <ul>
        <li>
          <span aria-hidden="true">{profileReady ? '✓' : '1'}</span>
          <div>
            <strong>Introduce yourself</strong>
            <small>
              {!profile
                ? 'Profile could not be checked'
                : profileReady
                  ? 'Name and bio saved'
                  : 'Add your name and bio'}
            </small>
          </div>
          <Link href="/app/creator/profile#creator-profile-form">
            {profileReady ? 'Review' : 'Set up'} profile →
          </Link>
        </li>
        <li>
          <span aria-hidden="true">{handlesReady ? '✓' : '2'}</span>
          <div>
            <strong>Add your social handles</strong>
            <small>
              {!profile
                ? 'Handles could not be checked'
                : handlesReady
                  ? 'A handle is saved · connections are managed separately'
                  : 'Help EMG identify your public accounts'}
            </small>
          </div>
          <Link href="/app/creator/profile?onboarding=1#creator-profile-form">
            Review handles →
          </Link>
        </li>
        <li>
          <span aria-hidden="true">3</span>
          <div>
            <strong>Review account connections</strong>
            <small>See each platform’s status before authorizing access</small>
          </div>
          <Link href="/app/creator/profile#social-connections">Review connections →</Link>
        </li>
      </ul>
      <details>
        <summary>Payments and shared documents</summary>
        <p>
          <Link href="/app/creator/earnings">Review payout setup →</Link>
        </p>
        <p>
          <Link href="/app/creator/profile#creator-documents">View agreements and briefs →</Link>
        </p>
        <p className="loop-note">
          These links open your existing settings. No account is connected and no payout is
          requested from this checklist.
        </p>
      </details>
    </section>
  );
}
