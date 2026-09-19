// The Gmail sensor: Loop's own contract for what a mailbox reports. PURE -- no I/O, no
// environment, no clock, no Google field name.
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6, §8 and §17 (GM-1).
//
// WHY LOOP OWNS THIS SHAPE. Gmail is one provider of one capability. The facts below are the
// ones Daily Loop reasons about -- who wrote to whom, when, on which thread, whether it is
// still unread -- and a second provider implements the same shape without Daily Loop changing.
//
// TWO READS, TWO DIFFERENT PROMISES, AND THE DIFFERENCE IS THE WHOLE PRIVACY POSTURE:
//
//   THE SYNC READ  (`GmailMessageFact`) is METADATA ONLY. It carries headers, labels and
//                  timestamps, and it is the only Gmail read that is ever persisted. There is
//                  no body field here, and adding one is a migration and a product decision.
//   THE THREAD READ (`GmailThreadView`) carries bodies, is performed only when an employee
//                  opens a conversation or asks Loop to draft a reply, and is NEVER STORED --
//                  it is rendered, or handed to a governed AI context, and discarded. The
//                  retention record already says so: GOOGLE_RAW_RESPONSES is NEVER_STORED.
//
// ADDRESSES TRAVEL AS ADDRESSES HERE, exactly as far as the store. An employee has to see who
// wrote to them, so the database keeps the readable form on `work_correspondents` (already
// classified CONTACT_IDENTIFIER) and the hash on every message. This contract does not hash,
// because a sensor that hashed could not render an inbox.

import type { WorkSyncFailureClass } from './work-state';

/** One address as a mailbox reports it. `name` is absent more often than it is present. */
export interface GmailAddress {
  readonly address: string;
  readonly name: string | null;
}

/**
 * Gmail's own labels, as far as Loop reads them. Everything else is passed through untouched:
 * a person's own labels are their business, and Loop neither interprets nor writes them.
 */
export const GMAIL_SYSTEM_LABELS = ['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT', 'SENT', 'DRAFT', 'TRASH', 'SPAM'] as const;

/**
 * One message's metadata, normalized. This is what the sync persists.
 *
 * `references` is the RFC 5322 chain, kept because a correct reply must repeat it and because a
 * conversation can be reconstructed from it without asking Gmail again.
 */
export interface GmailMessageFact {
  readonly provider: 'GOOGLE';
  readonly messageId: string;
  readonly threadId: string;
  /** The provider's own timestamp. Gmail reports it as epoch milliseconds. */
  readonly internalDate: Date;
  readonly labels: readonly string[];
  readonly from: GmailAddress | null;
  readonly to: readonly GmailAddress[];
  readonly cc: readonly GmailAddress[];
  /** The sender's words. COMMUNICATION_CONTENT, and the least of it the product can work with. */
  readonly subject: string | null;
  /** RFC 5322 `Message-ID`, `In-Reply-To` and `References`. */
  readonly headerMessageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  /** True when the connected account sent it. Decided from the From address, never guessed. */
  readonly fromSelf: boolean;
}

/** One message as a reader sees it: the metadata above, plus the body, never persisted. */
export interface GmailMessageBody {
  readonly messageId: string;
  /** Plain text, extracted from the MIME tree. Null when the message carried only HTML. */
  readonly text: string | null;
  /** The HTML part, UNSANITIZED and never to be rendered as markup without sanitizing. */
  readonly html: string | null;
  /** Attachment facts only: a name, a type and a size. No content, and no download. */
  readonly attachments: readonly { readonly filename: string; readonly mimeType: string; readonly bytes: number }[];
  /** True when the MIME tree was deeper or larger than the reader walks. */
  readonly truncated: boolean;
}

export interface GmailThreadMessage {
  readonly fact: GmailMessageFact;
  readonly body: GmailMessageBody;
}

/** One conversation, in the order it happened. Read on demand, rendered, and discarded. */
export interface GmailThreadView {
  readonly threadId: string;
  readonly messages: readonly GmailThreadMessage[];
}

/**
 * A page of the sync read.
 *
 * `nextHistoryId` is the cursor for the next incremental pass, and it never skips anything newer
 * than itself. A window read returns the boundary it took before listing, capped or not: a capped
 * window leaves out only its OLDEST messages. An incremental read returns the mailbox's boundary
 * when complete, or -- when it stopped at its ceiling -- the last history record it consumed whole,
 * so the next pass resumes there. It is null only when no safe position exists. `truncated` says a
 * bound came first, which is not a failure.
 */
export interface GmailMessagePage {
  readonly messages: readonly GmailMessageFact[];
  /** Ids Gmail reported as removed since the cursor. Empty on a window read. */
  readonly removedMessageIds: readonly string[];
  readonly nextHistoryId: string | null;
  readonly nextPageToken: string | null;
  readonly truncated: boolean;
  readonly pagesRead: number;
}

/**
 * Why a Gmail read could not happen. The same vocabulary the calendar sensor uses, because the
 * pass that records it is the same pass -- with one Gmail-specific meaning noted:
 *
 *   CURSOR_EXPIRED  Gmail answered 404 to `history.list`: the stored historyId is older than
 *                   Gmail keeps (its own guide says "at least one week, often longer"), so a
 *                   bounded re-baseline is required. It is not an error in Loop's cursor.
 */
export const GMAIL_READ_FAILURES = [
  'NOT_CONNECTED',
  'CAPABILITY_NOT_GRANTED',
  'AUTHORIZATION_EXPIRED',
  'AUTH',
  'FORBIDDEN',
  'RATE_LIMITED',
  'CURSOR_EXPIRED',
  'NETWORK',
  'TIMEOUT',
  'MALFORMED',
  'UNAVAILABLE',
] as const;
export type GmailReadFailure = (typeof GMAIL_READ_FAILURES)[number];

export type GmailReadResult =
  | { readonly ok: true; readonly page: GmailMessagePage }
  | { readonly ok: false; readonly failure: GmailReadFailure };

export type GmailThreadResult =
  | { readonly ok: true; readonly thread: GmailThreadView }
  | { readonly ok: false; readonly failure: GmailReadFailure };

/**
 * What a send did, IN THREE ANSWERS, NOT TWO.
 *
 *   SENT      Gmail answered 200 with the message it created. Its id is the proof.
 *   NOT_SENT  it is KNOWN that nothing left: the request never reached Gmail (no connection could
 *             be made), or Gmail answered and refused it (a 4xx). Safe to try again.
 *   UNKNOWN   Loop cannot prove what Gmail did: the connection dropped or timed out after the
 *             request may have been transmitted, Gmail answered 5xx, or it answered 200 with
 *             something unreadable. Gmail has no idempotency key for `messages.send`, so trying
 *             again here is how one reply becomes two. UNKNOWN is reconciled, never retried.
 */
export type GmailSendOutcome =
  | { readonly delivery: 'SENT'; readonly messageId: string; readonly threadId: string }
  | { readonly delivery: 'NOT_SENT'; readonly failure: GmailSendFailure }
  | { readonly delivery: 'UNKNOWN'; readonly reason: 'TIMEOUT' | 'NETWORK' | 'UNAVAILABLE' | 'MALFORMED' };

/**
 * Why a send is known not to have happened. A history position cannot expire on a send, so
 * `CURSOR_EXPIRED` is not among them -- and every value here is one `work_drafts` will store.
 */
export type GmailSendFailure = Exclude<GmailReadFailure, 'CURSOR_EXPIRED'> | 'REJECTED';

/**
 * One message from the employee's own Sent mail, as reconciliation needs it: where it is, when,
 * to whom, and its words -- read to compare, and never stored.
 */
export interface GmailSentCandidate {
  readonly messageId: string;
  readonly threadId: string;
  readonly internalDate: Date;
  readonly subject: string | null;
  readonly recipients: readonly string[];
  /** The plain text of the message, or null when it has none Loop can read. */
  readonly text: string | null;
}

/**
 * What Gmail's Sent mail showed around one attempt.
 *
 * `complete` is true only when the listing provably covered the whole attempt window -- every
 * page read, nothing truncated, and no request failed. An incomplete look that finds nothing
 * proves nothing.
 */
export type GmailSentLookup =
  | { readonly ok: true; readonly candidates: readonly GmailSentCandidate[]; readonly complete: boolean }
  | { readonly ok: false; readonly failure: GmailReadFailure };

/** The connection states the database layer reports, mapped to why a read could not happen. */
export function gmailFailureForConnectionState(
  state: 'NOT_CONFIGURED' | 'NOT_PERMITTED' | 'NOT_CONNECTED' | 'INSUFFICIENT_SCOPE' | 'EXPIRED' | 'UNAVAILABLE',
): 'NOT_CONNECTED' | 'CAPABILITY_NOT_GRANTED' | 'AUTHORIZATION_EXPIRED' | 'UNAVAILABLE' {
  switch (state) {
    case 'NOT_CONNECTED':
    case 'NOT_CONFIGURED':
    case 'NOT_PERMITTED':
      return 'NOT_CONNECTED';
    case 'INSUFFICIENT_SCOPE':
      return 'CAPABILITY_NOT_GRANTED';
    case 'EXPIRED':
      return 'AUTHORIZATION_EXPIRED';
    default:
      return 'UNAVAILABLE';
  }
}

/** How a Gmail read failure is recorded on a sync run (`work_sync_runs.failureClass`, DL-1). */
export function workSyncFailureForGmailFailure(failure: GmailReadFailure): WorkSyncFailureClass {
  switch (failure) {
    case 'NOT_CONNECTED':
    case 'CAPABILITY_NOT_GRANTED':
    case 'AUTHORIZATION_EXPIRED':
    case 'AUTH':
    case 'FORBIDDEN':
      return 'AUTH';
    case 'RATE_LIMITED':
      return 'RATE_LIMITED';
    case 'CURSOR_EXPIRED':
      return 'CURSOR_EXPIRED';
    case 'NETWORK':
      return 'NETWORK';
    case 'TIMEOUT':
      return 'TIMEOUT';
    case 'MALFORMED':
      return 'MALFORMED';
    default:
      return 'UNAVAILABLE';
  }
}

// --- Addresses ------------------------------------------------------------------------------

/**
 * Parse one RFC 5322 address list into addresses.
 *
 * Deliberately small: it reads `Name <a@b>`, `<a@b>` and `a@b`, separated by commas that are
 * not inside quotes or angle brackets. It is not a full grammar, and it fails to an empty list
 * rather than to a guess -- an address Loop cannot read is one it must not claim to know.
 */
export function parseGmailAddressList(value: string | null | undefined): GmailAddress[] {
  if (typeof value !== 'string' || value.trim() === '') return [];
  const out: GmailAddress[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  const flush = () => {
    const parsed = parseOneGmailAddress(current);
    if (parsed) out.push(parsed);
    current = '';
  };
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '<') depth += 1;
    if (!quoted && ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0 && !quoted) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return out;
}

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

function parseOneGmailAddress(raw: string): GmailAddress | null {
  const text = raw.trim();
  if (text === '') return null;
  const angled = /^(.*)<([^>]*)>\s*$/.exec(text);
  const address = (angled?.[2] ?? text).trim().replace(/^mailto:/i, '');
  if (!ADDRESS.test(address)) return null;
  const label = angled?.[1]?.trim() ?? '';
  const name = label ? label.replace(/^"(.*)"$/, '$1').trim() || null : null;
  return { address: address.toLowerCase(), name };
}

/** One address, normalized for comparison and hashing. Gmail addresses are case-insensitive. */
export function normalizeGmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** The `References` header as a list of message ids, in order. */
export function parseGmailReferences(value: string | null | undefined): string[] {
  if (typeof value !== 'string') return [];
  return (value.match(/<[^>\s]+>/g) ?? []).map((v) => v.trim());
}
