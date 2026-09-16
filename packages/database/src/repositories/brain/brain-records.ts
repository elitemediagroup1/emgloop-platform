// How Brain rows and the Brain contracts turn into each other. Slice B4.
//
// Architecture: docs/architecture/brain-persistence.md.
//
// THE CONTRACTS DECIDE; THE ROWS REMEMBER. Every state change is decided by the pure
// functions in @emgloop/shared (`brainJobTransition`, `brainSubmissionDecision`,
// `brainWaitReplyDecision`, ...). This module only translates a row into the snapshot
// those functions take, and a decided snapshot back into the columns that changed.
//
// A ROW THAT DOES NOT READ AS A CONTRACT IS NOT GUESSED AT. A value outside the current
// vocabulary -- a result type this deployment does not know, a malformed result
// pointer -- makes the record unreadable, and the caller fails closed.
//
// WHAT A TRANSITION MAY CHANGE IS FIXED HERE. `brainJobChanges` refuses any decided
// snapshot that moved the job's identity, its principal, its task, its capability
// route, its result type, owner or subject. Promotion changes the execution class and
// nothing else it did not already own.
//
// CHECKPOINTS ARRIVE SEALED. This module stores ciphertext it cannot read, and refuses
// anything that looks like plaintext. Sealing is the executor's job, through
// `BrainPayloadSealer` (implemented with the execution environment's key service in a
// later slice); a test double is the only implementation in B4.

import { createHash } from 'crypto';
import type {
  BrainCommand as BrainCommandRow,
  BrainJob as BrainJobRow,
  BrainJobWait as BrainJobWaitRow,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import {
  BRAIN_CANCEL_REASONS,
  BRAIN_COMMAND_TYPES,
  BRAIN_EXECUTION_CLASSES,
  BRAIN_FAILURE_REASONS,
  BRAIN_JOB_STATES,
  BRAIN_RESULT_OWNERS,
  BRAIN_RESULT_SUBJECT_TYPES,
  BRAIN_RESULT_TYPES,
  BRAIN_WAIT_STATUSES,
  brainJobIsTerminal,
  isAiCapabilityRoute,
  type BrainCancelRequest,
  type BrainCommand,
  type BrainEventActor,
  type BrainJobSnapshot,
  type BrainResultRef,
  type BrainWaitRecord,
} from '@emgloop/shared';

export type BrainDb = PrismaClient | Prisma.TransactionClient;

/** Prisma's error code for a unique constraint violation. */
export const PRISMA_UNIQUE_VIOLATION = 'P2002';

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === PRISMA_UNIQUE_VIOLATION;
}

/** A stored Brain row that does not read as the current contract. Never guessed at. */
export class BrainRecordUnreadable extends Error {
  constructor(what: string) {
    super(`Brain record unreadable: ${what}`);
    this.name = 'BrainRecordUnreadable';
  }
}

/** A decided change that would break a persistence invariant. A bug, never a user error. */
export class BrainPersistenceInvariantError extends Error {
  constructor(what: string) {
    super(`Brain persistence invariant: ${what}`);
    this.name = 'BrainPersistenceInvariantError';
  }
}

function oneOf<T extends string>(list: readonly T[], value: string | null, what: string): T {
  if (value === null || !(list as readonly string[]).includes(value)) throw new BrainRecordUnreadable(what);
  return value as T;
}

// --- Actors ---------------------------------------------------------------------------

export interface BrainActorColumns {
  readonly kind: 'HUMAN' | 'SYSTEM' | 'POLICY';
  readonly userId: string | null;
  readonly policy: string | null;
}

export function brainActorColumns(actor: BrainEventActor): BrainActorColumns {
  switch (actor.kind) {
    case 'HUMAN':
      if (typeof actor.userId !== 'string' || actor.userId.trim() === '') throw new BrainPersistenceInvariantError('a human actor names a user');
      return { kind: 'HUMAN', userId: actor.userId, policy: null };
    case 'SYSTEM':
      return { kind: 'SYSTEM', userId: null, policy: null };
    case 'POLICY':
      if (typeof actor.policy !== 'string' || actor.policy.trim() === '') throw new BrainPersistenceInvariantError('a policy actor names its policy');
      return { kind: 'POLICY', userId: null, policy: actor.policy };
    default:
      throw new BrainPersistenceInvariantError('unknown actor kind');
  }
}

/**
 * An actor as stored. A person whose account was later deleted reads with an empty
 * id, which matches nobody: the record stays readable and grants nothing.
 */
export function brainActorOf(kind: string | null, userId: string | null, policy: string | null): BrainEventActor {
  switch (kind) {
    case 'HUMAN':
      return { kind: 'HUMAN', userId: userId ?? '' };
    case 'SYSTEM':
      return { kind: 'SYSTEM' };
    case 'POLICY':
      if (!policy) throw new BrainRecordUnreadable('policy actor without a policy');
      return { kind: 'POLICY', policy };
    default:
      throw new BrainRecordUnreadable('actor kind');
  }
}

// --- Result pointers ------------------------------------------------------------------

const REF_KEYS = ['artifactId', 'owner', 'subjectId'];

/** Pointers to where an owner holds results, and nothing else. */
export function brainResultRefsOf(value: unknown): BrainResultRef[] {
  if (!Array.isArray(value)) throw new BrainRecordUnreadable('resultRefs');
  return value.map((ref) => {
    const r = ref as Record<string, unknown> | null;
    const owner = r?.owner as Record<string, unknown> | undefined;
    if (
      !r ||
      typeof r !== 'object' ||
      Object.keys(r).sort().join(',') !== REF_KEYS.join(',') ||
      !owner ||
      typeof owner !== 'object' ||
      Object.keys(owner).sort().join(',') !== 'authority,subjectType' ||
      typeof r.subjectId !== 'string' ||
      r.subjectId === '' ||
      typeof r.artifactId !== 'string' ||
      r.artifactId === ''
    ) {
      throw new BrainRecordUnreadable('resultRef');
    }
    return {
      owner: {
        authority: oneOf(BRAIN_RESULT_OWNERS, owner.authority as string, 'resultRef owner'),
        subjectType: oneOf(BRAIN_RESULT_SUBJECT_TYPES, owner.subjectType as string, 'resultRef subject type'),
      },
      subjectId: r.subjectId,
      artifactId: r.artifactId,
    };
  });
}

/** The JSON a result pointer list is stored as: exactly the allowlisted keys. */
export function brainResultRefsJson(refs: readonly BrainResultRef[]): Prisma.InputJsonValue {
  return refs.map((r) => ({
    owner: { authority: r.owner.authority, subjectType: r.owner.subjectType },
    subjectId: r.subjectId,
    artifactId: r.artifactId,
  }));
}

// --- Task input -----------------------------------------------------------------------

export type BrainTaskInput = Readonly<Record<string, string | number | boolean | null>>;

/** A submission's task parameters: an object of scalars, nothing nested. */
export function brainTaskInputOf(value: unknown): BrainTaskInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrainRecordUnreadable('input');
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!(v === null || ['string', 'number', 'boolean'].includes(typeof v))) throw new BrainRecordUnreadable('input value');
    out[k] = v as string | number | boolean | null;
  }
  return out;
}

// --- Jobs -----------------------------------------------------------------------------

export function brainJobSnapshotOf(row: BrainJobRow): BrainJobSnapshot {
  if (!isAiCapabilityRoute(row.capabilityRoute)) throw new BrainRecordUnreadable('capabilityRoute');
  const subjectType = oneOf(BRAIN_RESULT_SUBJECT_TYPES, row.resultSubjectType, 'resultSubjectType');
  const cancelRequest: BrainCancelRequest | null = row.cancelRequestedAt
    ? {
        actor: brainActorOf(row.cancelActorKind, row.cancelActorUserId, row.cancelActorPolicy),
        reason: oneOf(BRAIN_CANCEL_REASONS, row.cancelReason, 'cancelReason'),
      }
    : null;
  return {
    jobId: row.id,
    generation: row.generation,
    organizationId: row.organizationId,
    principalUserId: row.principalUserId,
    taskId: row.taskId,
    taskVersion: row.taskVersion,
    capabilityRoute: row.capabilityRoute,
    resultType: oneOf(BRAIN_RESULT_TYPES, row.resultType, 'resultType'),
    resultOwner: {
      authority: oneOf(BRAIN_RESULT_OWNERS, row.resultOwnerAuthority, 'resultOwnerAuthority'),
      subjectType,
    },
    subject: { type: subjectType, id: row.resultSubjectId },
    executionClass: oneOf(BRAIN_EXECUTION_CLASSES, row.executionClass, 'executionClass'),
    promoted: row.promotedAt !== null,
    state: oneOf(BRAIN_JOB_STATES, row.state, 'state'),
    cancelRequest,
    wait:
      row.currentWaitId !== null && row.currentWaitExpiresAt !== null
        ? { waitId: row.currentWaitId, expiresAtMs: row.currentWaitExpiresAt.getTime() }
        : null,
    resultRefs: brainResultRefsOf(row.resultRefs),
    endReason:
      row.endReason === null ? null : oneOf([...BRAIN_FAILURE_REASONS, ...BRAIN_CANCEL_REASONS], row.endReason, 'endReason'),
    resumesJobId: row.resumesJobId,
  };
}

/** What a decided snapshot may never differ from its predecessor in. */
export const BRAIN_JOB_IMMUTABLE_FIELDS = [
  'jobId',
  'generation',
  'organizationId',
  'principalUserId',
  'taskId',
  'taskVersion',
  'capabilityRoute',
  'resultType',
  'resultOwner',
  'subject',
  'resumesJobId',
] as const satisfies readonly (keyof BrainJobSnapshot)[];

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The columns a decided transition changes, and nothing else. Throws when the decision
 * moved anything a transition may not move -- so a defect in a caller or a contract
 * cannot quietly re-point a job at another principal, another capability, another
 * kind of result or another owner.
 */
export function brainJobChanges(before: BrainJobSnapshot, after: BrainJobSnapshot, now: Date): Prisma.BrainJobUncheckedUpdateManyInput {
  for (const field of BRAIN_JOB_IMMUTABLE_FIELDS) {
    if (!same(before[field], after[field])) throw new BrainPersistenceInvariantError(`a transition may not change ${field}`);
  }
  const data: Prisma.BrainJobUncheckedUpdateManyInput = {};

  if (after.executionClass !== before.executionClass || after.promoted !== before.promoted) {
    // Promotion is the only way the class changes: once, INTERACTIVE to DURABLE.
    const promotion = before.executionClass === 'INTERACTIVE' && !before.promoted && after.executionClass === 'DURABLE' && after.promoted;
    if (!promotion) throw new BrainPersistenceInvariantError('the execution class changes only by promotion');
    data.executionClass = 'DURABLE';
    data.promotedAt = now;
  }

  if (after.state !== before.state) {
    data.state = after.state;
    if (before.state === 'QUEUED' && after.state === 'RUNNING') data.startedAt = now;
    if (brainJobIsTerminal(after.state)) {
      data.endedAt = now;
      data.leaseHolder = null;
      data.leaseExpiresAt = null;
    }
  }

  if (!same(after.cancelRequest, before.cancelRequest)) {
    // The first request stands; a request is never withdrawn or rewritten.
    if (before.cancelRequest !== null || after.cancelRequest === null) {
      throw new BrainPersistenceInvariantError('a cancel request is recorded once and never changed');
    }
    const actor = brainActorColumns(after.cancelRequest.actor);
    data.cancelRequestedAt = now;
    data.cancelActorKind = actor.kind;
    data.cancelActorUserId = actor.userId;
    data.cancelActorPolicy = actor.policy;
    data.cancelReason = after.cancelRequest.reason;
  }

  if (!same(after.wait, before.wait)) {
    data.currentWaitId = after.wait?.waitId ?? null;
    data.currentWaitExpiresAt = after.wait ? new Date(after.wait.expiresAtMs) : null;
  }

  if (!same(after.resultRefs, before.resultRefs)) data.resultRefs = brainResultRefsJson(after.resultRefs);
  if (after.endReason !== before.endReason) data.endReason = after.endReason;
  return data;
}

// --- Commands -------------------------------------------------------------------------

export function brainCommandOf(row: BrainCommandRow): BrainCommand {
  return {
    commandId: row.id,
    type: oneOf(BRAIN_COMMAND_TYPES, row.type, 'command type'),
    organizationId: row.organizationId,
    jobId: row.jobId,
    generation: row.generation,
    waitId: row.waitId,
    issuedBy: brainActorOf(row.issuerKind, row.issuerUserId, row.issuerPolicy),
    issuedAtMs: row.issuedAt.getTime(),
  };
}

// --- Waits ----------------------------------------------------------------------------

export function brainWaitRecordOf(row: BrainJobWaitRow): BrainWaitRecord {
  return {
    waitId: row.id,
    jobId: row.jobId,
    organizationId: row.organizationId,
    principalUserId: row.principalUserId,
    status: oneOf(BRAIN_WAIT_STATUSES, row.status, 'wait status'),
    expiresAtMs: row.expiresAt.getTime(),
    replyFingerprint: row.replyFingerprint,
  };
}

/** The largest structured question or reply Loop stores. They are small by design. */
export const BRAIN_WAIT_MAX_JSON_BYTES = 16 * 1024;

/**
 * A question or reply as stored: a plain JSON object, bounded in size. Anything else --
 * an array, a string, a huge blob -- is not a structured question or a validated reply.
 */
export function brainWaitJsonOf(value: unknown, what: string): Prisma.InputJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrainPersistenceInvariantError(`${what} is an object`);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > BRAIN_WAIT_MAX_JSON_BYTES) throw new BrainPersistenceInvariantError(`${what} is too large`);
  return JSON.parse(text) as Prisma.InputJsonObject;
}

/** A digest of a JSON value that does not depend on key order. */
export function brainCanonicalFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

/** The stored form of a submission fingerprint: SHA-256 of the contract's canonical string. */
export function brainSubmissionFingerprintHash(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// --- Sealed checkpoints ---------------------------------------------------------------

/** A checkpoint payload after sealing. This module can store it and never read it. */
export interface BrainSealedPayload {
  /** The sealing scheme's version, e.g. `kms-envelope.1`. */
  readonly sealVersion: string;
  /** Which key sealed it: a key id or alias, never key material. */
  readonly keyRef: string;
  readonly sealed: Uint8Array;
}

/** What a sealer binds a payload to, so a checkpoint cannot be opened as another job's. */
export interface BrainPayloadSealingContext {
  readonly organizationId: string;
  readonly jobId: string;
  readonly stepKey: string;
  readonly inputFingerprint: string;
  readonly purpose: 'CHECKPOINT';
}

/** The executor's sealing boundary. Implemented with the execution environment's key service later. */
export interface BrainPayloadSealer {
  seal(context: BrainPayloadSealingContext, plaintext: Uint8Array): Promise<BrainSealedPayload>;
  open(context: BrainPayloadSealingContext, payload: BrainSealedPayload): Promise<Uint8Array>;
}

export const BRAIN_CHECKPOINT_MAX_BYTES = 1024 * 1024;

export const BRAIN_SEALED_PAYLOAD_REFUSALS = ['NOT_BYTES', 'EMPTY', 'TOO_LARGE', 'BAD_SEAL_VERSION', 'BAD_KEY_REF', 'LOOKS_LIKE_PLAINTEXT'] as const;
export type BrainSealedPayloadRefusal = (typeof BRAIN_SEALED_PAYLOAD_REFUSALS)[number];

const SEAL_VERSION = /^[a-z0-9][a-z0-9.-]{0,31}$/;
const KEY_REF = /^[A-Za-z0-9][A-Za-z0-9:/._-]{0,255}$/;

/**
 * Whether a payload may be stored as a checkpoint. Not a proof of encryption -- nothing
 * here can prove that -- but a fence against the mistake that matters: handing this
 * table readable JSON, or text, because a sealer was skipped.
 */
export function brainSealedPayloadRefusals(payload: BrainSealedPayload): BrainSealedPayloadRefusal[] {
  const out: BrainSealedPayloadRefusal[] = [];
  const bytes = payload?.sealed;
  if (!(bytes instanceof Uint8Array)) return ['NOT_BYTES'];
  if (bytes.byteLength === 0) out.push('EMPTY');
  if (bytes.byteLength > BRAIN_CHECKPOINT_MAX_BYTES) out.push('TOO_LARGE');
  if (typeof payload.sealVersion !== 'string' || !SEAL_VERSION.test(payload.sealVersion)) out.push('BAD_SEAL_VERSION');
  if (typeof payload.keyRef !== 'string' || !KEY_REF.test(payload.keyRef)) out.push('BAD_KEY_REF');
  if (bytes.byteLength > 0 && looksLikePlaintext(bytes)) out.push('LOOKS_LIKE_PLAINTEXT');
  return out;
}

function looksLikePlaintext(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  // Ciphertext almost never decodes as UTF-8 made of printable characters. Text that
  // does -- JSON, prose, a prompt -- is exactly what must not land here.
  // eslint-disable-next-line no-control-regex
  if (/^[\x09\x0A\x0D\x20-\x7E -￿]*$/.test(text)) return true;
  const trimmed = text.trim();
  if (!/^[[{"]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}
