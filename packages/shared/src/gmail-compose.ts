// Composing a reply that Gmail will place in the right conversation. PURE -- no I/O, no clock.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6 (GM-2).
//
// WHY THIS IS A MODULE AND NOT THREE LINES AT A CALL SITE. Google's Message reference states
// the threading contract exactly (verified 2026-09-18), and all three parts are required:
//
//   1. the `threadId` must be supplied on the message;
//   2. `References` and `In-Reply-To` must be set in compliance with RFC 2822;
//   3. the `Subject` headers must match.
//
// Approximating any of them produces a message that arrives as a new conversation, which is
// the kind of defect nobody notices until a customer replies to the wrong thing. It is built
// here, as a pure function, so every part of it is testable without sending mail.
//
// HEADER INJECTION IS THE OTHER REASON. Recipients, subjects and display names reach this from
// stored correspondence and from an employee's keyboard. A carriage return inside any of them
// would end the header and start another -- adding a Bcc, or a whole second message. Every
// header value is stripped of CR and LF before it is written, and a value that still cannot be
// represented is refused rather than escaped into something plausible.
//
// THE BODY IS BASE64, DELIBERATELY. It sidesteps line-length limits, 8-bit characters and the
// dot-stuffing rules in one move, and it is what the RFC calls for when content is not
// guaranteed 7-bit.

import { normalizeGmailAddress, type GmailAddress } from './gmail-sensor';

export const GMAIL_REPLY_MODES = ['REPLY', 'REPLY_ALL'] as const;
export type GmailReplyMode = (typeof GMAIL_REPLY_MODES)[number];

/** The most a single reply may carry. Gmail's own limit is far higher; this is Loop's. */
export const GMAIL_MAX_BODY_CHARS = 100_000;
export const GMAIL_MAX_RECIPIENTS = 100;

export interface GmailReplyTarget {
  /** The message being replied to. */
  readonly messageId: string;
  readonly threadId: string;
  readonly headerMessageId: string | null;
  readonly references: readonly string[];
  readonly subject: string | null;
  readonly from: GmailAddress | null;
  readonly to: readonly GmailAddress[];
  readonly cc: readonly GmailAddress[];
}

export interface GmailReplyRecipients {
  readonly to: readonly GmailAddress[];
  readonly cc: readonly GmailAddress[];
}

/**
 * Who a reply goes to.
 *
 *   REPLY      the person who wrote the message. If the employee wrote it themselves, the
 *              people it was addressed to -- replying to your own message means continuing it.
 *   REPLY_ALL  that, plus everyone else who was on it, minus the employee themselves.
 *
 * The employee's own address is never a recipient of their own reply, and no address appears
 * twice. Order is stable so two calls produce the same message.
 */
export function gmailReplyRecipients(target: GmailReplyTarget, mode: GmailReplyMode, selfAddress: string): GmailReplyRecipients {
  const self = normalizeGmailAddress(selfAddress);
  const seen = new Set<string>([self]);
  const keep = (list: readonly GmailAddress[]): GmailAddress[] => {
    const out: GmailAddress[] = [];
    for (const address of list) {
      const key = normalizeGmailAddress(address.address);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ address: key, name: address.name });
    }
    return out;
  };

  const authorIsSelf = target.from !== null && normalizeGmailAddress(target.from.address) === self;
  const to = authorIsSelf ? keep(target.to) : keep(target.from ? [target.from] : []);
  if (mode === 'REPLY') return { to, cc: [] };

  // Reply all: everyone the conversation already included, and nobody new.
  const cc = keep([...target.to, ...target.cc]);
  return { to, cc };
}

/** `Re:` exactly once. Gmail matches on the subject, and "Re: Re: Re:" is not a match Loop makes. */
export function gmailReplySubject(subject: string | null): string {
  const text = (subject ?? '').trim();
  if (text === '') return 'Re:';
  return /^re\s*:/i.test(text) ? text : `Re: ${text}`;
}

/**
 * The `References` chain for a reply: everything the original carried, then the original's own
 * `Message-ID`. Deduplicated, order preserved -- it is a chain, not a set.
 */
export function gmailReplyReferences(target: GmailReplyTarget): string[] {
  const chain = [...target.references];
  if (target.headerMessageId) chain.push(target.headerMessageId);
  const seen = new Set<string>();
  return chain.filter((id) => {
    const value = id.trim();
    if (value === '' || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

// --- Encoding ------------------------------------------------------------------------------

const CONTROL = /[\r\n\u0000]/;

function base64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/** RFC 2047, for a header value that is not plain ASCII. ASCII is left readable. */
export function gmailEncodeHeaderWord(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${base64(utf8(value))}?=`;
}

/** One address as a header writes it, with a display name only when there is one. */
export function gmailFormatAddress(address: GmailAddress): string {
  const mailbox = normalizeGmailAddress(address.address);
  const name = address.name?.trim();
  if (!name) return mailbox;
  const encoded = gmailEncodeHeaderWord(name);
  // A quoted display name keeps commas and colons from being read as structure.
  return /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, '')}" <${mailbox}>` : `${encoded} <${mailbox}>`;
}

export const GMAIL_COMPOSE_REFUSALS = [
  'NO_RECIPIENT',
  'EMPTY_BODY',
  'BODY_TOO_LONG',
  'TOO_MANY_RECIPIENTS',
  'UNSAFE_HEADER',
  'INVALID_ADDRESS',
] as const;
export type GmailComposeRefusal = (typeof GMAIL_COMPOSE_REFUSALS)[number];

export interface GmailOutboundMessage {
  /** The RFC 5322 message, base64url encoded, ready for `messages.send`. */
  readonly raw: string;
  /** The thread it belongs to, which Gmail also requires on the request body. */
  readonly threadId: string | null;
  /** What was written, so a caller can record and test it without decoding base64. */
  readonly headers: Readonly<Record<string, string>>;
  readonly to: readonly string[];
  readonly cc: readonly string[];
}

export type GmailComposeResult =
  | { readonly ok: true; readonly message: GmailOutboundMessage }
  | { readonly ok: false; readonly refusal: GmailComposeRefusal };

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

export interface GmailReplyRequest {
  readonly target: GmailReplyTarget;
  readonly mode: GmailReplyMode;
  /** The connected account: a person may only ever send as themselves. */
  readonly from: GmailAddress;
  readonly body: string;
  /** Overrides the computed recipients, when the employee edited them in the composer. */
  readonly to?: readonly GmailAddress[];
  readonly cc?: readonly GmailAddress[];
}

/**
 * Build the reply. It refuses rather than repairs: a message this cannot represent honestly is
 * not sent at all, because the failure mode of "repair" is mail going somewhere unintended.
 */
export function buildGmailReply(request: GmailReplyRequest): GmailComposeResult {
  const body = request.body ?? '';
  if (body.trim() === '') return { ok: false, refusal: 'EMPTY_BODY' };
  if (body.length > GMAIL_MAX_BODY_CHARS) return { ok: false, refusal: 'BODY_TOO_LONG' };

  const computed = gmailReplyRecipients(request.target, request.mode, request.from.address);
  const to = request.to ?? computed.to;
  const cc = request.cc ?? computed.cc;
  if (to.length === 0) return { ok: false, refusal: 'NO_RECIPIENT' };
  if (to.length + cc.length > GMAIL_MAX_RECIPIENTS) return { ok: false, refusal: 'TOO_MANY_RECIPIENTS' };

  for (const address of [request.from, ...to, ...cc]) {
    if (!ADDRESS.test(normalizeGmailAddress(address.address))) return { ok: false, refusal: 'INVALID_ADDRESS' };
    if (address.name && CONTROL.test(address.name)) return { ok: false, refusal: 'UNSAFE_HEADER' };
  }

  const subject = gmailReplySubject(request.target.subject);
  const references = gmailReplyReferences(request.target);
  const inReplyTo = request.target.headerMessageId;
  for (const value of [subject, inReplyTo ?? '', ...references]) {
    if (CONTROL.test(value)) return { ok: false, refusal: 'UNSAFE_HEADER' };
  }

  const headers: Record<string, string> = {
    From: gmailFormatAddress(request.from),
    To: to.map(gmailFormatAddress).join(', '),
    Subject: gmailEncodeHeaderWord(subject),
    'MIME-Version': '1.0',
    'Content-Type': 'text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding': 'base64',
  };
  if (cc.length > 0) headers.Cc = cc.map(gmailFormatAddress).join(', ');
  // Both, always, and only when there is something to point at: a reply to a message whose own
  // Message-ID Loop never saw is still sent, and Gmail threads it on the threadId and subject.
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
  if (references.length > 0) headers.References = references.join(' ');

  for (const value of Object.values(headers)) {
    if (CONTROL.test(value)) return { ok: false, refusal: 'UNSAFE_HEADER' };
  }

  const encodedBody = base64(utf8(body)).replace(/(.{76})/g, '$1\r\n');
  const mime = `${Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n')}\r\n\r\n${encodedBody}\r\n`;

  return {
    ok: true,
    message: {
      raw: base64(utf8(mime)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
      threadId: request.target.threadId,
      headers,
      to: to.map((a) => normalizeGmailAddress(a.address)),
      cc: cc.map((a) => normalizeGmailAddress(a.address)),
    },
  };
}
