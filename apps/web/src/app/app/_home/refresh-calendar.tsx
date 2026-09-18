// "Read my calendar again" — the one action Your Day can honestly offer today.
//
// A plain form posting a server action: no client component, no JavaScript, and nothing to
// mis-target. The action takes no input at all, so the only calendar it can refresh is the one
// belonging to the session that submitted it. The server honours it once a minute (DL-4); a second
// click inside that window is accepted and changes nothing, because a calendar cannot be newer
// than the read that just happened.

import { refreshCalendarAction } from '../../../daily-loop/actions';

export function RefreshCalendar() {
  return (
    <form action={refreshCalendarAction} className="loop-home__actions">
      <button type="submit" className="loop-btn">
        Read my calendar again
      </button>
    </form>
  );
}
