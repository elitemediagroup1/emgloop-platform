// The Mail surface's parts (GM-2).
//
// Drawn with the Loop design system's primitives and its existing classes. It is NOT a Gmail
// clone: no label sidebar, no bulk selection, no starring, no folders. It is the list an employee
// scans to find what needs them, and the conversation they answer.
//
// EVERY LINE IS A STORED FACT. Who wrote, when, how many messages, whether the newest is unread,
// which way it went. Nothing here states what a conversation is about or whether it matters --
// that is GM-3's job, and it arrives with its evidence.

import Link from 'next/link';
import type { ReactNode } from 'react';

import type { TimeView, WorkSourceFreshness } from '@emgloop/shared';

import { CONNECTIONS_PATH } from '../../../../auth/landing';
import type { MailCorrespondent, MailThreadSummary } from '../../../../daily-loop/mail';
import { StateBlock } from '../../_loop-os/record';

/** How current Loop is about this mailbox, and -- where there is one -- the way back. */
export function mailCurrency(
  freshness: WorkSourceFreshness,
  lastSyncedAt: Date | null,
  syncInProgress: boolean,
  time: TimeView,
): { readonly line: string; readonly href?: string; readonly action?: string } {
  if (syncInProgress && (freshness === 'CURRENT' || freshness === 'STALE' || freshness === 'NEVER_SYNCED')) {
    return { line: 'Loop is reading your mail now.' };
  }
  switch (freshness) {
    case 'CURRENT':
      return { line: lastSyncedAt ? `Loop read your mail ${time.relative(lastSyncedAt)}.` : 'Loop read your mail just now.' };
    case 'STALE':
      return { line: `Loop last read your mail ${time.relative(lastSyncedAt!)}.` };
    case 'NEVER_SYNCED':
      return { line: 'Loop has not read your mail yet.' };
    case 'SYNC_FAILED':
      return {
        line: lastSyncedAt
          ? `Loop could not reach Gmail just now. This is your mail as Loop last read it, ${time.relative(lastSyncedAt)}.`
          : 'Loop could not reach Gmail, and has not read your mail yet.',
      };
    case 'AUTHORIZATION_EXPIRED':
      return { line: 'Google no longer accepts this connection. Reconnect to read your mail.', href: CONNECTIONS_PATH, action: 'Reconnect' };
    case 'CAPABILITY_NOT_GRANTED':
      return {
        line: 'Loop needs your permission to read and send mail. Reconnect Google to grant it.',
        href: CONNECTIONS_PATH,
        action: 'Reconnect Google',
      };
    default:
      return { line: 'Connect your Google account and Loop will show your mail.', href: CONNECTIONS_PATH, action: 'Connect Google' };
  }
}

/** Who is on a conversation, named the way a person would name them. */
export function peopleLine(people: readonly MailCorrespondent[]): string {
  const names = people.map((p) => p.name?.trim() || p.address);
  if (names.length === 0) return 'No correspondents recorded';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`;
}

export function ThreadRow({ thread, time }: { thread: MailThreadSummary; time: TimeView }) {
  return (
    <li className={'loop-mail__row' + (thread.unread ? ' loop-mail__row--unread' : '')}>
      <Link href={`/app/mail/${encodeURIComponent(thread.threadId)}`} className="loop-mail__link">
        <span className="loop-mail__who">
          {thread.unread ? <span className="loop-mail__unread" aria-label="Unread" /> : null}
          {peopleLine(thread.people)}
        </span>
        <span className="loop-mail__subject">
          {thread.subject?.trim() || 'No subject'}
          {thread.messageCount > 1 ? <span className="muted"> · {thread.messageCount} messages</span> : null}
          {thread.hasDraft ? <span className="loop-mail__tag">Draft</span> : null}
        </span>
        <span className="loop-mail__when">
          {thread.lastMessageAt ? <time dateTime={time.iso(thread.lastMessageAt)}>{time.relative(thread.lastMessageAt)}</time> : '—'}
        </span>
      </Link>
    </li>
  );
}

/** What an empty list means, which depends entirely on whether Loop could look. */
export function MailEmpty({ freshness, knows, refresh }: { freshness: WorkSourceFreshness; knows: boolean; refresh?: ReactNode }) {
  if (knows) {
    return (
      <>
        <StateBlock
          kind="empty"
          title="Nothing in the last two weeks"
          body="Loop read your mail and found no conversations in the window it keeps. Mail you receive from now on will appear here."
          compact
        />
        {refresh ?? null}
      </>
    );
  }
  if (freshness === 'NEVER_SYNCED' || freshness === 'SYNC_FAILED') {
    return (
      <>
        <StateBlock
          kind={freshness === 'SYNC_FAILED' ? 'attention' : 'empty'}
          title={freshness === 'SYNC_FAILED' ? 'Loop could not read your mail' : 'Loop has not read your mail yet'}
          body={
            freshness === 'SYNC_FAILED'
              ? 'Google did not answer the last attempt. Nothing is wrong with your mailbox; Loop simply has nothing to show from it yet.'
              : 'Your Google account is connected. Loop reads your mail when you open Loop, and the first read can take a moment.'
          }
          compact
        />
        {refresh ?? null}
      </>
    );
  }
  return (
    <StateBlock
      kind={freshness === 'AUTHORIZATION_EXPIRED' ? 'attention' : 'empty'}
      title={freshness === 'AUTHORIZATION_EXPIRED' ? 'Your Google connection needs attention' : 'Your mail is not connected'}
      body="Loop shows your own Gmail, and only yours. Nobody else in your organization can see it."
      action={{ label: 'Connections', href: CONNECTIONS_PATH }}
      compact
    />
  );
}
