import Link from 'next/link';
import type { ReactNode } from 'react';
import { EmgLoopWordmark } from '../crm/_brand/Logos';
import { LEGAL_CONTACT_EMAIL, LEGAL_PATHS } from '../_legal/legal-document';

const SIGN_IN = '/crm/login';

/** Public product descriptions only. Never resolve a creator, mailbox, session or live metric here. */
export function ProductFrame({ children, signInHref = SIGN_IN }: { children: ReactNode; signInHref?: string }) {
  return <div className="lp-site">
    <a className="lp-skip" href="#product-main">Skip to content</a>
    <header className="lp-header">
      <Link href="/" aria-label="EMG Loop home"><EmgLoopWordmark height={27} /></Link>
      <nav aria-label="Product navigation">
        <Link href="/creator-hub">Creator Hub</Link><Link href="/integrations/tiktok">TikTok integration</Link>
      </nav>
      <Link className="lp-button lp-button--small" href={signInHref}>Sign in <span aria-hidden="true">↗</span></Link>
    </header>
    <main id="product-main">{children}</main>
    <footer className="lp-footer">
      <div><EmgLoopWordmark height={24} /><p>A closer connection between creators and their team.</p><small>Operated by Elite Media Group.</small></div>
      <nav aria-label="Company and policies"><Link href="/creator-hub">Creator Hub</Link><Link href="/integrations/tiktok">TikTok integration</Link><Link href={LEGAL_PATHS.privacy}>Privacy Policy</Link><Link href={LEGAL_PATHS.terms}>Terms of Service</Link><a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>Contact EMG</a></nav>
    </footer>
  </div>;
}

function WorkspaceIllustration() {
  return <figure className="lp-workspace" aria-label="Illustration of the Creator Hub layout, with no live creator records">
    <div className="lp-workspace__bar"><span>EMG LOOP <span className="lp-dot">∞</span></span><span>CREATOR HUB</span></div>
    <div className="lp-workspace__intro"><span className="lp-eyebrow">Your workspace</span><h2>See the bigger picture.</h2><p>Brand activity. Content. What comes next.</p></div>
    <div className="lp-workspace__stages">{['Outreach', 'Conversations', 'Active deals'].map((stage, i) => <div key={stage}><span className="lp-stage-number">0{i + 1}</span><h3>{stage}</h3><span className="lp-stage-line" /></div>)}</div>
    <div className="lp-workspace__bottom"><span>Content reviews <b aria-hidden="true">↗</b></span><span>Next actions <b aria-hidden="true">↗</b></span><span>Your profile <b aria-hidden="true">↗</b></span></div>
    <figcaption>Product layout illustration. No live creator data.</figcaption>
  </figure>;
}

export function ProductHome({ signInHref = SIGN_IN }: { signInHref?: string }) {
  return <ProductFrame signInHref={signInHref}>
    <section className="lp-hero lp-container">
      <div className="lp-hero__copy"><p className="lp-eyebrow">EMG Loop · Creator Hub</p><h1>Your partnerships.<br />Your content.<br /><em>Everything in one place.</em></h1><p className="lp-lead">See which brands EMG has contacted, follow ongoing conversations, review content and know what needs your attention.</p><div className="lp-actions"><Link className="lp-button" href="/creator-hub">See how Loop works <span aria-hidden="true">↗</span></Link><Link className="lp-text-link" href={signInHref}>Sign in</Link></div><p className="lp-caption">For creators represented by EMG Talent Group. Access by invitation.</p></div>
      <WorkspaceIllustration />
    </section>
    <div className="lp-ribbon"><span>Partnership visibility</span><span>Content collaboration</span><span>Creator-controlled connections</span></div>
    <section className="lp-section lp-container" aria-labelledby="closer"><div className="lp-section-heading"><p className="lp-eyebrow">Less chasing. More creating.</p><h2 id="closer">Your team’s work.<br /><em>In view.</em></h2><p>Keep track of the work behind your next partnership, without needing access to your manager’s inbox.</p></div>
      <div className="lp-features">
        <article><span className="lp-index">01 / Partnerships</span><h3>Know where things stand.</h3><p>See authorized brand updates organized into Outreach, Conversations and Active Deals. Expand a brand to read its latest summary, next step and shared history.</p><Link href="/creator-hub#partnerships">Explore partnership updates ↗</Link></article>
        <article><span className="lp-index">02 / Content</span><h3>Move the work forward.</h3><p>Keep uploaded content, review requests and approvals in your creator workspace. Find what needs your attention and follow your content through production.</p><Link href="/creator-hub#content">Explore content collaboration ↗</Link></article>
        <article><span className="lp-index">03 / Connections</span><h3>Your accounts. Your choice.</h3><p>Add your social profiles and manage supported connections from your Profile page. TikTok account connection is optional and awaits production approval.</p><Link href="/integrations/tiktok">How TikTok connection works ↗</Link></article>
      </div>
    </section>
    <section className="lp-statement"><div className="lp-container"><p className="lp-eyebrow">Designed around trust</p><h2>In the loop.<br /><em>In your own space.</em></h2><p>Your creator workspace is private. Brand updates are shared summaries, not open access to staff email. Each creator sees only the information authorized for their account.</p><Link className="lp-text-link" href="/privacy">Read our Privacy Policy ↗</Link></div></section>
    <section className="lp-section lp-container lp-faq" aria-labelledby="questions"><div><p className="lp-eyebrow">A few things to know</p><h2 id="questions">Before you<br /><em>step inside.</em></h2></div><div>
      <details><summary>Who is EMG Loop for?</summary><p>EMG Loop is operated by Elite Media Group for its team and the creators it works with. Creators receive access by invitation. This is not an open social network or a public view of the agency’s records.</p></details>
      <details><summary>How do I get access?</summary><p>Use the invitation EMG sends you to set up your account and complete your creator profile. If you already have an account, <Link href={signInHref}>sign in</Link>. For access questions, contact <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.</p></details>
      <details><summary>Does Loop post to my social accounts?</summary><p>The TikTok integration is read-only. It is designed to display your authorized profile information, account counts and recent public video details. It does not publish posts or read your messages. Production availability is pending TikTok approval.</p></details>
      <details><summary>Are social photos and videos imported automatically?</summary><p>Automatic media import during onboarding is not available yet. Selected public images and video links may be curated by EMG. Those selections are labeled separately from connected platform data.</p></details>
    </div></section>
    <section className="lp-end lp-container"><div><p className="lp-eyebrow">Already part of EMG?</p><h2>Your next step is inside.</h2></div><Link className="lp-button" href={signInHref}>Sign in to EMG Loop ↗</Link></section>
  </ProductFrame>;
}

export function CreatorHubOverview() {
  return <ProductFrame><section className="lp-detail-hero lp-container"><p className="lp-eyebrow">The Creator Hub</p><h1>More clarity.<br /><em>More room to create.</em></h1><p className="lp-lead">One private workspace for the relationship between you and your EMG team. Follow shared partnership activity, review content and see your next actions.</p></section>
    <section className="lp-section lp-container lp-feature-detail" id="partnerships"><div><p className="lp-eyebrow">01 / Partnership activity</p><h2>From first contact<br /><em>to agreed work.</em></h2></div><div><p>EMG can authorize selected email conversations for creator-facing summaries. Accepted related conversations are grouped by creator and brand, with expandable history and a manual Refresh updates control.</p><dl className="lp-definitions"><div><dt>Outreach</dt><dd>Brands contacted on your behalf, awaiting a substantive first response.</dd></div><div><dt>Conversations</dt><dd>Two-way discussions, including proposals and negotiations that are not yet an agreed partnership.</dd></div><div><dt>Active Deals</dt><dd>Partnerships supported by evidence of agreed work, such as an accepted brief, contract or payment commitment.</dd></div></dl><p className="lp-caption">Updates depend on authorized sources and accepted evidence. Historical review may still be in progress; a refresh request does not guarantee an immediate new summary.</p></div></section>
    <section className="lp-section lp-container lp-feature-detail" id="content"><div><p className="lp-eyebrow">02 / Content & collaboration</p><h2>The next action.<br /><em>Without the guesswork.</em></h2></div><div><h3>Content and reviews</h3><p>Upload content into your workspace, follow production stages, respond to requested changes and approve the work shared for your review.</p><h3>Tasks and opportunities</h3><p>Your home brings together the tasks that need you and the opportunities EMG has shared with you. An empty panel means no such records are currently shared; it does not invent work.</p><h3>Earnings and audience</h3><p>See recorded earnings and available audience observations. Platform-reported information and manually observed snapshots are labeled by source; an unconnected account is not presented as a live feed.</p></div></section>
    <section className="lp-section lp-container lp-feature-detail"><div><p className="lp-eyebrow">03 / Getting started</p><h2>A personal workspace.<br /><em>A simple start.</em></h2></div><ol className="lp-steps"><li><strong>Accept your invitation.</strong><p>Use your EMG invitation to create your login. Your invitation determines the creator profile you can access.</p></li><li><strong>Complete your profile.</strong><p>Add your bio, categories and social handles. Declaring a handle identifies an account for review; it does not authorize API access.</p></li><li><strong>Work with your team.</strong><p>Visit Home for shared brand activity and tasks. Use Content, Opportunities and Profile for the details. Supported account connections require your separate permission.</p></li></ol></section>
    <section className="lp-end lp-container"><div><p className="lp-eyebrow">Your workspace stays yours</p><h2>Creator access is private.</h2><p>Other creators’ records and staff mailboxes are not available through your creator login.</p></div><Link className="lp-button" href={SIGN_IN}>Sign in ↗</Link></section>
  </ProductFrame>;
}

export function TikTokOverview() {
  return <ProductFrame><section className="lp-detail-hero lp-container"><p className="lp-eyebrow">Connections / TikTok</p><h1>Your account.<br /><em>Your permission.</em></h1><p className="lp-lead">An optional, read-only connection for displaying your own TikTok account information and recent public video details inside your private creator profile.</p><p className="lp-availability"><strong>Production connection pending TikTok approval.</strong> The integration is implemented for review; this page does not indicate production access has been granted.</p></section>
    <section className="lp-section lp-container lp-feature-detail"><div><p className="lp-eyebrow">What it does</p><h2>A clear view of<br /><em>your public account.</em></h2></div><div><p>When configured and authorized, Loop reads only the fields covered by the permissions you grant. Your Profile page shows connection status, the last read time and any missing permissions.</p><dl className="lp-definitions"><div><dt>Basic account information <code>user.info.basic</code></dt><dd>Identifies your connected TikTok account and displays its name.</dd></div><div><dt>Public profile <code>user.info.profile</code></dt><dd>Displays your username, profile link and verification status.</dd></div><div><dt>Account counts <code>user.info.stats</code></dt><dd>Displays public account counts and records the reported follower count as an audience observation.</dd></div><div><dt>Public videos <code>video.list</code></dt><dd>Lists up to ten recent public videos with titles or captions, posting dates, links and public engagement counts.</dd></div></dl><p>Loop does not post to TikTok, read private messages or private videos, download video files, or currently request profile photos or video cover images through this integration.</p></div></section>
    <section className="lp-section lp-container lp-feature-detail"><div><p className="lp-eyebrow">The connection journey</p><h2>Connect once.<br /><em>Stay in control.</em></h2></div><ol className="lp-steps"><li><strong>Sign in to your creator account.</strong><p>Open Profile, then Social accounts. The connection belongs to the creator profile bound to your login.</p></li><li><strong>Choose Connect TikTok when available.</strong><p>You are redirected to TikTok’s authorization screen. Sign in there and choose which requested permissions to grant. Loop never asks for your TikTok password.</p></li><li><strong>Return to your Profile.</strong><p>Loop shows the connection result and reads permitted account information. With configured access, revisiting Profile refreshes the reading when it is more than fifteen minutes old. This is not a continuous background feed.</p></li><li><strong>Disconnect whenever you choose.</strong><p>Use Disconnect TikTok on your Profile. Loop removes the stored tokens and latest account/video reading. Historical follower observations have a separate retention policy; see the Privacy Policy.</p></li></ol></section>
    <section className="lp-section lp-container lp-review"><p className="lp-eyebrow">For integration reviewers</p><h2>Review the actual flow.</h2><p>This public website requires no login. Testing the private creator connection requires a dedicated EMG Loop test account provided privately with the review submission. First-time TikTok authorization demonstrations use the TikTok developer sandbox and its configured target account.</p><p>The submitted demonstration should show sign-in, Profile → Social accounts, TikTok consent, the return to Profile, permitted data and disconnect. Public illustrations are not a substitute for this end-to-end demonstration. No reviewer credentials or real creator records are published here.</p><div className="lp-actions"><Link className="lp-button" href="/crm/login?next=%2Fapp%2Fcreator%2Fprofile">Open creator sign-in ↗</Link><Link className="lp-text-link" href="/privacy">Data handling & privacy ↗</Link></div></section>
  </ProductFrame>;
}
