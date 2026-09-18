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

import type { GmailAddress } from '@emgloop/shared';

import { discardDraftAction, saveDraftAction, sendReplyAction } from '../../../../daily-loop/mail-actions';

export interface ComposerDraft {
  readonly body: string;
  readonly mode: 'REPLY' | 'REPLY_ALL';
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly source: 'MANUAL' | 'AI_PROPOSED';
  readonly aiUnedited: boolean;
  readonly sendFailureClass: string | null;
  readonly sentAt: Date | null;
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
  readonly aiDraft?: React.ReactNode;
}) {
  const { threadId, inReplyToMessageId, draft } = props;
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

      {draft?.sendFailureClass ? (
        <p className="loop-compose__failed" role="alert">
          That reply was not sent ({draft.sendFailureClass.toLowerCase().replace(/_/g, ' ')}). Nothing was delivered, and your words are still here.
        </p>
      ) : null}

      <form action={sendReplyAction} className="loop-compose__form">
        <input type="hidden" name="threadId" value={threadId} />
        <input type="hidden" name="inReplyToMessageId" value={inReplyToMessageId} />

        <div className="loop-compose__modes">
          <label className="loop-compose__mode">
            <input type="radio" name="mode" value="REPLY" defaultChecked={mode === 'REPLY'} />
            Reply
          </label>
          <label className="loop-compose__mode">
            <input type="radio" name="mode" value="REPLY_ALL" defaultChecked={mode === 'REPLY_ALL'} />
            Reply all
          </label>
        </div>

        <label className="loop-compose__field">
          <span className="loop-compose__label">To</span>
          <input type="text" name="to" defaultValue={to} className="loop-input" autoComplete="off" spellCheck={false} />
        </label>
        <label className="loop-compose__field">
          <span className="loop-compose__label">Cc</span>
          <input type="text" name="cc" defaultValue={cc} className="loop-input" autoComplete="off" spellCheck={false} placeholder="Nobody" />
        </label>
        <label className="loop-compose__field">
          <span className="loop-compose__label">Message</span>
          <textarea
            name="body"
            defaultValue={draft?.body ?? ''}
            className="loop-input loop-compose__body"
            rows={10}
            required
            placeholder="Write your reply…"
          />
        </label>

        <div className="loop-compose__actions">
          {props.canSend ? (
            <button type="submit" className="loop-btn loop-btn--primary">
              Send reply
            </button>
          ) : (
            <p className="loop-home__line muted">You do not have permission to send mail from Loop.</p>
          )}
          <button type="submit" formAction={saveDraftAction} className="loop-btn">
            Save draft
          </button>
          {props.aiDraft ?? null}
          {draft ? (
            <button type="submit" formAction={discardDraftAction} className="loop-btn loop-btn--quiet">
              Discard
            </button>
          ) : null}
        </div>
      </form>

      <p className="loop-compose__note muted">
        Sent from your own Gmail account, as you. Loop never sends mail on its own.
      </p>
    </section>
  );
}
