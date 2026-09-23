// MAIL: what an employee sees, what they can do, and what no request can make it do.
//
// Renders the real components with prepared views (renderToStaticMarkup + markup assertions),
// plus source assertions for the guarantees that are properties of the code rather than of one
// render -- above all the one this milestone rests on: nothing generated can send.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  NO_CORRECTIONS,
  classifyMailThread,
  createTimeView,
  recentImportant,
  summarizeMail,
  type GmailThreadMessage,
  type MailCorrections,
  type MailMessageEvidence,
} from '@emgloop/shared';

import { Composer } from '../src/app/app/mail/_mail/composer';
import { Conversation } from '../src/app/app/mail/_mail/conversation';
import { MailEmpty, mailCurrency } from '../src/app/app/mail/_mail/mail-parts';
import { ConversationRow, FilterBar, LaneSection, SummaryCards, mailFilterFrom, mailHref, type MailFilterState } from '../src/app/app/mail/_mail/dashboard';
import { ThreadAttention } from '../src/app/app/mail/_mail/thread-attention';
import type { MailThreadSummary } from '../src/daily-loop/mail';
import type { MailDashboard, MailDashboardRow } from '../src/daily-loop/mail-dashboard';

const NY = { timeZone: 'America/New_York', source: 'device' as const };
const NOW = new Date('2026-09-18T16:00:00Z');
const time = createTimeView(NY, NOW);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const SRC = fileURLToPath(new URL('../src', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });

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

// --- A mailbox, classified by the real rules ------------------------------------------------------

const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const inbound = (at: Date, from = 'ben@cashion.example', over: Partial<MailMessageEvidence> = {}): MailMessageEvidence => ({
  at,
  direction: 'INBOUND',
  fromAddress: from,
  fromName: null,
  labels: ['INBOX'],
  inReplyTo: '<prev@x>',
  ...over,
});
const outbound = (at: Date, over: Partial<MailMessageEvidence> = {}): MailMessageEvidence => ({
  at,
  direction: 'OUTBOUND',
  fromAddress: null,
  fromName: null,
  labels: ['SENT'],
  inReplyTo: '<prev@x>',
  ...over,
});

function convo(
  threadId: string,
  subject: string,
  messages: MailMessageEvidence[],
  person: { address: string; name: string | null },
  over: { unread?: boolean; corrections?: MailCorrections; hasDraft?: boolean; sendUnconfirmed?: boolean } = {},
): MailDashboardRow {
  const last = messages.at(-1)!;
  const people = [person];
  const summary = thread({
    threadId,
    subject,
    lastMessageAt: last.at,
    lastDirection: last.direction,
    messageCount: messages.length,
    unread: over.unread ?? false,
    people,
    hasDraft: over.hasDraft ?? false,
    sendUnconfirmed: over.sendUnconfirmed ?? false,
  });
  const insight = classifyMailThread(
    { threadId, subject, lastMessageAt: last.at, lastDirection: last.direction, unread: summary.unread, messages, people },
    over.corrections ?? NO_CORRECTIONS,
    NOW,
    ['elitemediagroup.io'],
  );
  return { thread: summary, insight };
}

const BEN = { address: 'ben@cashion.example', name: 'Ben Cashion' };
const MAILBOX: MailDashboardRow[] = [
  // They wrote six hours ago and nobody answered: needs a reply.
  convo('reply', 'Cashion pricing', [outbound(ago(2 * D)), inbound(ago(6 * H))], BEN),
  // A receipt from a no-reply sender, unread: notification mail, never "needs reply".
  convo('receipt', 'Your receipt', [inbound(ago(5 * H), 'no-reply@payments.example', { labels: ['INBOX', 'CATEGORY_UPDATES'], inReplyTo: null })], {
    address: 'no-reply@payments.example',
    name: 'Payments',
  }, { unread: true }),
  // A promotion whose subject says "partnership": still never an opportunity.
  convo('promo', 'Partnership opportunity inside', [inbound(ago(3 * H), 'deals@brand.example', { labels: ['INBOX', 'CATEGORY_PROMOTIONS'], inReplyTo: null })], {
    address: 'deals@brand.example',
    name: 'Brand Deals',
  }),
  // A person writing in, first message, about a partnership: an inbound inquiry.
  convo('inquiry', 'Partnership inquiry', [inbound(ago(2 * H), 'ana@novabrand.example', { inReplyTo: null })], { address: 'ana@novabrand.example', name: 'Ana Silva' }, { unread: true }),
  // They replied to outreach the employee started: an outreach reply.
  convo('outreach', 'Intro: EMG x Northwind', [outbound(ago(4 * D), { inReplyTo: null }), inbound(ago(D))], { address: 'kim@northwind.example', name: 'Kim Lee' }),
  // The employee wrote yesterday: waiting on them.
  convo('waiting', 'Contract redlines', [inbound(ago(3 * D), 'jo@omnisure.example'), outbound(ago(D))], { address: 'jo@omnisure.example', name: 'Jo Park' }, { hasDraft: true }),
  // The employee wrote five days ago and heard nothing: a follow-up is due.
  convo('followup', 'Talent rate card', [inbound(ago(9 * D), 'max@agency.example'), outbound(ago(5 * D))], { address: 'max@agency.example', name: 'Max Ruiz' }, { sendUnconfirmed: true }),
];

function dashboard(rows: MailDashboardRow[] = MAILBOX, over: Partial<MailDashboard> = {}): MailDashboard {
  const byId = new Map(rows.map((r) => [r.insight.threadId, r]));
  return {
    mail: { now: NOW, freshness: 'CURRENT', canRefresh: true, lastSyncedAt: ago(60_000), syncInProgress: false, refreshed: false, threads: rows.map((r) => r.thread), knows: true },
    concludable: true,
    current: true,
    now: NOW,
    rows,
    summary: summarizeMail(rows.map((r) => r.insight), NOW),
    recent: recentImportant(rows.map((r) => r.insight), NOW).map((i) => byId.get(i.threadId)!),
    ...over,
  };
}

const DASHBOARD_STATE: MailFilterState = { view: 'dashboard', query: '', unreadOnly: false, includeNotifications: false };

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
  it('a row names who, their company, what about, why it is here and when -- and opens the conversation', () => {
    const row = MAILBOX.find((r) => r.insight.threadId === 'reply')!;
    const html = renderToStaticMarkup(<ConversationRow row={row} time={time} context="lane" />);
    assert.match(html, /Ben Cashion/);
    assert.match(html, /cashion\.example/, 'the company context is the sender’s domain, not a guess');
    assert.match(html, /Cashion pricing/);
    assert.match(html, /They wrote .* and you have not replied/);
    assert.match(html, /Needs reply/);
    assert.match(html, /href="\/app\/mail\/reply"/);
    assert.match(html, /datetime="2026-09-18T10:00:00\.000Z"/i);
    // A deterministic initials avatar: no remote image of anybody is ever fetched.
    assert.equal(/<img\b/.test(html), false);
    assert.match(html, />BC</);

    // A draft in progress, and a reply whose delivery Loop could not confirm, are flagged in the row.
    const draft = renderToStaticMarkup(<ConversationRow row={MAILBOX.find((r) => r.insight.threadId === 'waiting')!} time={time} context="lane" />);
    assert.match(draft, /Draft/);
    const unconfirmed = renderToStaticMarkup(<ConversationRow row={MAILBOX.find((r) => r.insight.threadId === 'followup')!} time={time} context="lane" />);
    assert.match(unconfirmed, /Delivery unconfirmed/);
    assert.match(unconfirmed, /loop-mail__tag--attention/);
    assert.equal(html.includes('Delivery unconfirmed'), false);
  });

  it('never presents stored mail as a fresh read, and offers the way back where there is one', () => {
    const at = new Date('2026-09-18T15:00:00Z');
    assert.match(mailCurrency('CURRENT', at, false, time).line, /Loop read your mail/);
    assert.match(mailCurrency('STALE', at, false, time).line, /Loop last read your mail/);
    // Never read: the first read is the cycle's, in the background -- not "when you open Loop".
    assert.equal(mailCurrency('NEVER_SYNCED', null, false, time).line, 'Loop is setting up your mail. It reads the last two weeks in the background, not while you wait.');
    assert.equal(mailCurrency('NEVER_SYNCED', null, true, time).line, 'Loop is reading your mail for the first time.');
    assert.match(mailCurrency('SYNC_FAILED', at, false, time).line, /as Loop last read it/);
    assert.match(mailCurrency('SYNC_FAILED', null, false, time).line, /first read of your mail did not finish\. It tries again in the background/);
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
    assert.match(never, /Loop is setting up your mail/);
    assert.match(never, /reads the last two weeks of it in the background, not while you wait/);
    assert.equal(never.includes('when you open Loop'), false, 'a visit no longer performs the first read');
    assert.equal(never.includes('Read my mail again'), false, 'no Refresh before there is anything it could read');
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
    // Loop could draft here -- and still must not offer to while the reply is in flight or in doubt.
    draftWithLoop: { available: true, reason: null },
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
      for (const forbidden of ['params.userId', 'params.organizationId', 'searchParams.userId', 'searchParams.organizationId', "searchParams?.['user", "searchParams?.['org"]) {
        assert.equal(src.includes(forbidden), false, `${page}: ${forbidden}`);
      }
    }
    // The conversation page reads nothing from the query string at all.
    assert.equal(code(read('../src/app/app/mail/[threadId]/page.tsx')).includes('searchParams'), false);
    // The list page hands the query string to ONE reader, which knows four keys -- a view, a search
    // and two switches -- and none of them can name a person, a mailbox or an organization.
    const list = code(read('../src/app/app/mail/page.tsx'));
    assert.equal((list.match(/searchParams/g) ?? []).length, 3, 'the prop, its type, and the one call that reads it');
    assert.match(list, /const state = mailFilterFrom\(searchParams\);/);
    const hostile = mailFilterFrom({ view: 'needs-reply', q: 'pricing', userId: 'u_other', organizationId: 'org_other', mailbox: 'x@y.z' });
    assert.deepEqual(hostile, { view: 'needs-reply', query: 'pricing', unreadOnly: false, includeNotifications: false });
    assert.equal(mailFilterFrom({ view: 'someone-elses' }).view, 'dashboard', 'an unknown view is the dashboard, never an error');
    // The thread id comes from the route and is NOT authority: it is handed to a read scoped by
    // the principal, so another employee's thread is not-found rather than forbidden.
    const thread = code(read('../src/app/app/mail/[threadId]/page.tsx'));
    assert.match(thread, /loadThread\(principal, threadId\)/);
  });

  it('is drawn from the design system, and renders no email markup anywhere', () => {
    const css = read('../src/app/loop-os.css');
    for (const file of [
      '../src/app/app/mail/_mail/composer.tsx',
      '../src/app/app/mail/_mail/conversation.tsx',
      '../src/app/app/mail/_mail/mail-parts.tsx',
      '../src/app/app/mail/_mail/dashboard.tsx',
      '../src/app/app/mail/_mail/thread-attention.tsx',
      '../src/app/app/mail/page.tsx',
    ]) {
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

describe('the Mail dashboard: four lanes, each a stated rule, and filters that work', () => {
  const summary = dashboard().summary;

  it('counts come from the rules: notification mail never needs a reply, promotions are never opportunities', () => {
    // Cashion pricing, the unread inquiry and the unanswered outreach reply -- and not the unread receipt.
    assert.equal(summary.needsReply, 3);
    assert.equal(summary.waiting, 1);
    assert.equal(summary.followUps, 1);
    // The inbound inquiry and the outreach reply; never the promotion that says "partnership".
    assert.equal(summary.opportunities, 2);
    const byId = new Map(MAILBOX.map((r) => [r.insight.threadId, r.insight]));
    assert.equal(byId.get('receipt')!.lane, null);
    assert.ok(byId.get('receipt')!.notification);
    assert.equal(byId.get('promo')!.opportunity, null);
    assert.equal(byId.get('inquiry')!.opportunity?.kind, 'INBOUND_INQUIRY');
    assert.equal(byId.get('outreach')!.opportunity?.kind, 'OUTREACH_REPLY');
    // Follow-ups due and waiting on them are different lanes, not one list twice.
    assert.equal(byId.get('waiting')!.lane, 'WAITING');
    assert.equal(byId.get('followup')!.lane, 'FOLLOW_UP');
  });

  it('the four cards show those counts, each opening its own view -- and claim no comparison they cannot make', () => {
    const html = renderToStaticMarkup(<SummaryCards summary={summary} state={DASHBOARD_STATE} />);
    for (const [label, view] of [['Need my reply', 'needs-reply'], ['Follow-ups due', 'follow-ups'], ['Waiting on them', 'waiting'], ['New opportunities', 'opportunities']] as const) {
      assert.ok(html.includes(label), label);
      assert.ok(html.includes(`href="/app/mail?view=${view}"`), view);
    }
    // No percentage, no "vs last week": only a count of what arrived in the last day, when there is one.
    assert.equal(/%|vs\.? last/i.test(html), false);
    const quiet = renderToStaticMarkup(
      <SummaryCards summary={{ ...summary, inflow: { needsReply: 0, followUps: 0, waiting: 0, opportunities: 0 } }} state={DASHBOARD_STATE} />,
    );
    assert.equal(quiet.includes('in the last day'), false, 'no inflow, no delta line');
    // The active view is marked, for sight and for assistive technology.
    const active = renderToStaticMarkup(<SummaryCards summary={summary} state={{ ...DASHBOARD_STATE, view: 'waiting' }} />);
    assert.match(active, /loop-mx__card--active[^>]*aria-current="page"|aria-current="page"[^>]*loop-mx__card--active/);
  });

  it('the filter bar: every view with its count, a search that submits, and filters that apply', () => {
    const html = renderToStaticMarkup(<FilterBar summary={summary} state={{ ...DASHBOARD_STATE, view: 'talent', query: 'rate' }} />);
    for (const label of ['All', 'Needs reply', 'Follow-ups', 'Waiting', 'Opportunities', 'Talent', 'Performance', 'Operations']) {
      assert.ok(html.includes(`>${label}<`), label);
    }
    assert.match(html, /<form[^>]*method="get"[^>]*action="\/app\/mail"/);
    assert.match(html, /name="view" value="talent"/, 'searching keeps the view');
    assert.match(html, /name="q"[^>]*value="rate"|value="rate"[^>]*name="q"/);
    assert.match(html, /placeholder="Search conversations…"/);
    assert.match(html, /name="unread" value="1"/);
    assert.match(html, /name="notifications" value="1"/);
    assert.match(html, /aria-current="page"[^>]*>Talent|Talent[\s\S]*?aria-current/);
    // Links keep the search: moving between views does not lose what was typed.
    assert.equal(mailHref({ ...DASHBOARD_STATE, query: 'rate' }, { view: 'waiting' }), '/app/mail?view=waiting&q=rate');
    assert.equal(mailHref(DASHBOARD_STATE), '/app/mail');
    assert.deepEqual(mailFilterFrom({ view: 'waiting', q: 'rate', unread: '1', notifications: '1' }), {
      view: 'waiting',
      query: 'rate',
      unreadOnly: true,
      includeNotifications: true,
    });
    assert.equal(mailFilterFrom({ q: 'x'.repeat(500) }).query.length, 200);
  });

  it('a lane shows its top rows and “View all (N)” only when there is something to view', () => {
    const rows = MAILBOX.filter((r) => r.insight.lane === 'NEEDS_REPLY');
    const html = renderToStaticMarkup(
      <LaneSection title="Needs my reply" icon="mail" tone="crit" rows={rows} total={7} href="/app/mail?view=needs-reply" time={time} context="lane" empty="No conversation needs your reply." />,
    );
    assert.match(html, /View all \(7\) →/);
    assert.match(html, /href="\/app\/mail\?view=needs-reply"/);
    const none = renderToStaticMarkup(
      <LaneSection title="Needs my reply" icon="mail" tone="crit" rows={[]} total={0} href="/app/mail?view=needs-reply" time={time} context="lane" empty="No conversation needs your reply." />,
    );
    assert.match(none, /No conversation needs your reply\./);
    assert.equal(none.includes('View all'), false);
  });

  it('an empty lane and an unreadable mailbox never look alike: lanes are concluded only from a read', () => {
    const page = code(read('../src/app/app/mail/page.tsx'));
    assert.match(page, /!dashboard\.concludable \? \(\s*<MailEmpty/);
    // A stale read still concludes -- in the past tense.
    assert.match(page, /current \? what : `\$\{what\.replace\(\/\\\.\$\/, ''\)\} when Loop last read your mail\.`/);
    // A mailbox that cannot be read degrades to saying so, never to an error or an empty dashboard.
    assert.match(page, /catch \{\s*dashboard = 'UNAVAILABLE';/);
    const loader = code(read('../src/daily-loop/mail-dashboard.ts'));
    assert.match(loader, /const concludable = mail\.lastSyncedAt !== null && \(mail\.knows \|\| mail\.freshness === 'SYNC_FAILED'\);/);
    assert.match(loader, /if \(!concludable\) return empty;/);
  });

  it('the dashboard is a read model over what Gmail sync stored: nothing here talks to Google or writes mail', () => {
    for (const file of ['../src/daily-loop/mail-dashboard.ts', '../src/app/app/mail/_mail/dashboard.tsx', '../src/app/app/mail/page.tsx']) {
      const src = code(read(file));
      for (const forbidden of ['googleapis', 'fetch(', 'sendDraft(', 'upsertMessage', 'upsertThread', 'loadThread', 'mailReadableText', '.body.text', 'dangerouslySetInnerHTML', 'anthropic', 'aiRuntime']) {
        assert.equal(src.includes(forbidden), false, `${file}: ${forbidden}`);
      }
    }
  });

  it('lays out as two columns on a desktop and one on a phone, with no horizontal scroll', () => {
    const css = read('../src/app/loop-os.css');
    assert.match(css, /\.loop-mx__grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    assert.match(css, /@media \(max-width: 900px\) \{\s*\.loop-mx__grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    // Two by two below 1180px -- four stacked cards would push every lane below the fold on a phone.
    assert.match(css, /@media \(max-width: 1180px\) \{\s*\.loop-mx__cards \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    // One row layout at every width: sender and company, subject, then why it is here.
    assert.match(css, /\.loop-mx__row \{ display: grid; grid-template-columns: 36px minmax\(0, 1fr\) auto 16px; grid-template-areas: 'avatar who tags chevron' 'avatar subject subject chevron' 'avatar detail when chevron';/);
    // The filter pills wrap rather than scroll sideways, and every track can shrink.
    assert.match(css, /\.loop-mx__pills \{ display: flex; flex-wrap: wrap;/);
    for (const m of css.matchAll(/\.loop-(?:mx|exec|cal|yourmail)[^{]*\{[^}]*min-width: ([0-9]+)px/g)) {
      assert.ok(Number(m[1]) <= 320, `a ${m[1]}px minimum would scroll sideways on a phone`);
    }
  });
});

// Home's mail line (a few counts and the way to Mail, never a second inbox) is covered in home-briefing.test.tsx.

describe('corrections live on the conversation they are about', () => {
  it('offers Handled, Snooze and Dismiss -- and “I’m waiting on them” only where Loop says it needs a reply', () => {
    const html = renderToStaticMarkup(<ThreadAttention item={{ id: 'item_1', class: 'NEEDS_YOU', snoozed: false }} threadId="t1" />);
    assert.match(html, /needs your reply/);
    for (const action of ['Handled', 'I’m waiting on them', 'Snooze a day', 'Dismiss']) assert.ok(html.includes(action), action);
    assert.match(html, /name="itemId" value="item_1"/);
    assert.match(html, /name="threadId" value="t1"/);
    const waiting = renderToStaticMarkup(<ThreadAttention item={{ id: 'item_2', class: 'WAITING_ON_THEM', snoozed: true }} threadId="t1" />);
    assert.equal(waiting.includes('I’m waiting on them'), false);
    assert.match(waiting, /\(snoozed\)/);
    assert.equal(renderToStaticMarkup(<ThreadAttention item={null} threadId="t1" />), '');
  });

  it('the conversation page finds the item within the employee’s own items, and the thread stays scoped', () => {
    const page = code(read('../src/app/app/mail/[threadId]/page.tsx'));
    assert.match(page, /new WorkItemRepository\(prisma\)\s*\.items\(principal,/);
    assert.match(page, /<ThreadAttention /);
    assert.match(page, /loadThread\(principal, threadId\)/);
  });

  it('an employee’s correction is respected by the lanes: “I’m waiting on them” moves the conversation out of Needs reply', () => {
    const corrected = convo('reply', 'Cashion pricing', [outbound(ago(2 * D)), inbound(ago(6 * H))], BEN, {
      corrections: { closed: [], snoozedUntil: null, waitingOnThemAt: ago(H) },
    });
    assert.notEqual(corrected.insight.lane, 'NEEDS_REPLY');
    assert.equal(corrected.insight.lane, 'WAITING');
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
