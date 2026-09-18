// One conversation, rendered as text (GM-2).
//
// A MESSAGE BODY IS ATTACKER-CONTROLLED MARKUP and is never rendered as markup. A `text/plain`
// part is shown as text; a message that carried only HTML is reduced to text on the server
// (@emgloop/shared `mailReadableText`) and still rendered as text. There is no iframe, no
// sanitizer to get wrong, no remote image, and therefore no tracking pixel.
//
// THE QUOTED HISTORY IS CUT, because Loop is already showing it above. It is presentation only.

import { mailReadableText, mailWithoutQuotedTail, type GmailThreadMessage, type TimeView } from '@emgloop/shared';

function senderName(message: GmailThreadMessage, selfAddress: string | null): string {
  const from = message.fact.from;
  if (!from) return 'Unknown sender';
  if (selfAddress && from.address === selfAddress.toLowerCase()) return 'You';
  return from.name?.trim() || from.address;
}

export function Conversation({
  messages,
  selfAddress,
  time,
}: {
  messages: readonly GmailThreadMessage[];
  selfAddress: string | null;
  time: TimeView;
}) {
  return (
    <ol className="loop-thread">
      {messages.map((message) => {
        const text = mailReadableText(message.body);
        const { body, quotedLines } = text ? mailWithoutQuotedTail(text) : { body: '', quotedLines: 0 };
        const mine = message.fact.fromSelf;
        return (
          <li key={message.fact.messageId} className={'loop-thread__message' + (mine ? ' loop-thread__message--mine' : '')}>
            <p className="loop-thread__head">
              <span className="val">{senderName(message, selfAddress)}</span>
              <time dateTime={time.iso(message.fact.internalDate)} className="loop-thread__when">
                {time.dateTime(message.fact.internalDate)}
              </time>
            </p>
            <p className="loop-thread__to muted">
              to {message.fact.to.map((a) => a.name?.trim() || a.address).join(', ') || 'nobody recorded'}
              {message.fact.cc.length > 0 ? ` · cc ${message.fact.cc.map((a) => a.name?.trim() || a.address).join(', ')}` : ''}
            </p>
            {body ? (
              <p className="loop-thread__body">{body}</p>
            ) : (
              <p className="loop-thread__body muted">This message has no text Loop can show — it may be an image or an attachment only.</p>
            )}
            {quotedLines > 0 ? <p className="loop-thread__quoted muted">Earlier messages quoted below are shown above.</p> : null}
            {message.body.attachments.length > 0 ? (
              <ul className="loop-thread__attachments">
                {message.body.attachments.map((attachment, i) => (
                  <li key={`${attachment.filename}-${i}`} className="muted">
                    Attached: {attachment.filename} ({Math.max(1, Math.round(attachment.bytes / 1024))} KB) — open it in Gmail
                  </li>
                ))}
              </ul>
            ) : null}
            {message.body.truncated ? <p className="loop-thread__quoted muted">This message was longer than Loop shows.</p> : null}
          </li>
        );
      })}
    </ol>
  );
}
