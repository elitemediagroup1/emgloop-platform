// What Loop has this conversation down as, and the employee's way to disagree (GM-3).
//
// The corrections are GM-3's own server actions, unchanged: Handled, "I'm waiting on them", Snooze
// and Dismiss each record a correction beside the evidence and never edit it. They live here, on
// the conversation they are about, rather than as a wall of buttons on Home.

import { dismissItemAction, markHandledAction, markWaitingOnThemAction, snoozeItemAction } from '../../../../daily-loop/mail-actions';

const CLASS_WORDS: Readonly<Record<string, string>> = Object.freeze({
  NEEDS_YOU: 'needs your reply',
  WAITING_ON_THEM: 'is waiting on them',
  GONE_QUIET: 'has gone quiet',
});

export function ThreadAttention({ item, threadId }: { item: { readonly id: string; readonly class: string; readonly snoozed: boolean } | null; threadId: string }) {
  if (!item) return null;
  const words = CLASS_WORDS[item.class];
  if (!words) return null;
  const hidden = (
    <>
      <input type="hidden" name="itemId" value={item.id} />
      <input type="hidden" name="threadId" value={threadId} />
    </>
  );
  return (
    <section className="loop-mx-attn" aria-label="What Loop has this conversation as">
      <p className="loop-mx-attn__text">
        Loop has this conversation as one that <span className="loop-mx-attn__class">{words}</span>
        {item.snoozed ? ' (snoozed)' : ''}. Not right? Tell Loop.
      </p>
      <div className="loop-mx-attn__acts">
        <form action={markHandledAction}>
          {hidden}
          <button type="submit" className="loop-btn">Handled</button>
        </form>
        {item.class === 'NEEDS_YOU' ? (
          <form action={markWaitingOnThemAction}>
            {hidden}
            <button type="submit" className="loop-btn">I’m waiting on them</button>
          </form>
        ) : null}
        <form action={snoozeItemAction}>
          {hidden}
          <input type="hidden" name="hours" value="24" />
          <button type="submit" className="loop-btn">Snooze a day</button>
        </form>
        <form action={dismissItemAction}>
          {hidden}
          <button type="submit" className="loop-btn">Dismiss</button>
        </form>
      </div>
    </section>
  );
}
