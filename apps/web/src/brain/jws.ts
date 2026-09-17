// Compact ES256 tokens: the only token format the Brain boundary speaks. Slice B5.
//
// SERVER ONLY. Node's own crypto; no library, no JOSE feature beyond what the design
// needs (brain-execution-infrastructure.md §5).
//
// NARROW ON PURPOSE. A token is `header.payload.signature`, the header says exactly
// `alg: ES256` and names a key id, and the signature is the 64-byte R||S form JOSE
// requires. Anything else -- another algorithm, `none`, a missing or unknown key id, a
// `crit` header, an oversized token, a signature of the wrong length -- is refused before
// any cryptography runs. Verification only ever uses keys this deployment pinned.

import 'server-only';

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'crypto';

export const JWS_MAX_LENGTH = 4096;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

export class JwsKeyError extends Error {
  constructor(what: string) {
    super(`Unusable signing key: ${what}`);
    this.name = 'JwsKeyError';
  }
}

function isP256(key: KeyObject): boolean {
  return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
}

/** A P-256 private key from PKCS#8 PEM. Anything else is refused, and its text is never echoed. */
export function es256PrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new JwsKeyError('not a private key');
  }
  if (!isP256(key)) throw new JwsKeyError('not a P-256 key');
  return key;
}

/**
 * A P-256 public key from SPKI PEM. A private key is refused even though Node would
 * derive its public half: a pinned-keys value is not secret, so a private key there is
 * a leak to stop, not a key to use.
 */
export function es256PublicKey(pem: string): KeyObject {
  if (/PRIVATE KEY/.test(pem)) throw new JwsKeyError('a private key is not a public key');
  let key: KeyObject;
  try {
    key = createPublicKey({ key: pem, format: 'pem' });
  } catch {
    throw new JwsKeyError('not a public key');
  }
  if (key.type !== 'public' || !isP256(key)) throw new JwsKeyError('not a P-256 public key');
  return key;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function signEs256(kid: string, payload: Readonly<Record<string, unknown>>, privateKey: KeyObject): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid)) throw new JwsKeyError('invalid key id');
  const signingInput = `${encode({ alg: 'ES256', typ: 'JWT', kid })}.${encode(payload)}`;
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${signature.toString('base64url')}`;
}

export const JWS_REFUSALS = ['MALFORMED', 'WRONG_ALGORITHM', 'UNKNOWN_KEY', 'BAD_SIGNATURE'] as const;
export type JwsRefusal = (typeof JWS_REFUSALS)[number];

export type JwsVerification =
  | { readonly ok: true; readonly kid: string; readonly payload: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly refusal: JwsRefusal };

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Verify a token against pinned keys only. The payload is returned only when the signature holds. */
export function verifyEs256(token: string, keys: ReadonlyMap<string, KeyObject>): JwsVerification {
  if (typeof token !== 'string' || token.length === 0 || token.length > JWS_MAX_LENGTH) return { ok: false, refusal: 'MALFORMED' };
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) return { ok: false, refusal: 'MALFORMED' };
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h);
  const payload = decodeJson(p);
  if (!header || !payload) return { ok: false, refusal: 'MALFORMED' };
  if (header.alg !== 'ES256' || 'crit' in header || (header.typ !== undefined && header.typ !== 'JWT')) {
    return { ok: false, refusal: 'WRONG_ALGORITHM' };
  }
  const kid = header.kid;
  const key = typeof kid === 'string' ? keys.get(kid) : undefined;
  if (typeof kid !== 'string' || !key) return { ok: false, refusal: 'UNKNOWN_KEY' };
  const signature = Buffer.from(s, 'base64url');
  if (signature.length !== 64) return { ok: false, refusal: 'BAD_SIGNATURE' };
  let valid = false;
  try {
    valid = verify('sha256', Buffer.from(`${h}.${p}`, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, refusal: 'BAD_SIGNATURE' };
  return { ok: true, kid, payload };
}
