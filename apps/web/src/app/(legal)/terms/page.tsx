import type { Metadata } from 'next';

import { LEGAL_CONTACT_EMAIL, LEGAL_PATHS, LegalPage } from '../../_legal/legal-document';

// Terms of Service for EMG Loop, at /terms. PUBLIC and STATIC: no session, no data, no
// environment. It describes what Loop actually does today -- an invited operating system for
// businesses EMG works with, and the Creator Hub for creators EMG manages, with one platform
// connection (TikTok) a creator may make -- and nothing it does not.

export const metadata: Metadata = {
  title: 'Terms of Service — EMG Loop',
  description: 'The terms on which Elite Media Group provides EMG Loop and the Creator Hub.',
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" intro="These terms govern your use of EMG Loop, including the Creator Hub and any third-party account you connect to it.">
      <h2>1. Who we are and what these terms cover</h2>
      <p>
        Elite Media Group (“EMG”, “we”, “us”) operates EMG Loop (“Loop”), the application at app.emgloop.com. Loop is an
        operating system for the businesses EMG works with, and it includes the Creator Hub: the workspace for creators EMG
        manages. These terms apply to everyone who signs in to Loop. If you use Loop on behalf of a business, you confirm you
        are entitled to accept these terms for it.
      </p>
      <p>
        Your commercial relationship with EMG — fees, deliverables, rights in content, payment — is governed by the separate
        agreement between you and EMG. These terms govern the software; where they differ from that agreement about a
        commercial matter, the agreement prevails.
      </p>

      <h2>2. Accounts and access</h2>
      <p>
        Access to Loop is by invitation from EMG. Your login is personal: keep your password confidential, do not share your
        session, and tell us at once at <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a> if you believe
        it has been used without your permission. You are responsible for what is done under your login until you tell us.
        EMG may suspend or end a login at any time, for example when a person’s work with EMG ends.
      </p>

      <h2>3. The Creator Hub</h2>
      <p>
        If you are a creator EMG manages, the Creator Hub shows you the content you and EMG work on (as versions, with the
        edits EMG returns for your review), the opportunities and campaigns EMG has recorded for you, the tasks waiting on
        you, the earnings information EMG has recorded, and your profile. Everything there is shown as EMG recorded it or as a
        connected platform reported it. Where Loop shows seeded demonstration data, it says so on the page.
      </p>

      <h2>4. Connecting a third-party account</h2>
      <p>
        A creator may connect their own TikTok account to their Creator Hub profile. Connecting is optional, is done through
        TikTok’s own consent screen, and can be undone at any time. When you connect, you confirm that the account is yours
        or that you are entitled to connect it. What Loop reads from a connected account, how it is stored and for how long,
        is set out in the <a href={LEGAL_PATHS.privacy}>Privacy Policy</a>. Loop never posts to a connected account, never
        changes anything on it, and never reads private videos or any account other than the one you connected.
      </p>
      <p>
        TikTok is an independent service. Your use of TikTok is governed by TikTok’s own terms and privacy policy, and TikTok
        may change or withdraw the access it offers to applications like Loop at any time. EMG does not control TikTok and
        is not responsible for it.
      </p>

      <h2>5. Permitted use</h2>
      <p>You agree to use Loop lawfully and only for the purpose it was made available to you. In particular, you will not:</p>
      <ul>
        <li>try to access information belonging to another person or organization, or test Loop’s access controls;</li>
        <li>upload content you do not have the right to upload, or content that is unlawful;</li>
        <li>connect a third-party account that is not yours or that you are not entitled to connect;</li>
        <li>use automated means to collect information from Loop, or interfere with its operation;</li>
        <li>copy, modify, reverse engineer or resell Loop.</li>
      </ul>

      <h2>6. Content you upload</h2>
      <p>
        You keep whatever rights you have in the content you upload to Loop. You give EMG the permission it needs to store,
        process, display and deliver that content inside Loop for the purposes of your work with EMG. Any further use of your
        content is governed by your agreement with EMG, not by these terms.
      </p>

      <h2>7. Disconnecting and deleting</h2>
      <p>
        You can disconnect a connected TikTok account from your Profile page in Loop at any time (Profile → Social accounts →
        Disconnect TikTok). Loop then deletes its copy of the access tokens, asks TikTok to revoke the access, and removes
        the counts and video details it read under that access from your profile. You can also revoke Loop’s access from
        within TikTok, under Security and permissions → Apps and services. To ask for your other information to be
        corrected or deleted, contact us at the address below.
      </p>

      <h2>8. Availability and changes</h2>
      <p>
        Loop is provided as it is. We may change, add or remove features, and we may suspend Loop for maintenance or for
        reasons outside our control. We do not promise that Loop will be available without interruption or free of errors.
      </p>

      <h2>9. Ending your access</h2>
      <p>
        You may stop using Loop at any time. EMG may end or suspend your access if you break these terms, if your work with
        EMG ends, or if we are required to by law. When your access ends, your sessions end and you can no longer sign in.
        Information EMG keeps after that is described in the Privacy Policy.
      </p>

      <h2>10. Disclaimers and limitation of liability</h2>
      <p>
        Counts, video details and other figures that a connected platform reports are shown as that platform reported them;
        EMG does not verify them and is not responsible for their accuracy. To the fullest extent permitted by law, EMG
        excludes all warranties about Loop that are not stated in these terms, and is not liable for loss of profit, loss of
        data, or indirect or consequential loss arising from your use of Loop. Nothing in these terms excludes or limits any
        liability that cannot be excluded or limited by law.
      </p>

      <h2>11. Changes to these terms</h2>
      <p>
        We may update these terms. The date at the top of this page is the date of the current text. Continuing to use Loop
        after a change means you accept the updated terms; if you do not, stop using Loop and contact us.
      </p>

      <h2>12. Contact</h2>
      <p>
        Questions about these terms: <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.
      </p>
    </LegalPage>
  );
}
