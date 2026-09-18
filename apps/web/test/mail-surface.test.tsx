// MAIL: what an employee sees, what they can do, and what no request can make it do.
//
// Renders the real components with prepared views (renderToStaticMarkup + markup assertions),
// plus source assertions for the guarantees that are properties of the code rather than of one
// render -- above all the one this milestone rests on: nothing generated can send.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { createTimeView, type GmailThreadMessage } from '@emgloop/shared';

import { Composer } from '../src/app/app/mail/_mail/composer';
import { Conversation } from '../src/app/app/mail/_mail/conversation';
import { MailEmpty, ThreadRow, mailCurrency, peopleLine } from '../src/app/app/mail/_mail/mail-parts';
import type { MailThreadSummary } from '../src/daily-loop/mail';
import type { MailAttentionItem, MailAttentionView } from '../src/daily-loop/mail-attention';
import { YourMail } from '../src/app/app/_home/your-mail';

const NY = { timeZone: 'America/New_York', source: 'device' as const };
const NOW = new Date('2026-09-18T16:00:00Z');
const time = createTimeView(NY, NOW);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

function thread(over: Partial<MailThreadSummary> = {}): MailThreadSummary {
  return {
    threadId: 't1',
    subject: 'Cashion pricing',
    lastMessageAt: new Date('2026-09-18T15:30:00Z'),
    messageCount: 3,
    unread: true,
    lastDirection: 'INBOUND',
    people: [{ address: 'ben@cashion.example', name: 'Ben Cashion' }],
    hasDraft: false,
    sendUnconfirmed: false,
    ...over,
  };
}

function message(over: { text?: string | null; html?: string | null; from?: string; mine?: boolean; attachments?: { filename: string; mimeType: string; bytes: number }[] } = {}): GmailThreadMessage {
  return {
    fact: {
      provider: 'GOOGLE',
      messageId: 'm1',
      threadId: 't1',
      internalDate: new Date('2026-09-18T15:30:00Z'),
      labels: ['INBOX'],
      from: { address: over.from ?? 'ben@cashion.example', name: 'Ben Cashion' },
      to: [{ address: 'matt@elitemediagroup.io', name: null }],
      cc: [],
      subject: 'Cashion pricing',
      headerMessageId: '<m1@mail.gmail.com>',
      inReplyTo: null,
      references: [],
      fromSelf: over.mine ?? false,
    },
    body: {
      messageId: 'm1',
      text: over.text === undefined ? 'Pricing is still open.' : over.text,
      html: over.html ?? null,
      attachments: over.attachments ?? [],
      truncated: false,
    },
  };
}

describe('the inbox shows conversations, and says how current it is', () => {
  it('lists who wrote, what about, when, and whether it is unread', () => {
    const html = renderToStaticMarkup(<ThreadRow thread={thread()} time={time} />);
    assert.match(html, /Ben Cashion/);
    assert.match(html, /Cashion pricing/);
    assert.match(html, /3 messages/);
    assert.match(html, /loop-mail__row--unread/);
    assert.match(html, /href="\/app\/mail\/t1"/);
    assert.match(html, /datetime="2026-09-18T15:30:00\.000Z"/i);

    const read = renderToStaticMarkup(<ThreadRow thread={thread({ unread: false, hasDraft: true })} time={time} />);
    assert.equal(read.includes('loop-mail__row--unread'), false);
    assert.match(read, /Draft/);

    // A reply whose delivery Loop could not confirm is flagged in the list, not buried in the thread.
    const unconfirmed = renderToStaticMarkup(<ThreadRow thread={thread({ sendUnconfirmed: true })} time={time} />);
    assert.match(unconfirmed, /Delivery unconfirmed/);
    assert.match(unconfirmed, /loop-mail__tag--attention/);
    assert.equal(html.includes('Delivery unconfirmed'), false);
  });

  it('names people the way a person would, and says so honestly when it cannot', () => {
    assert.equal(peopleLine([{ address: 'ben@cashion.example', name: 'Ben Cashion' }]), 'Ben Cashion');
    assert.equal(peopleLine([{ address: 'ben@cashion.example', name: null }]), 'ben@cashion.example');
    assert.equal(peopleLine([]), 'No correspondents recorded');
    const many = ['a', 'b', 'c', 'd'].map((n) => ({ address: `${n}@x.example`, name: n }));
    assert.equal(peopleLine(many), 'a, b and 2 others');
  });

  it('never presents stored mail as a fresh read, and offers the way back where there is one', () => {
    const at = new Date('2026-09-18T15:00:00Z');
    assert.match(mailCurrency('CURRENT', at, false, time).line, /Loop read your mail/);
    assert.match(mailCurrency('STALE', at, false, time).line, /Loop last read your mail/);
    assert.match(mailCurrency('NEVER_SYNCED', null, false, time).line, /has not read your mail yet/);
    assert.match(mailCurrency('SYNC_FAILED', at, false, time).line, /as Loop last read it/);
    assert.match(mailCurrency('SYNC_FAILED', null, false, time).line, /could not reach Gmail/);
    // A sync in flight is its own state, not a guess at how old the data is.
    assert.match(mailCurrency('STALE', at, true, time).line, /reading your mail now/);

    const expired = mailCurrency('AUTHORIZATION_EXPIRED', at, false, time);
    assert.match(expired.line, /no longer accepts this connection/);
    assert.equal(expired.href, '/app/connections');
    const scope = mailCurrency('CAPABILITY_NOT_GRANTED', null, false, time);
    assert.match(scope.line, /needs your permission to read and send mail/);
    assert.equal(scope.action, 'Reconnect Google');
  });

  it('an empty inbox and an unreadable one never look alike', () => {
    const empty = renderToStaticMarkup(<MailEmpty freshness="CURRENT" knows />);
    assert.match(empty, /Nothing in the last two weeks/);

    const never = renderToStaticMarkup(<MailEmpty freshness="NEVER_SYNCED" knows={false} />);
    assert.match(never, /has not read your mail yet/);
    assert.equal(never.includes('Nothing in the last two weeks'), false);

    const failed = renderToStaticMarkup(<MailEmpty freshness="SYNC_FAILED" knows={false} />);
    assert.match(failed, /could not read your mail/);
    assert.equal(failed.includes('Nothing in the last two weeks'), false);

    const disconnected = renderToStaticMarkup(<MailEmpty freshness="NOT_CONNECTED" knows={false} />);
    assert.match(disconnected, /not connected/);
    assert.match(disconnected, /Nobody else in your organization can see it/);
  });
});

describe('a conversation is rendered as text, and can never be rendered as markup', () => {
  it('shows each message, who sent it and when, oldest first', () => {
    const html = renderToStaticMarkup(
      <Conversation
        messages={[message(), message({ mine: true, from: 'matt@elitemediagroup.io', text: 'Thanks -- sending now.' })]}
        selfAddress="matt@elitemediagroup.io"
        time={time}
      />,
    );
    assert.match(html, /Ben Cashion/);
    assert.match(html, /Pricing is still open\./);
    assert.match(html, /You<\/span>/, 'the employee is "You", not their own address');
    assert.match(html, /loop-thread__message--mine/);
    assert.match(html, /to matt@elitemediagroup\.io/);
  });

  it('renders hostile HTML as inert text, with no script, handler, iframe or remote image', () => {
    const hostile = '<p>Hello</p><script>alert(document.cookie)</script><img src="https://tracker.example/x.gif"><a href="javascript:alert(1)">x</a>';
    const html = renderToStaticMarkup(<Conversation messages={[message({ text: null, html: hostile })]} selfAddress={null} time={time} />);
    assert.equal(html.includes('<script'), false);
    assert.equal(html.includes('alert(document.cookie)'), false, 'not even as escaped source');
    assert.equal(html.includes('<iframe'), false);
    assert.equal(html.includes('tracker.example'), false, 'no tracking pixel is ever loaded');
    assert.equal(html.includes('javascript:'), false);
    assert.match(html, /Hello/);

    // The same in a plain-text part: text that LOOKS like markup stays text.
    const escaped = renderToStaticMarkup(<Conversation messages={[message({ text: '<script>alert(1)</script>' })]} selfAddress={null} time={time} />);
    assert.equal(escaped.includes('<script>alert(1)</script>'), false);
    assert.match(escaped, /&lt;script&gt;/);
  });

  it('says honestly when a message has no words, and names attachments without fetching them', () => {
    const none = renderToStaticMarkup(<Conversation messages={[message({ text: null, html: null })]} selfAddress={null} time={time} />);
    assert.match(none, /no text Loop can show/);

    const attached = renderToStaticMarkup(
      <Conversation messages={[message({ attachments: [{ filename: 'rates.pdf', mimeType: 'application/pdf', bytes: 81_234 }] })]} selfAddress={null} time={time} />,
    );
    assert.match(attached, /rates\.pdf/);
    assert.match(attached, /open it in Gmail/);
    assert.equal(/href="[^"]*rates\.pdf/.test(attached), false, 'Loop offers no download of somebody’s attachment');
  });
});

describe('the composer is one box, and only a person can send from it', () => {
  const props = {
    threadId: 't1',
    inReplyToMessageId: 'm1',
    replyTo: [{ address: 'ben@cashion.example', name: 'Ben Cashion' }],
    replyAllCc: [{ address: 'trevon@cashion.example', name: null }],
    canSend: true,
  };

  it('opens addressed to the author, with Reply and Reply all as the employee’s choice', () => {
    const html = renderToStaticMarkup(<Composer {...props} draft={null} />);
    assert.match(html, /value="ben@cashion\.example"/);
    // Reply is the default; Reply all is offered and not chosen for them.
    assert.match(html, /name="mode" checked="" value="REPLY"/);
    assert.match(html, /name="mode" value="REPLY_ALL"/);
    assert.match(html, /<textarea[^>]*name="body"/);
    assert.match(html, /Send reply/);
    assert.match(html, /Save draft/);
    assert.match(html, /Loop never sends mail on its own/);
  });

  it('reopens what was written, and says when Loop wrote the first version', () => {
    const draft = {
      body: 'Here is the revised number.',
      mode: 'REPLY_ALL' as const,
      to: ['ben@cashion.example'],
      cc: ['trevon@cashion.example'],
      source: 'AI_PROPOSED' as const,
      aiUnedited: true,
      sendFailureClass: null,
      sentAt: null,
    };
    const html = renderToStaticMarkup(<Composer {...props} draft={draft} />);
    assert.match(html, /Here is the revised number\./, 'the words survive navigation');
    assert.match(html, /name="mode" checked="" value="REPLY_ALL"/);
    assert.match(html, /Loop drafted this\./);
    assert.match(html, /send it yourself/);
    assert.match(html, /Discard/);

    // Once edited, Loop stops claiming it is a proposal.
    const edited = renderToStaticMarkup(<Composer {...props} draft={{ ...draft, aiUnedited: false }} />);
    assert.match(edited, /You have edited it since/);
  });

  it('says a send failed without losing the words, and hides Send from somebody who may not', () => {
    const failed = renderToStaticMarkup(
      <Composer {...props} draft={{ body: 'keep me', mode: 'REPLY', to: [], cc: [], source: 'MANUAL', aiUnedited: false, sendFailureClass: 'RATE_LIMITED', sentAt: null }} />,
    );
    assert.match(failed, /was not sent/);
    assert.match(failed, /rate limited/);
    assert.match(failed, /keep me/);
    assert.match(failed, /role="alert"/);

    const cannot = renderToStaticMarkup(<Composer {...props} draft={null} canSend={false} />);
    assert.equal(cannot.includes('Send reply'), false);
    assert.match(cannot, /do not have permission to send mail/);
  });
});

describe('a reply in flight or in doubt cannot be sent again from the composer', () => {
  const props = {
    threadId: 't1',
    inReplyToMessageId: 'm1',
    replyTo: [{ address: 'ben@cashion.example', name: 'Ben Cashion' }],
    replyAllCc: [],
    canSend: true,
    aiDraft: <button type="button">Draft with Loop</button>,
    now: NOW,
  };
  const attempt = (sendState: 'SENDING' | 'SEND_UNKNOWN', startedSecondsAgo: number) => ({
    body: 'Pricing attached.',
    mode: 'REPLY' as const,
    to: ['ben@cashion.example'],
    cc: [],
    source: 'MANUAL' as const,
    aiUnedited: false,
    sendFailureClass: sendState === 'SEND_UNKNOWN' ? 'TIMEOUT' : null,
    sentAt: null,
    sendState,
    sendAttemptStartedAt: new Date(NOW.getTime() - startedSecondsAgo * 1000),
    sendResolution: null,
  });
  const frozen = (html: string) => {
    for (const control of ['Send reply', 'Save draft', 'Discard', 'Draft with Loop']) {
      assert.equal(html.includes(control), false, `${control} is offered while the reply is in doubt`);
    }
    assert.match(html, /<textarea[^>]*readOnly=""[^>]*>Pricing attached\.<\/textarea>|<textarea[^>]*readonly=""/i, 'the words are shown, and frozen');
    assert.match(html, /name="to"[^>]*readOnly=""|readOnly=""[^>]*name="to"/i);
    assert.equal((html.match(/type="radio"[^>]*disabled=""/g) ?? []).length, 2);
  };

  it('while sending: says so, keeps the words, and offers nothing to press', () => {
    const html = renderToStaticMarkup(<Composer {...props} draft={attempt('SENDING', 5)} />);
    assert.match(html, /Sending…/);
    assert.match(html, /will not be sent twice/);
    assert.match(html, /role="status"/);
    frozen(html);
  });

  it('in doubt: says Loop is checking Gmail, offers a check -- and a release only once it cannot still be running', () => {
    const early = renderToStaticMarkup(<Composer {...props} draft={attempt('SEND_UNKNOWN', 30)} />);
    assert.match(early, /could not confirm whether this reply was delivered/);
    assert.match(early, /will not be sent again automatically/);
    assert.match(early, /Check Gmail again/);
    assert.equal(early.includes('it was not sent'), false, 'no release while the attempt could still be in flight');
    assert.match(early, /role="alert"/);
    frozen(early);

    const later = renderToStaticMarkup(<Composer {...props} draft={attempt('SEND_UNKNOWN', 180)} />);
    assert.match(later, /Check Gmail again/);
    assert.match(later, /I checked Sent — it was not sent/);
    frozen(later);
  });

  it('proven undelivered: says Loop checked, keeps the words, and offers Send again', () => {
    const html = renderToStaticMarkup(
      <Composer {...props} draft={{ ...attempt('SENDING', 0), sendState: 'DRAFT', sendAttemptStartedAt: null, sendFailureClass: 'NOT_DELIVERED', sendResolution: 'RECONCILED_NOT_SENT' }} />,
    );
    assert.match(html, /Loop checked your Gmail and this reply was never delivered/);
    assert.match(html, /Pricing attached\./);
    assert.match(html, /Send reply/);
    assert.equal(/readOnly=""/i.test(html), false);
  });
});

describe('nothing in the mail surface can send on its own, or be aimed at anybody else', () => {
  it('the send action requires the send authority, and takes only a stored draft', () => {
    const actions = code(read('../src/daily-loop/mail-actions.ts'));
    assert.match(actions, /requirePermission\('employeeMail', 'send'\)/);
    assert.match(actions, /requirePermission\('employeeIntelligence', 'update'\)/);
    // The principal is the session's, in every action, and nothing reads one from a request.
    assert.equal(/organizationId:\s*String\(form/.test(actions), false);
    for (const forbidden of ['form.get(\'userId\')', 'form.get(\'organizationId\')', 'searchParams', 'headers.get(']) {
      assert.equal(actions.includes(forbidden), false, forbidden);
    }
    // The send path calls the service with a draft id -- there is no path from a request body to
    // Gmail, which is what keeps generation and transmission apart.
    assert.match(actions, /sendDraft\(principal, draft\.id\)/);
  });

  it('checking and releasing an unconfirmed reply need the send authority too -- and never send', () => {
    const actions = code(read('../src/daily-loop/mail-actions.ts'));
    for (const name of ['sendReplyAction', 'checkSendAction', 'releaseSendAction']) {
      const start = actions.indexOf(`export async function ${name}(`);
      assert.ok(start >= 0, name);
      const next = actions.indexOf('export async function', start + 1);
      const body = actions.slice(start, next === -1 ? undefined : next);
      assert.match(body, /requirePermission\('employeeMail', 'send'\)/, name);
      if (name !== 'sendReplyAction') assert.equal(body.includes('sendDraft('), false, `${name} must not send`);
    }
    // And the conversation page settles an attempt in doubt when it is looked at: the crash path.
    const page = code(read('../src/app/app/mail/[threadId]/page.tsx'));
    assert.match(page, /mailSendService\(\)\.reconcile\(principal, /);
    assert.equal(page.includes('sendDraft('), false, 'viewing a conversation never sends');
  });

  it('no model, prompt or generated text can reach the send path', () => {
    for (const file of ['../src/daily-loop/mail-actions.ts', '../src/daily-loop/mail.ts', '../src/daily-loop/mail-runtime.ts', '../src/daily-loop/mail-send-runtime.ts']) {
      const src = code(read(file));
      for (const forbidden of ['anthropic', 'openai', 'AiRuntimeGateway', 'aiRuntime', 'generateDraft']) {
        assert.equal(src.toLowerCase().includes(forbidden.toLowerCase()), false, `${file}: ${forbidden}`);
      }
    }
  });

  it('the surfaces take the principal from the session, and never from the route', () => {
    for (const page of ['../src/app/app/mail/page.tsx', '../src/app/app/mail/[threadId]/page.tsx']) {
      const src = code(read(page));
      assert.match(src, /organizationId: session\.organizationId, userId: session\.userId/);
      assert.match(src, /requirePermission\('employeeIntelligence', 'view'\)/);
      for (const forbidden of ['searchParams', 'params.userId', 'params.organizationId']) {
        assert.equal(src.includes(forbidden), false, `${page}: ${forbidden}`);
      }
    }
    // The thread id comes from the route and is NOT authority: it is handed to a read scoped by
    // the principal, so another employee's thread is not-found rather than forbidden.
    const thread = code(read('../src/app/app/mail/[threadId]/page.tsx'));
    assert.match(thread, /loadThread\(principal, threadId\)/);
  });

  it('is drawn from the design system, and renders no email markup anywhere', () => {
    const css = read('../src/app/loop-os.css');
    for (const file of ['../src/app/app/mail/_mail/composer.tsx', '../src/app/app/mail/_mail/conversation.tsx', '../src/app/app/mail/_mail/mail-parts.tsx']) {
      const src = read(file);
      for (const forbidden of ['dangerouslySetInnerHTML', 'style=', 'styled', '<iframe']) {
        assert.equal(src.includes(forbidden), false, `${file}: ${forbidden}`);
      }
      const classes = [...src.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)]
        .flatMap((m) => (m[1] === undefined ? [...m[2]!.matchAll(/'([^']*)'/g)].map((q) => q[1]!) : [m[1]]))
        .flatMap((value) => value.split(/\s+/))
        .filter((c) => /^[a-z][a-z0-9-]*$/.test(c));
      for (const cls of new Set(classes)) {
        assert.match(css, new RegExp('\\.' + cls + '[\\s,.:{]'), `${cls} has no rule in loop-os.css`);
      }
    }
  });
});

describe('Home says what mail needs the employee, with why and how to disagree', () => {
  const item = (over: Partial<MailAttentionItem> = {}): MailAttentionItem => ({
    id: 'item_1',
    class: 'NEEDS_YOU',
    threadId: 't1',
    title: 'Cashion pricing',
    lastMessageAt: new Date('2026-09-18T14:00:00Z'),
    unread: true,
    rule: 'INBOUND_UNREAD',
    snoozedUntil: null,
    ...over,
  });
  const view = (over: Partial<MailAttentionView> = {}): MailAttentionView => ({
    needsYou: [item()],
    waitingOnThem: [],
    goneQuiet: [],
    summary: { moved: 3, replies: 2, answered: 1, needsYou: 1, waitingOnThem: 0, goneQuiet: 0 },
    since: new Date('2026-09-17T04:00:00Z'),
    ...over,
  });

  it('states why a row is there in the rule’s own terms, never as an adjective', () => {
    const html = renderToStaticMarkup(<YourMail view={view()} time={time} />);
    assert.match(html, /Cashion pricing/);
    assert.match(html, /They wrote .* and it is unread\./);
    assert.match(html, /3 conversations moved/);
    assert.match(html, /2 replies arrived/);
    // No adjective Loop cannot defend from a header.
    for (const forbidden of ['urgent', 'important', 'critical', 'probably', 'seems', 'unhappy', 'priority']) {
      assert.equal(html.toLowerCase().includes(forbidden), false, forbidden);
    }

    const waiting = renderToStaticMarkup(
      <YourMail view={view({ needsYou: [], waitingOnThem: [item({ class: 'WAITING_ON_THEM', rule: 'OUTBOUND_UNANSWERED', unread: false })] })} time={time} />,
    );
    assert.match(waiting, /You wrote .* and there has been no reply\./);
    const quiet = renderToStaticMarkup(
      <YourMail view={view({ needsYou: [], goneQuiet: [item({ class: 'GONE_QUIET', rule: 'EXCHANGE_SILENT' })] })} time={time} />,
    );
    assert.match(quiet, /This conversation last moved/);
  });

  it('offers every correction beside the row, and the thread behind it', () => {
    const html = renderToStaticMarkup(<YourMail view={view()} time={time} />);
    assert.match(html, /href="\/app\/mail\/t1"/);
    for (const action of ['Handled', 'I’m waiting on them', 'Snooze a day', 'Dismiss']) {
      assert.ok(html.includes(action), action);
    }
    assert.match(html, /name="itemId" value="item_1"/);
    // "I'm waiting on them" is not offered on a row that already says exactly that.
    const waiting = renderToStaticMarkup(<YourMail view={view({ needsYou: [], waitingOnThem: [item({ class: 'WAITING_ON_THEM' })] })} time={time} />);
    assert.equal(waiting.includes('I’m waiting on them'), false);
  });

  it('says nothing is waiting when nothing is, and says it cannot tell when it cannot', () => {
    const clear = renderToStaticMarkup(
      <YourMail view={view({ needsYou: [], summary: { moved: 0, replies: 0, answered: 0, needsYou: 0, waitingOnThem: 0, goneQuiet: 0 } })} time={time} />,
    );
    assert.match(clear, /Nothing in your mail is waiting on you/);
    assert.match(clear, /Nothing has moved since/);

    // Stale or unreadable mail is never presented as an empty queue.
    const cannot = renderToStaticMarkup(<YourMail view={null} time={time} unavailable="Loop has not read your mail recently enough to say what it is waiting on." />);
    assert.match(cannot, /has not read your mail recently enough/);
    assert.equal(cannot.includes('Nothing in your mail is waiting'), false);
    assert.equal(renderToStaticMarkup(<YourMail view={null} time={time} />), '', 'no connection, no panel');
  });

  it('the correction actions are guarded, act on the asker’s own item, and edit no evidence', () => {
    const actions = code(read('../src/daily-loop/mail-actions.ts'));
    for (const action of ['markHandledAction', 'dismissItemAction', 'snoozeItemAction', 'markWaitingOnThemAction']) {
      assert.match(actions, new RegExp(`export async function ${action}`), action);
    }
    // Each one authenticates, and the item id is scoped by the principal inside the repository.
    assert.equal((actions.match(/requirePermission\('employeeIntelligence', 'update'\)/g) ?? []).length >= 4, true);
    // A correction records an observation or feedback. It never writes to the evidence tables.
    for (const forbidden of ['upsertMessage', 'upsertThread', 'workThread.update', 'workMessage.update', 'evidence:']) {
      assert.equal(actions.includes(forbidden), false, forbidden);
    }
    assert.match(actions, /recordFeedback\(principal, \{ kind: 'NOT_WAITING'/);
  });
});
