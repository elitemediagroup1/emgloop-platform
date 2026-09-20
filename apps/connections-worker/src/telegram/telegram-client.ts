// The LIVE Telegram MTProto client (teleproto, the maintained gramjs fork), bound to the two ports
// the rest of the worker depends on. THIS FILE IS THE ONLY PLACE teleproto is imported: everything
// else speaks TelegramClientPort / TelegramLoginPort, so the SDK can be swapped or upgraded without
// touching the adapter, the login coordinator, the mapping or the sweep.
//
// UNPROVEN UNTIL RUN AGAINST REAL TELEGRAM. The logic that surrounds it (mapping, adapter, login
// coordinator, sweep) is fully tested with fakes; this binding can only be validated on the deployed
// staging worker against a real account. It is written against teleproto's verified API and kept
// deliberately thin.
//
// SECRETS AND CONTENT. api_id/api_hash come from the injected config (Secrets Manager at runtime),
// never hard-coded, never logged. The session string is a secret: it is produced by save() and
// handed straight to the caller to seal; this file never logs it. Message text is read ONLY as a
// boolean (`hadText`) and never stored, logged or returned. There is no send/reply/react/read here.

import { TelegramClient, Api } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { computeCheck } from 'teleproto/Password';

import type { TelegramClientHandle, TelegramClientPort } from './telegram-adapter';
import { TelegramAuthError, TelegramFloodWaitError } from './telegram-adapter';
import type { TelegramMessageFacts } from './content-free-mapping';
import type { TelegramLoginBinding, TelegramLoginFailure, TelegramLoginPort, TelegramAuthorization } from './telegram-login';

export interface TelegramAppCredentials {
  readonly apiId: number;
  readonly apiHash: string;
}

/** How many dialogs and how many recent messages per dialog one observation cycle looks at. */
const DIALOG_LIMIT = 50;
const PER_DIALOG_LIMIT = 30;

function newClient(creds: TelegramAppCredentials, session: string): TelegramClient {
  return new TelegramClient(new StringSession(session), creds.apiId, creds.apiHash, { connectionRetries: 3, autoReconnect: true });
}

/** Read ONLY metadata off a live message. Never returns the text -- only whether there was any. */
function factsOf(message: any): TelegramMessageFacts | null {
  if (message?.id === undefined || message?.id === null) return null;
  const chatId = message.chatId ?? message.peerId;
  if (chatId === undefined || chatId === null) return null;
  const senderId = message.senderId ?? null;
  const participantIds = [senderId, chatId].filter((v) => v !== null && v !== undefined).map((v) => String(v));
  return {
    messageId: String(message.id),
    chatId: String(chatId),
    senderId: senderId === null ? null : String(senderId),
    participantIds: [...new Set(participantIds)],
    out: Boolean(message.out),
    dateSeconds: typeof message.date === 'number' ? message.date : Math.floor(Date.now() / 1000),
    hadText: Boolean(message.message), // the boolean only -- the text itself is never read out
  };
}

/**
 * Parse Telegram's FLOOD_WAIT into a seconds value, from either a structured `seconds` field or
 * the FLOOD_WAIT_<n> message. Never logs the code or the session; returns null when it is not one.
 */
function floodWaitSecondsOf(err: unknown): number | null {
  const e = err as { seconds?: unknown; errorMessage?: string; message?: string };
  if (typeof e?.seconds === 'number' && Number.isFinite(e.seconds)) return e.seconds;
  const msg = e?.errorMessage ?? e?.message ?? '';
  const m = /FLOOD_WAIT_(\d+)/i.exec(msg);
  return m ? Number(m[1]) : null;
}

/**
 * The observation client: resume an authorized session, fetch recent message metadata, close.
 *
 * The fetch is the simple v1 strategy: enumerate recent dialogs and read the most recent messages
 * in each, mapping only metadata. The sink is idempotent on providerEventId, so re-reading the same
 * messages never duplicates; the cursor is advanced best-effort to the highest message id seen.
 * (A later refinement can move to updates.getDifference with stored pts/qts.)
 */
export function createTelegramClientPort(creds: TelegramAppCredentials): TelegramClientPort {
  return {
    async connectFromSession(session: string): Promise<TelegramClientHandle> {
      const client = newClient(creds, session);
      try {
        await client.connect();
      } catch (err) {
        await client.disconnect().catch(() => undefined);
        throw new TelegramAuthError(`could not connect: ${(err as Error)?.name ?? 'error'}`);
      }
      const authorized = await client.isUserAuthorized().catch(() => false);
      if (!authorized) {
        await client.disconnect().catch(() => undefined);
        throw new TelegramAuthError();
      }
      return { kind: 'telegram-mtproto', client };
    },

    async fetchSince(handle: TelegramClientHandle, cursor: string | null): Promise<readonly TelegramMessageFacts[]> {
      const client = handle.client as TelegramClient;
      const minId = cursor ? Number(cursor) : 0;
      const collected: TelegramMessageFacts[] = [];
      const dialogs = await client.getDialogs({ limit: DIALOG_LIMIT });
      for (const dialog of dialogs) {
        const entity = (dialog as any).entity ?? (dialog as any).inputEntity;
        if (!entity) continue;
        const messages = await client.getMessages(entity, { limit: PER_DIALOG_LIMIT, minId: Number.isFinite(minId) ? minId : 0 });
        for (const message of messages) {
          const facts = factsOf(message);
          if (facts) collected.push(facts);
        }
      }
      return collected;
    },

    async fetchHistory(handle, request): Promise<readonly TelegramMessageFacts[]> {
      // Walk BACKWARD from the checkpoint offset toward the floor, reading ONLY metadata. This never
      // advances the live observation cursor. FLOOD_WAIT is surfaced as TelegramFloodWaitError so the
      // baseline can back off; no code or session is ever logged.
      const client = handle.client as TelegramClient;
      const { beforeId, floorAt, limit } = request;
      const floorSeconds = Math.floor(floorAt.getTime() / 1000);
      const perDialog = Math.min(Math.max(1, limit), 100);
      const collected: TelegramMessageFacts[] = [];
      try {
        const dialogs = await client.getDialogs({ limit: DIALOG_LIMIT });
        for (const dialog of dialogs) {
          const entity = (dialog as any).entity ?? (dialog as any).inputEntity;
          if (!entity) continue;
          const opts: Record<string, unknown> = { limit: perDialog };
          if (beforeId !== null && Number.isFinite(beforeId)) opts.offsetId = beforeId; // messages older than this id
          const messages = await client.getMessages(entity, opts as any);
          for (const message of messages) {
            const facts = factsOf(message);
            if (!facts) continue;
            if (facts.dateSeconds < floorSeconds) continue; // below the floor: out of the chosen window
            if (beforeId !== null && Number.isFinite(beforeId) && !(Number(facts.messageId) < beforeId)) continue;
            collected.push(facts);
            if (collected.length >= limit) return collected;
          }
        }
      } catch (err) {
        const flood = floodWaitSecondsOf(err);
        if (flood !== null) throw new TelegramFloodWaitError(flood);
        throw err;
      }
      return collected;
    },

    async close(handle: TelegramClientHandle): Promise<void> {
      await (handle.client as TelegramClient).disconnect().catch(() => undefined);
    },

    async logOut(handle: TelegramClientHandle): Promise<void> {
      // Revoke this authorization at Telegram, then drop the socket. Best-effort: disconnect wins
      // regardless so Loop never keeps a live client after a disconnect.
      const client = handle.client as TelegramClient;
      try {
        await client.invoke(new Api.auth.LogOut());
      } finally {
        await client.disconnect().catch(() => undefined);
      }
    },
  };
}

// --- Login (session establishment) -------------------------------------------------------------

interface PendingLogin {
  readonly client: TelegramClient;
  readonly phone: string;
  phoneCodeHash: string | null;
}

function classifyLoginError(err: unknown): TelegramLoginFailure {
  const msg = (err as { errorMessage?: string; message?: string })?.errorMessage ?? (err as Error)?.message ?? '';
  if (/PHONE_NUMBER_INVALID/i.test(msg)) return 'PHONE_INVALID';
  if (/PHONE_CODE_INVALID/i.test(msg)) return 'CODE_INVALID';
  if (/PHONE_CODE_EXPIRED/i.test(msg)) return 'CODE_EXPIRED';
  if (/PASSWORD_HASH_INVALID|PASSWORD_INVALID/i.test(msg)) return 'PASSWORD_INVALID';
  if (/FLOOD_WAIT/i.test(msg)) return 'FLOOD_WAIT';
  return 'UNAVAILABLE';
}

function bindingKey(b: TelegramLoginBinding): string {
  return `${b.organizationId}:${b.userId}`;
}

async function authorizationFrom(client: TelegramClient): Promise<TelegramAuthorization> {
  // save() returns the session string -- a SECRET. It goes straight to the sealer via the caller.
  const session = String(client.session.save());
  let accountLabel: string | null = null;
  try {
    const me: any = await client.getMe();
    accountLabel = me?.username ? `@${me.username}` : null; // display-only handle, never an id key
  } catch {
    accountLabel = null;
  }
  return { session, accountLabel, backgroundObservation: 'OPERATIONAL' };
}

/**
 * The login client: holds one in-progress, not-yet-authorized client per (org, user) between the
 * code request and sign-in. Nothing here persists a phone, code, password or session string.
 */
export function createTelegramLoginPort(creds: TelegramAppCredentials): TelegramLoginPort {
  const pending = new Map<string, PendingLogin>();

  async function drop(key: string): Promise<void> {
    const p = pending.get(key);
    pending.delete(key);
    if (p) await p.client.disconnect().catch(() => undefined);
  }

  return {
    inProgress(binding: TelegramLoginBinding): boolean {
      return pending.has(bindingKey(binding));
    },

    async begin(binding, phone) {
      const key = bindingKey(binding);
      await drop(key); // one login at a time per person
      const client = newClient(creds, '');
      try {
        await client.connect();
        const { phoneCodeHash } = await client.sendCode({ apiId: creds.apiId, apiHash: creds.apiHash }, phone);
        pending.set(key, { client, phone, phoneCodeHash });
        return { ok: true as const };
      } catch (err) {
        await client.disconnect().catch(() => undefined);
        return { ok: false as const, reason: classifyLoginError(err) };
      }
    },

    async submitCode(binding, code) {
      const key = bindingKey(binding);
      const p = pending.get(key);
      if (!p || !p.phoneCodeHash) return { ok: false as const, reason: 'UNAVAILABLE' as const };
      try {
        await p.client.invoke(new Api.auth.SignIn({ phoneNumber: p.phone, phoneCodeHash: p.phoneCodeHash, phoneCode: code }));
        return { ok: true as const, authorization: await authorizationFrom(p.client) };
      } catch (err) {
        const msg = (err as { errorMessage?: string })?.errorMessage ?? (err as Error)?.message ?? '';
        if (/SESSION_PASSWORD_NEEDED/i.test(msg)) return { ok: 'PASSWORD_NEEDED' as const };
        return { ok: false as const, reason: classifyLoginError(err) };
      }
    },

    async submitPassword(binding, password) {
      const key = bindingKey(binding);
      const p = pending.get(key);
      if (!p) return { ok: false as const, reason: 'UNAVAILABLE' as const };
      try {
        const pwd = await p.client.invoke(new Api.account.GetPassword());
        const check = await computeCheck(pwd, password);
        await p.client.invoke(new Api.auth.CheckPassword({ password: check }));
        return { ok: true as const, authorization: await authorizationFrom(p.client) };
      } catch (err) {
        return { ok: false as const, reason: classifyLoginError(err) };
      }
    },

    async cancel(binding) {
      await drop(bindingKey(binding));
    },
  };
}
