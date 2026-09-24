// The Chats page's body: what is happening in the person's own chats, drawn from `chatsIntelligence`.
//
// A WINDOW, NOT A CHAT CLIENT. There is no message body here (Loop keeps none), no composer, and no
// link into Telegram: private Telegram chats have no stable deep link, so a conversation says where
// it lives ("In Telegram") rather than inventing a URL. Connections appears only as setup -- "Connect",
// "Reconnect" -- when nothing is live, and otherwise as the secondary "Manage connection".
//
// SERVER COMPONENT, pure over its props: every honest state is a different block with different words.

import Link from 'next/link';
import type { TimeView } from '@emgloop/shared';

import {
  UNNAMED_CONVERSATION,
  chatsKindLabel,
  type ChatsActivity,
  type ChatsConversation,
  type ChatsIntelligence,
} from '../../../../daily-loop/chats-intelligence';
import { Facts, Panel, StateBlock } from '../../_loop-os/record';

export const CONNECTIONS_HREF = '/app/connections';
/** Where a conversation lives. Not a link: no stable deep link exists. */
const PLACE = 'In Telegram';

function activityWords(activity: ChatsActivity | null): string | null {
  if (activity === null) return null;
  const messages = `${activity.messages} ${activity.messages === 1 ? 'message' : 'messages'}`;
  const conversations = `${activity.conversations} ${activity.conversations === 1 ? 'conversation' : 'conversations'}`;
  return `${messages} across ${conversations}`;
}

function StateLine({ intel }: { intel: ChatsIntelligence }) {
  switch (intel.state) {
    case 'NOT_PERMITTED':
      return <StateBlock kind="denied" title="Chats are not available to you here" body="Your role in this organization does not include connecting a communication source." />;
    case 'NOT_AVAILABLE':
      return (
        <StateBlock
          kind="unavailable"
          title="Chats are not available yet"
          body="This Loop deployment has not been set up to connect Telegram. Nothing is connected, and Loop works without it."
        />
      );
    case 'NOT_CONNECTED':
      return (
        <StateBlock
          kind="empty"
          title="Telegram is not connected"
          body="Connect your own Telegram account and Loop will show here what needs you in your chats. You keep replying in Telegram."
          action={{ label: 'Connect Telegram', href: CONNECTIONS_HREF, primary: true }}
        />
      );
    case 'UNAVAILABLE':
      return (
        <StateBlock
          kind="attention"
          title="Loop cannot use your Telegram connection"
          body="The connection needs attention before Loop can observe your chats again. What it flagged earlier stays below until you clear it."
          action={{ label: 'Reconnect Telegram', href: CONNECTIONS_HREF, primary: true }}
        />
      );
    default:
      return null;
  }
}

function TriageOff() {
  return (
    <StateBlock
      kind="empty"
      title="AI triage is off"
      body="Loop observes who and when in your chats, but flags nothing that needs you until you turn on AI triage for Telegram. That is a separate consent, managed with the connection."
      compact
    />
  );
}

function ConversationRow({ conversation, time }: { conversation: ChatsConversation; time: TimeView }) {
  return (
    <li className="loop-chats__conv" data-chats-conversation>
      <div className="loop-chats__conv-head">
        <span className="loop-chats__label">{conversation.label ?? UNNAMED_CONVERSATION}</span>
        {conversation.hasDeadline ? <span className="loop-pill loop-pill--attention">Deadline</span> : null}
        <span className="loop-chats__place">{PLACE}</span>
      </div>
      <ul className="loop-chats__items">
        {conversation.items.map((item, i) => (
          <li key={`${item.at.getTime()}-${i}`} className="loop-chats__item">
            <span className="loop-chats__kind">{chatsKindLabel(item.category)}</span>
            <div className="loop-chats__what">
              <p className="loop-chats__title">{item.title}</p>
              {item.topic ? <p className="loop-chats__meta">About {item.topic}</p> : null}
              {item.nextStep ? <p className="loop-chats__meta">Next: {item.nextStep}</p> : null}
              {item.deadline ? <p className="loop-chats__meta loop-chats__deadline">Deadline, as the conversation put it: {item.deadline}</p> : null}
            </div>
            <time className="loop-chats__when" dateTime={time.iso(item.at)}>
              {time.relative(item.at)}
            </time>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function ChatsView({ intel, time }: { intel: ChatsIntelligence | 'UNAVAILABLE'; time: TimeView }) {
  if (intel === 'UNAVAILABLE') {
    return (
      <StateBlock
        kind="error"
        title="Loop could not read your chats just now"
        body="Nothing is wrong with your Telegram account. Loop could not read what it knows about it, so it shows nothing rather than an empty list. Try again in a moment."
      />
    );
  }

  const live = intel.state === 'QUIET' || intel.state === 'ACTIVE';
  const triageOff = live && intel.status !== null && intel.status.endsWith('Triage off');

  return (
    <div className="loop-chats" data-chats-state={intel.state}>
      <section className="loop-chats__summary" aria-label="What is happening in your chats">
        {intel.metric ? (
          <p className="loop-chats__metric">
            <b>{intel.metric.value}</b> {intel.metric.label}
          </p>
        ) : null}
        {intel.summary.map((line) => (
          <p key={line} className="loop-chats__line">
            {line}
          </p>
        ))}
      </section>

      {intel.status ? (
        <p className="loop-chats__status" data-chats-status>
          <span>{intel.status}</span>
          {live || intel.state === 'NOT_AVAILABLE' ? (
            <Link className="loop-link" href={CONNECTIONS_HREF}>
              Manage connection
            </Link>
          ) : null}
        </p>
      ) : null}

      <StateLine intel={intel} />
      {triageOff ? <TriageOff /> : null}
      {live && !triageOff && intel.conversations.length === 0 ? (
        <StateBlock kind="empty" title="Nothing in your chats needs you" body="Loop has flagged no unresolved obligation for you. It keeps observing, and anything new appears here and on Home." compact />
      ) : null}

      {intel.conversations.length > 0 ? (
        <Panel title="Conversations that need you" lead="Grouped by the name Telegram shows for each conversation, most pressing first. Reply in Telegram itself.">
          <ul className="loop-chats__list">
            {intel.conversations.map((c, i) => (
              <ConversationRow key={`${c.label ?? 'unnamed'}-${i}`} conversation={c} time={time} />
            ))}
          </ul>
        </Panel>
      ) : null}

      {live ? (
        <Panel title="Activity" lead="Who and when only: counts from what Loop observed, never message contents.">
          <Facts
            rows={[
              { label: 'Since yesterday', value: activityWords(intel.activity24h), unknownText: 'Could not be read' },
              { label: 'In the last 7 days', value: activityWords(intel.activity7d), unknownText: 'Could not be read' },
            ]}
          />
        </Panel>
      ) : null}
    </div>
  );
}
