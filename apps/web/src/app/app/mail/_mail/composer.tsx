// The composer: one editable reply, and the only way a message leaves Loop (GM-2).
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6.11.
//
// ONE COMPOSER, TWO WAYS TO FILL IT. A reply an employee typed and a reply Loop proposed are the
// same object in the same box with the same Send button: what differs is a provenance note above
// it, and the fact that a proposal arrives already written. There is no "AI send" path, no
// second form and no shortcut -- generation puts words in this box, and a person sends them.
//
// IT IS A PLAIN FORM. No client component and no JavaScript: the fields post to a server action
// that resolves the principal from the session. Nothing in the form names an organization or a
// user, and the send action takes only the draft the employee last saved.
//
// KEYBOARD AND MOBILE. Labels are real labels, the textarea is a textarea, the buttons are
// buttons in reading order, and the whole thing is one column at any width.

import { WORK_SEND_POLICY, type GmailAddress } from '@emgloop/shared';

import { checkSendAction, discardDraftAction, draftWithLoopAction, releaseSendAction, saveDraftAction, sendReplyAction } from '../../../../daily-loop/mail-actions';

export interface ComposerDraft {
  readonly body: string;
  readonly mode: 'REPLY' | 'REPLY_ALL';
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly source: 'MANUAL' | 'AI_PROPOSED';
  readonly aiUnedited: boolean;
  readonly sendFailureClass: string | null;
  readonly sentAt: Date | null;
  /** Where the reply stands on its way out. Absent means an ordinary draft. */
  readonly sendState?: 'DRAFT' | 'SENDING' | 'SEND_UNKNOWN' | 'SENT';
  readonly sendAttemptStartedAt?: Date | null;
  readonly sendResolution?: string | null;
}

const list = (addresses: readonly GmailAddress[] | readonly string[]): string =>
  addresses.map((a) => (typeof a === 'string' ? a : a.address)).join(', ');

export function Composer(props: {
  readonly threadId: string;
  readonly inReplyToMessageId: string;
  readonly draft: ComposerDraft | null;
  readonly replyTo: readonly GmailAddress[];
  readonly replyAllCc: readonly GmailAddress[];
  readonly canSend: boolean;
  /** The render's clock, so "can the employee release this yet" is decided the same way twice. */
  readonly now?: Date;
  /** Whether Loop can draft here, and if not, why -- an honest state, never a hidden button. */
  readonly draftWithLoop?: { readonly available: boolean; readonly reason: string | null };
}) {
  const { threadId, inReplyToMessageId, draft } = props;
  const state = draft?.sendState ?? 'DRAFT';
  // WHILE A SEND IS IN FLIGHT OR IN DOUBT, THE WORDS ARE EVIDENCE, NOT A DRAFT. They are shown and
  // cannot be changed, and there is no Send button: pressing it again is exactly how one reply
  // becomes two. What the employee CAN do is ask Loop to check, or -- once the attempt cannot
  // possibly still be running -- tell Loop, on record, that it was not sent.
  const frozen = state === 'SENDING' || state === 'SEND_UNKNOWN';
  const releasable =
    state === 'SEND_UNKNOWN' &&
    !!draft?.sendAttemptStartedAt &&
    (props.now ?? new Date()).getTime() - draft.sendAttemptStartedAt.getTime() >= WORK_SEND_POLICY.releaseAfterMs;
  const mode = draft?.mode ?? 'REPLY';
  const to = draft && draft.to.length > 0 ? list(draft.to) : list(props.replyTo);
  const cc = draft && draft.cc.length > 0 ? list(draft.cc) : mode === 'REPLY_ALL' ? list(props.replyAllCc) : '';

  return (
    <section className="loop-compose" aria-label="Reply">
      <h3 className="loop-eyebrow">Reply</h3>

      {draft?.source === 'AI_PROPOSED' ? (
        <p className="loop-compose__provenance">
          <span className="val">Loop drafted this.</span>{' '}
          {draft.aiUnedited
            ? 'It is a proposal from this conversation and nothing else. Read it, change what is wrong, and send it yourself.'
            : 'You have edited it since.'}
        </p>
      ) : null}

      {state === 'SENDING' ? (
        <p className="loop-compose__pending" role="status">
          Sending… Loop is waiting for Gmail to confirm. Refresh in a moment; this reply will not be sent twice.
        </p>
      ) : null}

      {state === 'SEND_UNKNOWN' ? (
        <div className="loop-compose__pending" role="alert">
          <p className="loop-compose__pending-title">Loop could not confirm whether this reply was delivered.</p>
          <p>
            It will not be sent again automatically. Loop is checking your Gmail Sent mail, and will mark it sent the moment it
            finds it. If it is not there, Loop will say so and let you send it again.
          </p>
          <div className="loop-compose__actions">
            <form action={checkSendAction}>
              <input type="hidden" name="threadId" value={threadId} />
              <button type="submit" className="loop-btn">
                Check Gmail again
              </button>
            </form>
            {releasable ? (
              <form action={releaseSendAction}>
                <input type="hidden" name="threadId" value={threadId} />
                <button type="submit" className="loop-btn loop-btn--quiet">
                  I checked Sent — it was not sent
                </button>
              </form>
            ) : null}
          </div>
        </div>
      ) : null}

      {state === 'DRAFT' && draft?.sendFailureClass === 'NOT_DELIVERED' ? (
        <p className="loop-compose__failed" role="alert">
          Loop checked your Gmail and this reply was never delivered. Nothing was sent, your words are still here, and you can send it
          again.
        </p>
      ) : state === 'DRAFT' && draft?.sendFailureClass ? (
        <p className="loop-compose__failed" role="alert">
          That reply was not sent ({draft.sendFailureClass.toLowerCase().replace(/_/g, ' ')}). Nothing was delivered, and your words are still here.
        </p>
      ) : null}

      {!frozen && props.canSend ? (
        <p className="loop-compose__how">
          {props.draftWithLoop?.available
            ? 'Write your reply below — or press Draft with Loop and Loop will propose one in this box for you to edit. Nothing is sent until you press Send reply.'
            : 'Write your reply below. Nothing is sent until you press Send reply.'}
        </p>
      ) : null}

      <form action={sendReplyAction} className="loop-compose__form">
        <input type="hidden" name="threadId" value={threadId} />
        <input type="hidden" name="inReplyToMessageId" value={inReplyToMessageId} />

        <div className="loop-compose__modes">
          <label className="loop-compose__mode">
            <input type="radio" name="mode" value="REPLY" defaultChecked={mode === 'REPLY'} disabled={frozen} />
            Reply
          </label>
          <label className="loop-compose__mode">
            <input type="radio" name="mode" value="REPLY_ALL" defaultChecked={mode === 'REPLY_ALL'} disabled={frozen} />
            Reply all
          </label>
        </div>

        <label className="loop-compose__field">
          <span className="loop-compose__label">To</span>
          <input type="text" name="to" defaultValue={to} className="loop-input" autoComplete="off" spellCheck={false} readOnly={frozen} />
        </label>
        <label className="loop-compose__field">
          <span className="loop-compose__label">Cc</span>
          <input type="text" name="cc" defaultValue={cc} className="loop-input" autoComplete="off" spellCheck={false} placeholder="Nobody" readOnly={frozen} />
        </label>
        <label className="loop-compose__field">
          <span className="loop-compose__label">Message</span>
          <textarea
            name="body"
            defaultValue={draft?.body ?? ''}
            className="loop-input loop-compose__body"
            rows={10}
            required
            readOnly={frozen}
            placeholder="Write your reply…"
          />
        </label>

        <div className="loop-compose__actions">
          {frozen ? null : props.canSend ? (
            <button type="submit" className="loop-btn loop-btn--primary">
              Send reply
            </button>
          ) : (
            <p className="loop-home__line muted">You do not have permission to send mail from Loop.</p>
          )}
          {frozen ? null : (
            <button type="submit" formAction={saveDraftAction} className="loop-btn">
              Save draft
            </button>
          )}
          {!frozen && props.draftWithLoop?.available ? (
            // Same form, so whatever the employee has already typed travels with it as their
            // instruction. It fills this box; it does not send anything. Not offered while a reply
            // is in flight or in doubt: those words are frozen as evidence.
            <button type="submit" formAction={draftWithLoopAction} className="loop-btn">
              Draft with Loop
            </button>
          ) : null}
          {draft && !frozen ? (
            <button type="submit" formAction={discardDraftAction} className="loop-btn loop-btn--quiet">
              Discard
            </button>
          ) : null}
        </div>
      </form>

      {props.draftWithLoop && !props.draftWithLoop.available && props.draftWithLoop.reason ? (
        <p className="loop-compose__note muted">Draft with Loop is unavailable: {props.draftWithLoop.reason}.</p>
      ) : null}
      <p className="loop-compose__note muted">
        Sent from your own Gmail account, as you. Loop never sends mail on its own, and never
        sends anything it drafted without you.
      </p>
    </section>
  );
}
