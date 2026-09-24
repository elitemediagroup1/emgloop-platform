// The public legal pages' chrome: Terms of Service and Privacy Policy share one frame.
//
// PUBLIC, STATIC, AND EMPTY-HANDED. These pages render for anyone -- a creator, a TikTok
// reviewer, a search engine -- so nothing here reads a session, a database or an environment
// variable, and the test that inventories public pages holds them to that. They draw on the Loop
// design system (loop-os.css and the :root --loop-* tokens; the `.loop-legal` layout classes
// live in that same sheet, and the (legal) route group's layout is what loads it) so the public
// face and the signed-in one are one product.
//
// Elite Media Group operates EMG Loop; the contact address is the one Loop already publishes for
// access requests (LOOP_ACCESS_REQUEST_TO in docs/TRANSACTIONAL_EMAIL.md).

import Link from 'next/link';
import type { ReactNode } from 'react';

import { EmgLoopWordmark } from '../crm/_brand/Logos';

export const LEGAL_OPERATOR = 'Elite Media Group';
export const LEGAL_PRODUCT = 'EMG Loop';
export const LEGAL_CONTACT_EMAIL = 'hello@elitemediagroup.io';
/** ISO date of the current text of both documents. A change to either updates this. */
export const LEGAL_LAST_UPDATED = '2026-09-24';
export const LEGAL_LAST_UPDATED_TEXT = '24 September 2026';

export const LEGAL_PATHS = Object.freeze({ terms: '/terms', privacy: '/privacy' } as const);

export function LegalFooter() {
  return (
    <footer className="loop-legal__foot" aria-label="Legal">
      <nav className="loop-legal__links">
        <Link href={LEGAL_PATHS.terms}>Terms of Service</Link>
        <span aria-hidden="true">·</span>
        <Link href={LEGAL_PATHS.privacy}>Privacy Policy</Link>
      </nav>
      <p className="loop-legal__operator">
        {LEGAL_PRODUCT} is operated by {LEGAL_OPERATOR}. Contact: <a href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>
      </p>
    </footer>
  );
}

export function LegalPage({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <div className="loop-legal">
      <header className="loop-legal__head">
        <Link href="/crm/login" aria-label="EMG Loop sign-in">
          <EmgLoopWordmark height={26} />
        </Link>
        <nav className="loop-legal__links" aria-label="Legal documents">
          <Link href={LEGAL_PATHS.terms}>Terms of Service</Link>
          <span aria-hidden="true">·</span>
          <Link href={LEGAL_PATHS.privacy}>Privacy Policy</Link>
        </nav>
      </header>
      <main className="loop-legal__main">
        <p className="loop-eyebrow">
          {LEGAL_PRODUCT} · {LEGAL_OPERATOR}
        </p>
        <h1 className="loop-title">{title}</h1>
        <p className="loop-subtitle">
          Last updated {LEGAL_LAST_UPDATED_TEXT}. {intro}
        </p>
        <article className="loop-legal__prose">{children}</article>
      </main>
      <LegalFooter />
    </div>
  );
}
