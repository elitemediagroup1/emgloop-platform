import type { Metadata } from 'next';

import { LEGAL_CONTACT_EMAIL, LEGAL_PATHS, LegalPage } from '../../_legal/legal-document';

// Privacy Policy for EMG Loop, at /privacy. PUBLIC and STATIC: no session, no data, no
// environment. Every statement about a connected TikTok account describes what the code in this
// repository does (packages/shared/src/tiktok.ts, packages/providers/src/tiktok/,
// packages/database/src/services/tiktok/): the fields it asks for, when it reads, what it stores,
// how tokens are sealed, and what a disconnect removes. Nothing here claims a capability Loop
// does not have.

export const metadata: Metadata = {
  title: 'Privacy Policy — EMG Loop',
  description: 'How Elite Media Group handles personal information in EMG Loop, including a connected TikTok account.',
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" intro="This policy explains what information EMG Loop holds about you, what it does with a TikTok account you connect, and the choices you have.">
      <h2>1. Who we are</h2>
      <p>
        Elite Media Group (“EMG”, “we”, “us”) operates EMG Loop (“Loop”) at app.emgloop.com, including the Creator Hub for
        creators EMG manages. EMG is the controller of the personal information described here. Contact us at{' '}
        <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.
      </p>

      <h2>2. Information Loop holds about you as a user</h2>
      <ul>
        <li>
          <strong>Your account.</strong> Your name, email address, the organization you belong to and your role in it, as EMG
          set them up when you were invited. Your password is stored only as a salted hash (scrypt); Loop cannot read it back.
        </li>
        <li>
          <strong>Your sessions.</strong> A session cookie (<code>emgloop_session</code>) keeps you signed in; only a hash of it
          is stored on the server. If you choose “Remember me”, the session lasts up to 30 days. Loop also records the time zone
          your device reports, so dates are shown in your local time.
        </li>
        <li>
          <strong>Audit records.</strong> Sign-ins, account changes and connection changes are written to an audit log that
          records who did what and when. It records identifiers and reasons, never passwords, tokens or the content of a
          connected account.
        </li>
        <li>
          <strong>Your work in Loop.</strong> What you and EMG record there: profile details you enter, content you upload, edit
          requests, approvals, and the opportunities, tasks and earnings information EMG records for you.
        </li>
      </ul>

      <h2>3. Information from a TikTok account you connect</h2>
      <p>
        Connecting your TikTok account is optional and happens only when you choose Connect TikTok on your Profile page and
        approve the request on TikTok’s own consent screen. Loop asks TikTok for four permissions and uses each as follows.
        You may untick any of them on TikTok’s screen; Loop then reads only what you allowed and tells you which permission is
        missing. Basic account info is needed to connect at all: if you decline it, nothing is stored and no account is
        connected.
      </p>
      <ul>
        <li>
          <strong>Basic account info (user.info.basic).</strong> Your TikTok account identifier for Loop (the app-scoped “open
          id”) and your display name. Loop uses the identifier to know which account is connected and to keep one account from
          being connected to two people in the same organization.
        </li>
        <li>
          <strong>Public profile (user.info.profile).</strong> Your username, whether the account is verified, and the link to
          your public profile. Loop shows the username and the link on your Profile page.
        </li>
        <li>
          <strong>Account counts (user.info.stats).</strong> Your follower, following, likes and video counts. Loop shows them on
          your Profile page and records the follower count as an audience observation, labelled as coming from the platform,
          so your audience history in the Creator Hub is based on what TikTok reported.
        </li>
        <li>
          <strong>Public video list (video.list).</strong> For up to ten of your most recent public videos: the video id, title
          or caption, share link, posting date, and the public view, like, comment and share counts. Loop shows them on your
          Profile page as “recent public videos, as listed”. TikTok only returns public videos to this permission; Loop never
          reads private videos, video files, comments or messages.
        </li>
      </ul>
      <p>
        Loop does not ask for and does not receive your avatar, your bio, your email address, your TikTok contacts, or anything
        about any other TikTok account. Loop never posts to TikTok, never changes anything on your account, and makes no
        automated decisions about you from this information.
      </p>
      <p>
        <strong>When Loop reads.</strong> Loop reads your account once when you connect, and again when you open your Profile
        page if the last read is more than fifteen minutes old. Loop does not read your account in the background.
      </p>
      <p>
        <strong>Access tokens.</strong> To read on your behalf, TikTok gives Loop an access token (valid for 24 hours) and a
        refresh token (valid for up to a year, replaced on every refresh). Both are stored only encrypted (AES-256-GCM) with a
        key that is held on the server, never in the database and never sent to your browser. Tokens are renewed on the server,
        used only to make the reads described above, and are never written to logs.
      </p>

      <h2>4. How we use this information</h2>
      <ul>
        <li>to run Loop for you: sign you in, show you your work, and show you your connected account and what it reported;</li>
        <li>
          to let the EMG team members who manage your creator profile see, inside Loop, that your TikTok account is connected
          and the follower counts recorded as your audience history (they do not see your video list or your other counts
          from Loop);
        </li>
        <li>to keep Loop secure and to keep an audit trail of account and connection changes;</li>
        <li>to send you transactional email about your Loop account (for example an invitation or a password reset).</li>
      </ul>
      <p>We do not sell personal information, use it for advertising, or share it with anyone for their own marketing.</p>

      <h2>5. Who else receives it</h2>
      <ul>
        <li>
          <strong>TikTok.</strong> When Loop reads your account it sends your access token to TikTok’s API, as TikTok requires.
          Nothing else about you is sent to TikTok.
        </li>
        <li>
          <strong>Infrastructure providers</strong> that process data on our behalf under contract: the application is hosted on
          Netlify, the database is hosted on Neon (PostgreSQL), transactional email is sent through Resend, and content you
          upload in the Creator Hub is stored in private object storage on Amazon Web Services. None of them receives your
          TikTok tokens in a readable form.
        </li>
        <li>
          <strong>Legal requirements.</strong> We may disclose information when the law requires it or to protect the rights and
          safety of EMG, our users or others.
        </li>
      </ul>

      <h2>6. How long we keep it</h2>
      <ul>
        <li>
          <strong>TikTok tokens</strong> are deleted from Loop’s database immediately when you disconnect, when TikTok refuses to
          renew the stored access or the stored tokens can no longer be opened (the connection then reads “reconnect
          required”), or when your membership record in Loop is deleted. Every read also requires an active Loop login bound to your creator profile, so a connection is never used
          after your access to Loop ends.
        </li>
        <li>
          <strong>Counts and video details</strong> read from TikTok are kept on your creator profile only as the last read and
          are removed when you disconnect. Your TikTok username stays recorded on your profile as the account you last
          connected until you reconnect or ask us to remove it. Follower counts recorded as audience observations are kept as
          part of your creator profile’s history for as long as the profile exists; you can ask us to delete them.
        </li>
        <li>
          <strong>Account, work and audit records</strong> are kept for as long as you have access to Loop and afterwards for
          as long as EMG needs them to meet its obligations to you and under law.
        </li>
      </ul>

      <h2>7. Security</h2>
      <p>
        Loop is served over HTTPS only. Passwords are stored as salted scrypt hashes, session tokens as hashes, and TikTok tokens
        encrypted and bound to your organization, your login and your TikTok account, so a copied token cannot be used elsewhere.
        Secrets are held on the server only. Access to information inside Loop is limited by role, and every page and action
        checks that authorization on the server.
      </p>

      <h2>8. Your choices and rights</h2>
      <ul>
        <li>
          <strong>Disconnect TikTok</strong> at any time from your Profile page (Profile → Social accounts → Disconnect
          TikTok). You can also revoke Loop’s access from within TikTok, under Security and permissions → Apps and services.
          Loop then cannot read anything further: your Profile page shows that the last read failed and, once the stored
          access lapses (within 24 hours), that the connection needs reconnecting. Loop’s copy of the tokens is deleted at
          that point; disconnecting in Loop deletes it immediately.
        </li>
        <li>
          <strong>Access, correction and deletion.</strong> You can see and edit your profile details in Loop. To ask for a copy
          of the information we hold about you, to correct it, or to have it deleted, contact us at the address below. Depending
          on where you live, you may have further rights under data-protection law, which you can exercise the same way.
        </li>
      </ul>

      <h2>9. Children</h2>
      <p>Loop is a business tool for people EMG works with and is not directed at children. We do not knowingly collect information from anyone under 13.</p>

      <h2>10. Changes to this policy</h2>
      <p>
        We may update this policy. The date at the top of this page is the date of the current text. If a change affects how
        a connected account is used, we will tell you in Loop before it takes effect.
      </p>

      <h2>11. Contact</h2>
      <p>
        Privacy questions or requests: <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>. The{' '}
        <a href={LEGAL_PATHS.terms}>Terms of Service</a> describe the service itself.
      </p>
    </LegalPage>
  );
}
