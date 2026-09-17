// The ONE module that reads the Brain boundary's deployment environment. Slice B5.
//
// SERVER ONLY. Like `ai-environment.ts`, and fenced the same way: no other file reads
// these names, and none of them is ever NEXT_PUBLIC_.
//
// TWO TRUST DIRECTIONS, KEPT APART (brain-execution-infrastructure.md §5).
//
//   The doorbell (this web tier -> the execution environment). A short ES256 token,
//   signed with a private key only this deployment holds, says "a trusted Loop
//   deployment asks you to look at a stored command". The key's VALUE goes into the
//   signer and nowhere else. Its presence means the doorbell is CONFIGURED; nothing more.
//
//   Worker requests (the execution environment -> this web tier). Tokens are verified
//   against PUBLIC keys pinned here by key id. They are not secrets.
//
// OFF UNTIL CONFIGURED. With nothing set -- the state of every deployment today -- the
// doorbell does not ring (accepted work simply waits for the executor's sweeper, which
// does not exist yet), and every worker request is refused. No AWS credential is read,
// needed or accepted anywhere here.

import 'server-only';

import type { KeyObject } from 'crypto';

import { es256PrivateKey, es256PublicKey } from './jws';

/** Every variable this module reads, by name. Only the signing key's value is secret. */
export const BRAIN_ENVIRONMENT = Object.freeze({
  doorbellUrl: 'LOOP_BRAIN_DOORBELL_URL',
  doorbellIssuer: 'LOOP_BRAIN_DOORBELL_ISSUER',
  doorbellSubject: 'LOOP_BRAIN_DOORBELL_SUBJECT',
  doorbellKeyId: 'LOOP_BRAIN_DOORBELL_KEY_ID',
  doorbellSigningKey: 'LOOP_BRAIN_DOORBELL_SIGNING_KEY',
  workerIssuers: 'LOOP_BRAIN_WORKER_ISSUERS',
  workerSubjects: 'LOOP_BRAIN_WORKER_SUBJECTS',
  workerPublicKeys: 'LOOP_BRAIN_WORKER_PUBLIC_KEYS',
} as const);

export type BrainEnvironmentSource = Readonly<Record<string, string | undefined>>;

export type BrainDoorbellConfig =
  | {
      readonly state: 'CONFIGURED';
      readonly url: string;
      readonly issuer: string;
      readonly subject: string;
      readonly keyId: string;
      readonly signingKey: KeyObject;
    }
  | { readonly state: 'NOT_CONFIGURED' | 'INVALID' };

export type BrainWorkerTrust =
  | {
      readonly state: 'CONFIGURED';
      readonly issuers: readonly string[];
      readonly subjects: readonly string[];
      readonly keys: ReadonlyMap<string, KeyObject>;
    }
  | { readonly state: 'NOT_CONFIGURED' | 'INVALID' };

const TOKEN = /^[A-Za-z0-9_.:/-]{1,200}$/;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

function list(raw: string | undefined): string[] {
  if (typeof raw !== 'string') return [];
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => TOKEN.test(s)))];
}

function set(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** PEM held in a single-line environment value, with its newlines written as `\n`. */
function pem(raw: string): string {
  return raw.includes('-----BEGIN') ? raw.replace(/\\n/g, '\n').trim() : raw;
}

/** Only a well-formed https URL may be rung. */
function httpsUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export function readBrainDoorbell(source: BrainEnvironmentSource = process.env): BrainDoorbellConfig {
  const E = BRAIN_ENVIRONMENT;
  const values = [source[E.doorbellUrl], source[E.doorbellIssuer], source[E.doorbellSubject], source[E.doorbellKeyId], source[E.doorbellSigningKey]];
  if (values.every((v) => !set(v))) return { state: 'NOT_CONFIGURED' };
  if (!values.every(set)) return { state: 'INVALID' };
  const url = httpsUrl(source[E.doorbellUrl]!);
  const issuer = source[E.doorbellIssuer]!.trim();
  const subject = source[E.doorbellSubject]!.trim();
  const keyId = source[E.doorbellKeyId]!.trim();
  if (!url || !TOKEN.test(issuer) || !TOKEN.test(subject) || !KEY_ID.test(keyId)) return { state: 'INVALID' };
  try {
    return { state: 'CONFIGURED', url, issuer, subject, keyId, signingKey: es256PrivateKey(pem(source[E.doorbellSigningKey]!)) };
  } catch {
    // The key's text is never repeated, not even in an error.
    return { state: 'INVALID' };
  }
}

export function readBrainWorkerTrust(source: BrainEnvironmentSource = process.env): BrainWorkerTrust {
  const E = BRAIN_ENVIRONMENT;
  const raw = [source[E.workerIssuers], source[E.workerSubjects], source[E.workerPublicKeys]];
  if (raw.every((v) => !set(v))) return { state: 'NOT_CONFIGURED' };
  const issuers = list(source[E.workerIssuers]);
  const subjects = list(source[E.workerSubjects]);
  if (issuers.length === 0 || subjects.length === 0 || !set(source[E.workerPublicKeys])) return { state: 'INVALID' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source[E.workerPublicKeys]!);
  } catch {
    return { state: 'INVALID' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'INVALID' };
  const keys = new Map<string, KeyObject>();
  for (const [kid, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KEY_ID.test(kid) || typeof value !== 'string') return { state: 'INVALID' };
    try {
      keys.set(kid, es256PublicKey(pem(value)));
    } catch {
      return { state: 'INVALID' };
    }
  }
  if (keys.size === 0) return { state: 'INVALID' };
  return { state: 'CONFIGURED', issuers, subjects, keys };
}

/** What an operator surface may show. Never a value. */
export function brainBoundaryConfiguration(source: BrainEnvironmentSource = process.env): {
  readonly doorbell: 'CONFIGURED' | 'NOT_CONFIGURED' | 'INVALID';
  readonly workerTrust: 'CONFIGURED' | 'NOT_CONFIGURED' | 'INVALID';
} {
  return { doorbell: readBrainDoorbell(source).state, workerTrust: readBrainWorkerTrust(source).state };
}
