// "Read my mail again" -- the recovery path, not the way Loop stays current (GM-2).
//
// A plain form posting a server action: no client component, no JavaScript, and nothing to
// mis-target. The action takes no input at all, so the only mailbox it can refresh is the one
// belonging to the session that submitted it. The server honours it once every thirty seconds; a
// second click inside that window is accepted and changes nothing, because a mailbox cannot be
// newer than the read that just happened.
//
// BOUNDED. It reads only what changed since Loop's position in the mailbox -- at most
// GMAIL_FRESHNESS_MAX_MESSAGES, resuming where it stopped -- and never the 14-day first read, so it
// is offered only once that first read (the scheduled cycle's) has happened.

import { refreshMailAction } from '../../../../daily-loop/mail-actions';

export function RefreshMail() {
  return (
    <form action={refreshMailAction} className="loop-home__actions">
      <button type="submit" className="loop-btn">
        Read my mail again
      </button>
    </form>
  );
}
