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

  it('no model, prompt or generated text can reach the send path', () => {
    for (const file of ['../src/daily-loop/mail-actions.ts', '../src/daily-loop/mail.ts', '../src/daily-loop/mail-runtime.ts']) {
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
