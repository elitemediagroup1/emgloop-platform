// The Gmail sensor: bounded reads of one employee's own mailbox, normalized into the
// provider-neutral facts in @emgloop/shared (GM-1).
//
// Architecture: docs/architecture/daily-loop-employee-intelligence.md §6, §8 and §17.
//
// OBSERVES AND EMITS; DECIDES NOTHING. It does not rank, classify, summarize or store. Every
// request is bounded, the network is injected, and no credential is held beyond one call.
//
// THE SYNC READ NEVER ASKS FOR A BODY. `format=metadata` returns headers, labels and
// timestamps and Gmail does not send the payload at all -- so the only Gmail read that is ever
// persisted cannot carry correspondence even by accident. A body is read by `readGoogleGmailThread`,
// when an employee opens a conversation, and is handed straight back to that request.
//
// SYNCHRONIZATION FOLLOWS GOOGLE'S OWN GUIDE (verified 2026-09-18):
//   full     `messages.list` bounded by `q=newer_than:Nd`, then `messages.get` per id. The
//            mailbox's current `historyId` is read FIRST, from `getProfile`, so a message that
//            arrives during the listing is replayed by the next incremental pass rather than
//            missed. Replaying it is free: every write is an upsert.
//   partial  `history.list?startHistoryId=`, which returns what changed and the new boundary.
//            Gmail answers 404 when the id is older than it keeps ("at least one week, often
//            longer"), which is CURSOR_EXPIRED and means one bounded re-baseline.
//
// `q` IS AVAILABLE HERE AND WAS NOT BEFORE. Gmail forbids `q` under the metadata scope; under
// `gmail.readonly` it is permitted, which is what lets the first read be bounded by age
// instead of downloading a mailbox.

import {
  parseGmailAddressList,
  parseGmailReferences,
  type GmailAddress,
  type GmailMessageBody,
  type GmailMessageFact,
  type GmailReadFailure,
  type GmailReadResult,
  type GmailSendResult,
  type GmailThreadMessage,
  type GmailThreadResult,
} from '@emgloop/shared';

import { GOOGLE_OAUTH_TIMEOUT_MS } from './oauth';

export const GOOGLE_GMAIL_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Google's own maximum for a list page is 500. Loop asks for 100 and never more than 500. */
export const GOOGLE_GMAIL_PAGE_SIZE = 100;
export const GOOGLE_GMAIL_MAX_PAGE_SIZE = 500;

/**
 * How much one pass may read. A read is BOUNDED in three directions at once: how far back it
 * looks, how many list pages it follows, and how many individual messages it fetches.
 *
 * THE MESSAGE BOUND IS THE ONE THAT MATTERS. Each message costs its own `messages.get`, and a
 * mailbox with ten thousand recent messages would otherwise become ten thousand requests
 * against a per-user quota. When the bound is reached the page says `truncated`, no cursor is
 * stored, and the next pass continues -- which is safe because every write is an upsert.
 */
export const GOOGLE_GMAIL_MAX_PAGES = 10;
export const GOOGLE_GMAIL_MAX_MESSAGES_PER_PASS = 250;

/** The first read's window, in days. Daily Loop reasons about now, not about a lifetime. */
export const GOOGLE_GMAIL_INITIAL_DAYS = 14;

/** The headers the sync read asks for. Nothing else is requested, so nothing else arrives. */
export const GOOGLE_GMAIL_METADATA_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References'] as const;

/** How deep the MIME walk goes, and how much text one message may yield. */
export const GOOGLE_GMAIL_MAX_MIME_DEPTH = 12;
export const GOOGLE_GMAIL_MAX_BODY_CHARS = 200_000;

type GmailFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface GmailCallOptions {
  readonly fetchImpl: GmailFetch;
  /** An access token for THIS employee's connection. Never stored, never logged. */
  readonly accessToken: string;
  readonly timeoutMs?: number;
  /** The connected account's own address, so `fromSelf` is a fact rather than a guess. */
  readonly selfAddress?: string | null;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxMessages?: number;
}

export interface GmailWindowRequest extends GmailCallOptions {
  /** How far back the first read looks. */
  readonly newerThanDays?: number;
}

export interface GmailChangesRequest extends GmailCallOptions {
  readonly startHistoryId: string;
}

// --- HTTP ------------------------------------------------------------------------------------

function failureForStatus(status: number, payload: unknown): GmailReadFailure {
  const error = payload && typeof payload === 'object' ? ((payload as { error?: unknown }).error as Record<string, unknown> | undefined) : undefined;
  const reasons = Array.isArray(error?.errors)
    ? (error!.errors as Record<string, unknown>[]).map((e) => (typeof e.reason === 'string' ? e.reason : '')).filter((r) => r !== '')
    : [];
  const rateLimited = reasons.some((r) => r === 'rateLimitExceeded' || r === 'userRateLimitExceeded' || r === 'quotaExceeded');
  if (status === 401) return 'AUTH';
  // A 403 is two different things: "slow down" and "you may not". Google says which.
  if (status === 403) return rateLimited ? 'RATE_LIMITED' : 'FORBIDDEN';
  // Gmail answers 404 to history.list when the cursor is older than it keeps. On any other
  // path a 404 is a message or thread that is gone, which the caller reads as UNAVAILABLE.
  if (status === 404) return 'CURSOR_EXPIRED';
  if (status === 429) return 'RATE_LIMITED';
  return 'UNAVAILABLE';
}

async function get(
  options: GmailCallOptions,
  path: string,
  params?: URLSearchParams,
): Promise<{ readonly ok: true; readonly payload: Record<string, unknown> } | { readonly ok: false; readonly failure: GmailReadFailure }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? GOOGLE_OAUTH_TIMEOUT_MS);
  try {
    const url = params ? `${GOOGLE_GMAIL_ENDPOINT}${path}?${params.toString()}` : `${GOOGLE_GMAIL_ENDPOINT}${path}`;
    const response = await options.fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${options.accessToken}`, accept: 'application/json' },
      signal: controller.signal,
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.status !== 200) return { ok: false, failure: failureForStatus(response.status, payload) };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, failure: 'MALFORMED' };
    return { ok: true, payload: payload as Record<string, unknown> };
  } catch (error) {
    return { ok: false, failure: (error as { name?: string } | null)?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}

// --- Normalization -------------------------------------------------------------------------

function headerMap(payload: Record<string, unknown>): Map<string, string> {
  const headers = Array.isArray(payload.headers) ? (payload.headers as Record<string, unknown>[]) : [];
  const map = new Map<string, string>();
  for (const header of headers) {
    if (typeof header.name === 'string' && typeof header.value === 'string') {
      // First wins: a forged duplicate header cannot displace the real one.
      const key = header.name.toLowerCase();
      if (!map.has(key)) map.set(key, header.value);
    }
  }
  return map;
}

const ONE = (list: GmailAddress[]): GmailAddress | null => list[0] ?? null;

/** One message's metadata, from what Gmail returned. Null when it is not a message Loop can state. */
export function gmailMessageFact(raw: Record<string, unknown>, selfAddress: string | null): GmailMessageFact | null {
  const messageId = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null;
  const threadId = typeof raw.threadId === 'string' && raw.threadId !== '' ? raw.threadId : null;
  if (!messageId || !threadId) return null;

  // Gmail reports internalDate as a string of epoch milliseconds.
  const millis = typeof raw.internalDate === 'string' ? Number(raw.internalDate) : NaN;
  if (!Number.isFinite(millis)) return null;

  const payload = (raw.payload ?? {}) as Record<string, unknown>;
  const headers = headerMap(payload);
  const from = ONE(parseGmailAddressList(headers.get('from')));
  const self = selfAddress ? selfAddress.trim().toLowerCase() : null;
  const labels = Array.isArray(raw.labelIds) ? (raw.labelIds as unknown[]).filter((l): l is string => typeof l === 'string') : [];

  return {
    provider: 'GOOGLE',
    messageId,
    threadId,
    internalDate: new Date(millis),
    labels,
    from,
    to: parseGmailAddressList(headers.get('to')),
    cc: parseGmailAddressList(headers.get('cc')),
    subject: headers.get('subject') ?? null,
    headerMessageId: headers.get('message-id') ?? null,
    inReplyTo: headers.get('in-reply-to') ?? null,
    references: parseGmailReferences(headers.get('references')),
    // SENT is Gmail's own answer to "did this account send it", and the From address is the
    // other. Either is enough; neither is inferred from the absence of the other.
    fromSelf: labels.includes('SENT') || (self !== null && from?.address === self),
  };
}

function decodeBase64Url(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Walk one message's MIME tree for its text, its HTML and the FACTS about its attachments.
 *
 * Bounded in depth and in characters, and it never fetches an attachment: a filename, a type
 * and a size are enough to tell a reader something is attached, and downloading somebody's
 * attachments is a product Loop has not built.
 */
export function gmailMessageBody(messageId: string, payload: Record<string, unknown>): GmailMessageBody {
  let text: string | null = null;
  let html: string | null = null;
  const attachments: { filename: string; mimeType: string; bytes: number }[] = [];
  let truncated = false;

  const visit = (part: Record<string, unknown>, depth: number): void => {
    if (depth > GOOGLE_GMAIL_MAX_MIME_DEPTH) {
      truncated = true;
      return;
    }
    const mimeType = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase() : '';
    const filename = typeof part.filename === 'string' ? part.filename : '';
    const body = (part.body ?? {}) as Record<string, unknown>;
    const size = typeof body.size === 'number' ? body.size : 0;

    if (filename !== '') {
      attachments.push({ filename, mimeType: mimeType || 'application/octet-stream', bytes: size });
    } else if (mimeType === 'text/plain' && text === null) {
      text = decodeBase64Url(body.data);
    } else if (mimeType === 'text/html' && html === null) {
      html = decodeBase64Url(body.data);
    }

    const parts = Array.isArray(part.parts) ? (part.parts as Record<string, unknown>[]) : [];
    for (const child of parts) visit(child, depth + 1);
  };
  visit(payload, 0);

  const cap = (value: string | null): string | null => {
    if (value === null) return null;
    if (value.length <= GOOGLE_GMAIL_MAX_BODY_CHARS) return value;
    truncated = true;
    return value.slice(0, GOOGLE_GMAIL_MAX_BODY_CHARS);
  };
  return { messageId, text: cap(text), html: cap(html), attachments, truncated };
}

// --- Reads ------------------------------------------------------------------------------------

async function fetchMessages(
  options: GmailCallOptions,
  ids: readonly string[],
  format: 'metadata' | 'full',
): Promise<{ readonly ok: true; readonly raw: Record<string, unknown>[] } | { readonly ok: false; readonly failure: GmailReadFailure }> {
  const raw: Record<string, unknown>[] = [];
  for (const id of ids) {
    const params = new URLSearchParams({ format });
    if (format === 'metadata') for (const header of GOOGLE_GMAIL_METADATA_HEADERS) params.append('metadataHeaders', header);
    const answer = await get(options, `/messages/${encodeURIComponent(id)}`, params);
    if (!answer.ok) {
      // A message that vanished between the list and the read is not a failed pass: the mailbox
      // moved, and the next pass sees the mailbox as it is now.
      if (answer.failure === 'CURSOR_EXPIRED' || answer.failure === 'UNAVAILABLE') continue;
      return { ok: false, failure: answer.failure };
    }
    raw.push(answer.payload);
  }
  return { ok: true, raw };
}

/**
 * The first, bounded read: recent messages, newest first, with the mailbox's current boundary
 * captured BEFORE the listing so nothing that arrives mid-read is lost.
 */
export async function readGoogleGmailWindow(request: GmailWindowRequest): Promise<GmailReadResult> {
  const profile = await get(request, '/profile');
  if (!profile.ok) return { ok: false, failure: profile.failure === 'CURSOR_EXPIRED' ? 'UNAVAILABLE' : profile.failure };
  const boundary = typeof profile.payload.historyId === 'string' ? profile.payload.historyId : null;

  const days = Math.max(1, request.newerThanDays ?? GOOGLE_GMAIL_INITIAL_DAYS);
  const maxPages = Math.max(1, request.maxPages ?? GOOGLE_GMAIL_MAX_PAGES);
  const maxMessages = Math.max(1, request.maxMessages ?? GOOGLE_GMAIL_MAX_MESSAGES_PER_PASS);
  const pageSize = Math.min(Math.max(1, request.pageSize ?? GOOGLE_GMAIL_PAGE_SIZE), GOOGLE_GMAIL_MAX_PAGE_SIZE);

  const ids: string[] = [];
  let pageToken: string | null = null;
  let pagesRead = 0;
  let truncated = false;

  for (; pagesRead < maxPages; ) {
    const params = new URLSearchParams({ q: `newer_than:${days}d`, maxResults: String(pageSize) });
    if (pageToken) params.set('pageToken', pageToken);
    const answer = await get(request, '/messages', params);
    if (!answer.ok) return { ok: false, failure: answer.failure === 'CURSOR_EXPIRED' ? 'UNAVAILABLE' : answer.failure };
    pagesRead += 1;
    const list = Array.isArray(answer.payload.messages) ? (answer.payload.messages as Record<string, unknown>[]) : [];
    for (const entry of list) if (typeof entry.id === 'string') ids.push(entry.id);
    pageToken = typeof answer.payload.nextPageToken === 'string' ? answer.payload.nextPageToken : null;
    if (ids.length >= maxMessages || !pageToken) break;
  }
  if (pageToken) truncated = true;
  if (ids.length > maxMessages) {
    ids.length = maxMessages;
    truncated = true;
  }

  const messages = await fetchMessages(request, ids, 'metadata');
  if (!messages.ok) return { ok: false, failure: messages.failure };
  const self = request.selfAddress ?? null;
  const facts = messages.raw.map((raw) => gmailMessageFact(raw, self)).filter((f): f is GmailMessageFact => f !== null);

  return {
    ok: true,
    page: {
      messages: facts,
      removedMessageIds: [],
      // A truncated first read has no boundary to keep: storing one would skip what it did not
      // reach. The next pass reads the same window again, which is safe and idempotent.
      nextHistoryId: truncated ? null : boundary,
      nextPageToken: pageToken,
      truncated,
      pagesRead,
    },
  };
}

/** Everything that changed since a cursor. Gmail's own incremental mechanism. */
export async function readGoogleGmailChanges(request: GmailChangesRequest): Promise<GmailReadResult> {
  const maxPages = Math.max(1, request.maxPages ?? GOOGLE_GMAIL_MAX_PAGES);
  const maxMessages = Math.max(1, request.maxMessages ?? GOOGLE_GMAIL_MAX_MESSAGES_PER_PASS);
  const pageSize = Math.min(Math.max(1, request.pageSize ?? GOOGLE_GMAIL_PAGE_SIZE), GOOGLE_GMAIL_MAX_PAGE_SIZE);

  const changed = new Set<string>();
  const removed = new Set<string>();
  let pageToken: string | null = null;
  let boundary: string | null = null;
  let pagesRead = 0;
  let truncated = false;

  for (; pagesRead < maxPages; ) {
    const params = new URLSearchParams({ startHistoryId: request.startHistoryId, maxResults: String(pageSize) });
    for (const type of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) params.append('historyTypes', type);
    if (pageToken) params.set('pageToken', pageToken);
    const answer = await get(request, '/history', params);
    if (!answer.ok) return { ok: false, failure: answer.failure };
    pagesRead += 1;

    if (typeof answer.payload.historyId === 'string') boundary = answer.payload.historyId;
    const history = Array.isArray(answer.payload.history) ? (answer.payload.history as Record<string, unknown>[]) : [];
    for (const record of history) {
      for (const key of ['messagesAdded', 'labelsAdded', 'labelsRemoved']) {
        const entries = Array.isArray(record[key]) ? (record[key] as Record<string, unknown>[]) : [];
        for (const entry of entries) {
          const message = (entry.message ?? {}) as Record<string, unknown>;
          if (typeof message.id === 'string') changed.add(message.id);
        }
      }
      const deletions = Array.isArray(record.messagesDeleted) ? (record.messagesDeleted as Record<string, unknown>[]) : [];
      for (const entry of deletions) {
        const message = (entry.message ?? {}) as Record<string, unknown>;
        if (typeof message.id === 'string') {
          removed.add(message.id);
          changed.delete(message.id);
        }
      }
    }
    pageToken = typeof answer.payload.nextPageToken === 'string' ? answer.payload.nextPageToken : null;
    if (changed.size >= maxMessages || !pageToken) break;
  }
  if (pageToken) truncated = true;

  const ids = [...changed].slice(0, maxMessages);
  if (ids.length < changed.size) truncated = true;
  const messages = await fetchMessages(request, ids, 'metadata');
  if (!messages.ok) return { ok: false, failure: messages.failure };
  const self = request.selfAddress ?? null;
  const facts = messages.raw.map((raw) => gmailMessageFact(raw, self)).filter((f): f is GmailMessageFact => f !== null);

  return {
    ok: true,
    page: {
      messages: facts,
      removedMessageIds: [...removed],
      nextHistoryId: truncated ? null : boundary,
      nextPageToken: pageToken,
      truncated,
      pagesRead,
    },
  };
}

/**
 * One conversation, with bodies, read when an employee opens it. NEVER PERSISTED.
 *
 * Bounded by the same message ceiling as a sync pass: a thread with a thousand messages is
 * read as its most recent ones rather than in full.
 */
export async function readGoogleGmailThread(request: GmailCallOptions & { readonly threadId: string }): Promise<GmailThreadResult> {
  const answer = await get(request, `/threads/${encodeURIComponent(request.threadId)}`, new URLSearchParams({ format: 'full' }));
  if (!answer.ok) return { ok: false, failure: answer.failure === 'CURSOR_EXPIRED' ? 'UNAVAILABLE' : answer.failure };

  const raw = Array.isArray(answer.payload.messages) ? (answer.payload.messages as Record<string, unknown>[]) : [];
  const self = request.selfAddress ?? null;
  const limit = Math.max(1, request.maxMessages ?? GOOGLE_GMAIL_MAX_MESSAGES_PER_PASS);
  const messages: GmailThreadMessage[] = [];
  for (const entry of raw.slice(-limit)) {
    const fact = gmailMessageFact(entry, self);
    if (!fact) continue;
    messages.push({ fact, body: gmailMessageBody(fact.messageId, (entry.payload ?? {}) as Record<string, unknown>) });
  }
  messages.sort((a, b) => a.fact.internalDate.getTime() - b.fact.internalDate.getTime());
  return { ok: true, thread: { threadId: request.threadId, messages } };
}

// --- Send ---------------------------------------------------------------------------------------

/**
 * Send one already-composed message, as the connected person.
 *
 * IT COMPOSES NOTHING. The raw RFC 5322 message is built and checked elsewhere (@emgloop/shared
 * `buildGmailReply`) so that what is sent can be tested without a network, and so that this
 * function cannot quietly decide a recipient. `threadId` is passed as Gmail's reference
 * documents: with matching `References`/`In-Reply-To` and Subject it is what places a reply in
 * the conversation rather than beside it.
 */
export async function sendGoogleGmailMessage(request: GmailCallOptions & {
  readonly rawMessage: string;
  readonly threadId: string | null;
}): Promise<GmailSendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? GOOGLE_OAUTH_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = { raw: request.rawMessage };
    if (request.threadId) body.threadId = request.threadId;
    const response = await request.fetchImpl(`${GOOGLE_GMAIL_ENDPOINT}/messages/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${request.accessToken}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.status !== 200) {
      const failure = failureForStatus(response.status, payload);
      return { ok: false, failure: failure === 'CURSOR_EXPIRED' ? 'UNAVAILABLE' : failure };
    }
    const sent = (payload ?? {}) as Record<string, unknown>;
    if (typeof sent.id !== 'string' || typeof sent.threadId !== 'string') return { ok: false, failure: 'MALFORMED' };
    return { ok: true, messageId: sent.id, threadId: sent.threadId };
  } catch (error) {
    return { ok: false, failure: (error as { name?: string } | null)?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}
