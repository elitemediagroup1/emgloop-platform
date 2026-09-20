// Telegram session establishment: the interactive phone -> code -> (2FA) -> authorized flow, as
// coordination logic behind a port. The live MTProto client that actually holds the connection
// between steps lives in TelegramLoginPort (the gramjs seam); this file owns WHAT HAPPENS at each
// step and WHAT IS STORED, so it is testable with a fake port.
//
// SECRETS NEVER LINGER AND NEVER LEAK. The phone number, the login code and the 2FA password pass
// through as arguments and are never stored, never returned, never logged. The authorized SESSION
// STRING is sealed immediately (the injected `seal`) and handed to the injected `store`; this file
// never logs it, never returns it, and does not keep it. On success the in-progress client is
// released -- the observation loop later RESUMES from the sealed session, it does not reuse the live
// login client.
//
// NOT A CLIENT. This establishes an authorized session so Loop can OBSERVE. There is no send, reply
// or history import here or anywhere the port leads.

import type { CapabilityStatus, ConnectionProvider } from '@emgloop/shared';

export interface TelegramLoginBinding {
  readonly organizationId: string;
  readonly userId: string;
}

/** A step's outcome, as the web UI renders it. Never carries a secret or a raw session string. */
export type TelegramLoginStatus =
  | { readonly step: 'CODE_SENT' }
  | { readonly step: 'PASSWORD_NEEDED' }
  | { readonly step: 'AUTHORIZED'; readonly accountLabel: string | null }
  | { readonly step: 'FAILED'; readonly reason: TelegramLoginFailure }
  | { readonly step: 'NO_LOGIN_IN_PROGRESS' };

export type TelegramLoginFailure =
  | 'PHONE_INVALID'
  | 'CODE_INVALID'
  | 'CODE_EXPIRED'
  | 'PASSWORD_INVALID'
  | 'NOT_CONFIGURED'
  | 'FLOOD_WAIT'
  | 'UNAVAILABLE';

/** The result of a completed authorization: the session string to seal, plus display-only facts. */
export interface TelegramAuthorization {
  /** The MTProto session string -- A SECRET. The coordinator seals it at once and never logs it. */
  readonly session: string;
  /** A display-only account label (e.g. a username/handle) if the provider offered one. Never an id key. */
  readonly accountLabel: string | null;
  /** Whether background observation is operational for this account (usually OPERATIONAL for MTProto). */
  readonly backgroundObservation: CapabilityStatus;
}

/**
 * The live MTProto login, as the coordinator needs it. The gramjs binding implements this and owns
 * the client held between steps. Every method is keyed by the binding (org + user), so one person's
 * in-progress login is never confused with another's.
 */
export interface TelegramLoginPort {
  /** Create a client and request a code for `phone`. Resolves CODE_SENT or FAILED. */
  begin(binding: TelegramLoginBinding, phone: string): Promise<{ ok: true } | { ok: false; reason: TelegramLoginFailure }>;
  /** Submit the code. Resolves to an authorization, a 2FA requirement, or a failure. */
  submitCode(binding: TelegramLoginBinding, code: string): Promise<
    { ok: true; authorization: TelegramAuthorization } | { ok: 'PASSWORD_NEEDED' } | { ok: false; reason: TelegramLoginFailure }
  >;
  /** Submit the 2FA password. Resolves to an authorization or a failure. */
  submitPassword(binding: TelegramLoginBinding, password: string): Promise<
    { ok: true; authorization: TelegramAuthorization } | { ok: false; reason: TelegramLoginFailure }
  >;
  /** Release any in-progress client for this binding. Idempotent; never throws. */
  cancel(binding: TelegramLoginBinding): Promise<void>;
  /** Whether a login is currently in progress for this binding. */
  inProgress(binding: TelegramLoginBinding): boolean;
}

export interface TelegramLoginDeps {
  readonly port: TelegramLoginPort;
  /** Seal the session string (org+user+provider+kind bound) and STORE it as the live credential. */
  readonly storeAuthorized: (
    binding: TelegramLoginBinding,
    authorization: TelegramAuthorization,
  ) => Promise<'STORED' | 'NOT_PERMITTED' | 'NO_ATTEMPT'>;
  /** Move the connection to CONNECTING/SETTING_UP when a login opens (best-effort; never throws). */
  readonly markConnecting: (binding: TelegramLoginBinding) => Promise<void>;
}

const PROVIDER: ConnectionProvider = 'TELEGRAM';

/**
 * Coordinates one person's Telegram login. The worker's control endpoints call these; the person
 * enters the phone, code and password through Loop's secure flow, and nothing here persists any of
 * those. On AUTHORIZED the session is sealed+stored and the live login client is released.
 */
export class TelegramLoginCoordinator {
  constructor(private readonly deps: TelegramLoginDeps) {}

  readonly provider = PROVIDER;

  async start(binding: TelegramLoginBinding, phone: string): Promise<TelegramLoginStatus> {
    if (typeof phone !== 'string' || phone.trim() === '') return { step: 'FAILED', reason: 'PHONE_INVALID' };
    await this.deps.markConnecting(binding);
    const result = await this.deps.port.begin(binding, phone.trim());
    if (!result.ok) return { step: 'FAILED', reason: result.reason };
    return { step: 'CODE_SENT' };
  }

  async submitCode(binding: TelegramLoginBinding, code: string): Promise<TelegramLoginStatus> {
    if (!this.deps.port.inProgress(binding)) return { step: 'NO_LOGIN_IN_PROGRESS' };
    if (typeof code !== 'string' || code.trim() === '') return { step: 'FAILED', reason: 'CODE_INVALID' };
    const result = await this.deps.port.submitCode(binding, code.trim());
    if (result.ok === 'PASSWORD_NEEDED') return { step: 'PASSWORD_NEEDED' };
    if (result.ok === false) return { step: 'FAILED', reason: result.reason };
    return this.finish(binding, result.authorization);
  }

  async submitPassword(binding: TelegramLoginBinding, password: string): Promise<TelegramLoginStatus> {
    if (!this.deps.port.inProgress(binding)) return { step: 'NO_LOGIN_IN_PROGRESS' };
    if (typeof password !== 'string' || password === '') return { step: 'FAILED', reason: 'PASSWORD_INVALID' };
    const result = await this.deps.port.submitPassword(binding, password);
    if (!result.ok) return { step: 'FAILED', reason: result.reason };
    return this.finish(binding, result.authorization);
  }

  async cancel(binding: TelegramLoginBinding): Promise<void> {
    await this.deps.port.cancel(binding);
  }

  /** Seal+store the session, then release the login client. The raw session never leaves here. */
  private async finish(binding: TelegramLoginBinding, authorization: TelegramAuthorization): Promise<TelegramLoginStatus> {
    const stored = await this.deps.storeAuthorized(binding, authorization);
    // Whether stored or not, the live login client has done its job -- release it either way.
    await this.deps.port.cancel(binding);
    if (stored === 'STORED') return { step: 'AUTHORIZED', accountLabel: authorization.accountLabel };
    // The membership went away, or the attempt was not open: fail closed, storing nothing.
    return { step: 'FAILED', reason: stored === 'NOT_PERMITTED' ? 'UNAVAILABLE' : 'UNAVAILABLE' };
  }
}
