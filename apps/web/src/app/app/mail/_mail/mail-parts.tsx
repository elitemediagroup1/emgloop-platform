// The Mail surface's shared parts (GM-2): how current Loop is about a mailbox, and what an empty
// list means. Home and Mail both say these in the same words.
//
// The conversation rows themselves are the Mail dashboard's (./dashboard.tsx).

import type { ReactNode } from 'react';

import type { TimeView, WorkSourceFreshness } from '@emgloop/shared';

import { CONNECTIONS_PATH } from '../../../../auth/landing';
import { StateBlock } from '../../_loop-os/record';

/** How current Loop is about this mailbox, and -- where there is one -- the way back. */
export function mailCurrency(
  freshness: WorkSourceFreshness,
  lastSyncedAt: Date | null,
  syncInProgress: boolean,
  time: TimeView,
): { readonly line: string; readonly href?: string; readonly action?: string } {
  if (syncInProgress && freshness === 'NEVER_SYNCED') return { line: 'Loop is reading your mail for the first time.' };
  if (syncInProgress && (freshness === 'CURRENT' || freshness === 'STALE')) {
    return { line: 'Loop is reading your mail now.' };
  }
  switch (freshness) {
    case 'CURRENT':
      return { line: lastSyncedAt ? `Loop read your mail ${time.relative(lastSyncedAt)}.` : 'Loop read your mail just now.' };
    case 'STALE':
      return { line: `Loop last read your mail ${time.relative(lastSyncedAt!)}.` };
    case 'NEVER_SYNCED':
      // The first read is the scheduled cycle's, never a page's (GmailSyncOptions.reach).
      return { line: 'Loop is setting up your mail. It reads the last two weeks in the background, not while you wait.' };
    case 'SYNC_FAILED':
      return {
        line: lastSyncedAt
          ? `Loop could not reach Gmail just now. This is your mail as Loop last read it, ${time.relative(lastSyncedAt)}.`
          : 'Loop’s first read of your mail did not finish. It tries again in the background.',
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
          title={freshness === 'SYNC_FAILED' ? 'Loop could not read your mail' : 'Loop is setting up your mail'}
          body={
            freshness === 'SYNC_FAILED'
              ? 'Google did not answer Loop’s first read. Nothing is wrong with your mailbox; Loop tries again in the background, and your conversations appear here once a read completes.'
              : 'Your Gmail is connected. Loop reads the last two weeks of it in the background, not while you wait, so it can take a while after you connect. Your conversations appear here once that first read is done.'
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
