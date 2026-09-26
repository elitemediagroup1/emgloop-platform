// The Chats page's body: what Loop understands about the person's own chats, drawn from
// `composeChatsIntelligence` -- the same composition Home's Chats tile shows at its shallowest depth.
//
// IN THIS ORDER, AND KEPT APART:
//   1. What Loop understands -- the composed statement and the business-conversation figure;
//   1b. What needs whom (Chats v5) -- the groups: needs your attention, needs team attention, waiting
//      on others, decisions pending, open, gone quiet, important developments. An ITEM (raised by the
//      triage; Work OS state) carries the person's own actions -- handled, not mine, not now -- and an
//      evidence drill-down that is content-free (what kind, from which conversation, when read);
//      a SIGNAL is part of Loop's reading and says whether it was observed or inferred;
//   2. Conversation intelligence -- Loop's INTERPRETATION of each conversation, one digest's own
//      fields, labelled as interpretation, with its confidence, how current it is (the governed
//      coverage words) and, per list, what it rests on (`DIGEST_FIELD_KNOWLEDGE`);
//   3. What you owe -- the viewer's own obligations (Work OS), visually distinct from the reading;
//   4. Coverage and connection -- how current the reading is, content-free activity, and the
//      connection, with Connections as the setup/manage link only.
//
// A WINDOW, NOT A CHAT CLIENT. There is no message body here (Loop keeps none), no composer, and no
// link into Telegram: private Telegram chats have no stable deep link, so a conversation says where
// it lives ("In Telegram") rather than inventing a URL. A conversation is named by Telegram's own
// label or said to be one Loop could not name -- never by a key.
//
// SERVER COMPONENT, pure over its props: every honest state is a different block with different words.

import Link from 'next/link';
import type { ReactNode } from 'react';
import { DIGEST_FIELD_KNOWLEDGE, type DigestKnowledge, type TimeView } from '@emgloop/shared';

import {
  UNNAMED_CONVERSATION,
  chatsKindLabel,
  type ChatsActivity,
  type ChatsConversation,
  type ChatsConversationCard,
  type ChatsEntry,
  type ChatsGroup,
  type ChatsIntelligence,
} from '../../../../daily-loop/chats-intelligence';
import { chatsDismissAction, chatsHandledAction, chatsSnoozeAction } from '../actions';
import { promoteHref } from '../../../../work/promote-origin';
import { LabelBadge } from '../../_loop-os/product-state';
import { Facts, Panel, StateBlock } from '../../_loop-os/record';

export const CONNECTIONS_HREF = '/app/connections';
/** Where a conversation lives. Not a link: no stable deep link exists. */
const PLACE = 'In Telegram';

function activityWords(activity: ChatsActivity | null): string | null {
  if (activity === null) return null;
  const messages = `${activity.messages} ${activity.messages === 1 ? 'message' : 'messages'}`;
  const conversations = `${activity.conversations} active ${activity.conversations === 1 ? 'conversation' : 'conversations'}`;
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
          body="Connect your own Telegram account and Loop will show here what it understands about your chats. You keep replying in Telegram."
          action={{ label: 'Connect Telegram', href: CONNECTIONS_HREF, primary: true }}
        />
      );
    case 'CONSENT_OFF':
      return (
        <StateBlock
          kind="empty"
          title="AI triage is off"
          body="Loop observes who and when in your chats, but reads no content — so it has no reading of any conversation and flags nothing — until you turn on AI triage for Telegram. That is a separate consent, managed with the connection."
          action={{ label: 'Turn on AI triage', href: CONNECTIONS_HREF, primary: true }}
        />
      );
    case 'UNAVAILABLE':
      return intel.unavailable === 'CONNECTION' ? (
        <StateBlock
          kind="attention"
          title="Loop cannot use your Telegram connection"
          body="The connection needs attention before Loop can read your chats again. What Loop read and flagged earlier stays below, marked as not current."
          action={{ label: 'Reconnect Telegram', href: CONNECTIONS_HREF, primary: true }}
        />
      ) : (
        <StateBlock
          kind="error"
          title="Loop could not read its Chats intelligence just now"
          body="This is a failure to read, not a finding: it does not mean nothing is happening in your chats. What you owe is still listed below. Try again in a moment."
        />
      );
    case 'NO_INTELLIGENCE_YET':
      return (
        <StateBlock
          kind="empty"
          title="No conversation has a reading yet"
          body="Loop writes its reading of a conversation after new messages arrive there. Conversations that have been quiet since then have none yet, which does not mean nothing is happening in them."
          compact
        />
      );
    default:
      return null;
  }
}

/**
 * What a field KNOWS, from the digest contract (`DIGEST_FIELD_KNOWLEDGE`): what the conversation itself
 * said, or Loop's reading of the whole. Said beside every list so an inference never reads as a quote.
 */
const basisWords = (k: DigestKnowledge) => (k === 'OBSERVED' ? 'as the conversation said it' : 'Loop’s reading');

function ReadingList({ title, items, basis }: { title: string; items: readonly string[]; basis: DigestKnowledge }) {
  if (items.length === 0) return null;
  return (
    <div className="loop-chats__reading" data-chats-reading={title} data-chats-basis={basis}>
      <p className="loop-chats__reading-title">
        {title} <span className="loop-chats__reading-basis">· {basisWords(basis)}</span>
      </p>
      <ul className="loop-chats__reading-list">
        {items.map((line, i) => (
          <li key={`${i}-${line}`}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

const ENTRY_BASIS: Readonly<Record<ChatsEntry['basis'], string>> = Object.freeze({
  RAISED: 'Flagged from the conversation',
  OBSERVED: 'As the conversation said it',
  INFERRED: 'Loop’s reading',
});

function EntryActions({ entry }: { entry: ChatsEntry }) {
  if (!entry.itemId) return null;
  return (
    <div className="loop-chats__actions loop-btnrow" data-chats-actions>
      <form action={chatsHandledAction}>
        <input type="hidden" name="itemId" value={entry.itemId} />
        <button type="submit" className="loop-btn">Handled</button>
      </form>
      <form action={chatsSnoozeAction}>
        <input type="hidden" name="itemId" value={entry.itemId} />
        <input type="hidden" name="hours" value="24" />
        <button type="submit" className="loop-btn loop-btn--quiet">Not now</button>
      </form>
      <form action={chatsDismissAction}>
        <input type="hidden" name="itemId" value={entry.itemId} />
        <button type="submit" className="loop-btn loop-btn--quiet">Not mine</button>
      </form>
    </div>
  );
}

function GroupEntry({ entry, time }: { entry: ChatsEntry; time: TimeView }) {
  return (
    <li className="loop-chats__entry" data-chats-entry={entry.source} data-chats-entry-basis={entry.basis}>
      <div className="loop-chats__conv-head">
        <span className="loop-chats__label">{entry.conversation ?? UNNAMED_CONVERSATION}</span>
        {entry.who ? <span className="loop-pill">Waiting on {entry.who}</span> : null}
        {entry.severity === 'HIGH' ? <span className="loop-pill loop-pill--attention">Pressing</span> : null}
        <span className="loop-chats__place">{PLACE}</span>
      </div>
      <p className="loop-chats__title">{entry.statement}</p>
      {entry.nextStep ? <p className="loop-chats__meta">Next: {entry.nextStep}</p> : null}
      {entry.deadline ? <p className="loop-chats__meta loop-chats__deadline">Deadline, as the conversation put it: {entry.deadline}</p> : null}
      {entry.facts.length > 0 ? <p className="loop-chats__meta" data-chats-facts>{entry.facts.join(' · ')}</p> : null}
      <details className="loop-chats__evidence">
        <summary>Why Loop shows this</summary>
        <p className="loop-chats__meta">
          {ENTRY_BASIS[entry.basis]} · {entry.source === 'ITEM' ? chatsKindLabel(entry.evidence.kind) : entry.evidence.kind.replace(/_/g, ' ').toLowerCase()}
          {entry.evidence.readAt ? (
            <>
              {' · read '}
              <time dateTime={time.iso(entry.evidence.readAt)}>{time.relative(entry.evidence.readAt)}</time>
            </>
          ) : null}
          {entry.evidence.asCurrent ? '' : ' · not current'}
        </p>
        <p className="loop-chats__meta">Loop keeps no message text. The conversation itself is in Telegram.</p>
      </details>
      <EntryActions entry={entry} />
      {entry.promote ? (
        <p className="loop-chats__meta">
          <Link className="loop-link" href={promoteHref('/app/chats', entry.promote)} data-chats-promote>
            Promote to Work
          </Link>
        </p>
      ) : null}
    </li>
  );
}

function Groups({ groups, time }: { groups: readonly ChatsGroup[]; time: TimeView }) {
  if (groups.length === 0) return null;
  return (
    <section className="loop-chats__groups" aria-label="What needs whom" data-chats-groups>
      {groups.map((g) => (
        <div key={g.key} className="loop-chats__group" data-chats-group={g.key}>
          <h2 className="loop-panel__title">{g.title}</h2>
          <ul className="loop-chats__list">
            {g.entries.map((e) => (
              <GroupEntry key={e.key} entry={e} time={time} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

const confidenceWords = (c: NonNullable<ChatsConversationCard['confidence']>) => `${c.charAt(0)}${c.slice(1).toLowerCase()} confidence`;

function ConversationCard({ card, time }: { card: ChatsConversationCard; time: TimeView }) {
  return (
    <li className="loop-chats__card" data-chats-card data-chats-card-coverage={card.coverage}>
      <div className="loop-chats__conv-head">
        <span className="loop-chats__label">{card.label ?? UNNAMED_CONVERSATION}</span>
        {card.relevance !== 'BUSINESS' ? <span className="loop-pill">Business relevance unclear</span> : null}
        {card.flags.map((a) => (
          <span key={a} className="loop-pill loop-pill--attention">
            {a}
          </span>
        ))}
        <span className="loop-chats__place">{PLACE}</span>
      </div>
      <p className="loop-chats__basis">
        <span>Loop’s interpretation</span>
        {card.confidence ? <span data-chats-confidence>{confidenceWords(card.confidence)}</span> : null}
        <LabelBadge label={card.coverageLabel} />
        <span>
          {card.asCurrent ? 'Read ' : 'As of '}
          <time dateTime={time.iso(card.generatedAt)}>{time.relative(card.generatedAt)}</time>
        </span>
      </p>
      {card.synthesis ? <p className="loop-chats__synthesis">{card.synthesis}</p> : null}
      {card.attention ? (
        <p className="loop-chats__meta loop-chats__attention" data-chats-attention>
          Why it needs you now: {card.attention}
        </p>
      ) : null}
      {card.stateChange ? <p className="loop-chats__meta">What changed: {card.stateChange}</p> : null}
      <ReadingList title="Developments" items={card.developments} basis={DIGEST_FIELD_KNOWLEDGE.developments} />
      <ReadingList title="Commitments and decisions" items={card.commitments} basis={DIGEST_FIELD_KNOWLEDGE.commitments} />
      <ReadingList title="Opportunities" items={card.opportunities} basis={DIGEST_FIELD_KNOWLEDGE.opportunities} />
      <ReadingList title="Concerns" items={card.concerns} basis={DIGEST_FIELD_KNOWLEDGE.concerns} />
      <ReadingList title="Operational" items={card.operational} basis={DIGEST_FIELD_KNOWLEDGE.operational} />
      <ReadingList title="Unresolved" items={card.unresolved} basis={DIGEST_FIELD_KNOWLEDGE.unresolved} />
      {card.topics.length > 0 ? <p className="loop-chats__meta">About {card.topics.join(', ')}</p> : null}
      {card.limitations.length > 0 ? <p className="loop-chats__meta">What Loop could not see or conclude: {card.limitations.join('; ')}</p> : null}
    </li>
  );
}

function ObligationRow({ conversation, time }: { conversation: ChatsConversation; time: TimeView }) {
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

export function ChatsView({ intel, time, promote = null }: { intel: ChatsIntelligence | 'UNAVAILABLE'; time: TimeView; promote?: ReactNode }) {
  if (intel === 'UNAVAILABLE') {
    return (
      <StateBlock
        kind="error"
        title="Loop could not read your chats just now"
        body="Nothing is wrong with your Telegram account. Loop could not read what it knows about it, so it shows nothing rather than an empty list. Try again in a moment."
      />
    );
  }

  const connected = intel.state !== 'NOT_PERMITTED' && intel.state !== 'NOT_AVAILABLE' && intel.state !== 'NOT_CONNECTED' && !(intel.state === 'UNAVAILABLE' && intel.unavailable === 'CONNECTION');

  return (
    <div className="loop-chats" data-chats-state={intel.state}>
      <section className="loop-chats__summary" aria-label="What Loop understands">
        {intel.metric ? (
          <p className="loop-chats__metric">
            <b>{intel.metric.value}</b> {intel.metric.label}
          </p>
        ) : null}
        {intel.headline.map((line, i) => (
          <p key={line} className="loop-chats__line" data-chats-statement={i === 0 ? '' : undefined}>
            {line}
          </p>
        ))}
      </section>

      <StateLine intel={intel} />

      {promote}

      <Groups groups={intel.groups} time={time} />

      {intel.conversations.length > 0 || intel.notBusiness > 0 ? (
        <Panel
          title="Conversation intelligence"
          lead="Loop’s interpretation of each business conversation, from what it read: a reading, not a fact. Each says how confident Loop is and how current the reading is."
        >
          {intel.conversations.length > 0 ? (
            <ul className="loop-chats__list">
              {intel.conversations.map((card) => (
                <ConversationCard key={card.key} card={card} time={time} />
              ))}
            </ul>
          ) : null}
          {intel.notBusiness > 0 ? (
            <p className="loop-chats__meta" data-chats-not-business>
              {intel.notBusiness === 1 ? '1 conversation Loop read as not business is not shown.' : `${intel.notBusiness} conversations Loop read as not business are not shown.`}
            </p>
          ) : null}
        </Panel>
      ) : null}

      {intel.obligations.length > 0 ? (
        <section className="loop-chats__owe" aria-label="What you owe" data-chats-owe>
          <h2 className="loop-panel__title">What you owe</h2>
          <p className="loop-panel__lead">Your own open items from these chats, kept with your work and separate from Loop’s interpretation above. Reply in Telegram itself.</p>
          {intel.owed ? <p className="loop-chats__line">{intel.owed}</p> : null}
          <ul className="loop-chats__list">
            {intel.obligations.map((c, i) => (
              <ObligationRow key={`${c.label ?? 'unnamed'}-${i}`} conversation={c} time={time} />
            ))}
          </ul>
        </section>
      ) : connected && intel.state !== 'CONSENT_OFF' ? (
        <StateBlock kind="empty" title="Nothing in your chats is flagged for you" body="Loop has flagged no open obligation for you. It keeps observing, and anything new appears here and on Home." compact />
      ) : null}

      {intel.status ? (
        <Panel title="Coverage and connection" lead="How current Loop’s reading is, and what it observed: who and when only, never message contents.">
          <Facts
            rows={[
              ...(connected
                ? [
                    { label: 'Loop’s reading', value: intel.coverage.words, unknownText: 'No reading yet' },
                    {
                      label: 'Last generated',
                      value: intel.coverage.latestGeneratedAt ? <time dateTime={time.iso(intel.coverage.latestGeneratedAt)}>{time.relative(intel.coverage.latestGeneratedAt)}</time> : null,
                      unknownText: 'Never',
                    },
                    { label: 'Since yesterday', value: activityWords(intel.activity24h), unknownText: 'Could not be read' },
                    { label: 'In the last 7 days', value: activityWords(intel.activity7d), unknownText: 'Could not be read' },
                  ]
                : []),
              { label: 'Connection', value: intel.status },
            ]}
          />
          {connected || intel.state === 'NOT_AVAILABLE' ? (
            <p className="loop-chats__status" data-chats-status>
              <Link className="loop-link" href={CONNECTIONS_HREF}>
                Manage connection
              </Link>
            </p>
          ) : null}
        </Panel>
      ) : null}
    </div>
  );
}
