// Compact ES256 tokens on the execution side. Slice B6.
//
// The same narrow format Loop's web tier speaks (apps/web/src/brain/jws.ts): header
// exactly `alg: ES256`, an optional `typ: JWT`, a key id, no `crit`; a 64-byte R||S
// signature; verification only against keys this deployment pinned. A test in the web
// suite proves each side accepts the other's tokens.
//
// SIGNING IS DELEGATED. The worker never holds a private key: it hands the signing input
// to a signer (the key service in AWS) and receives a DER-encoded ECDSA signature, which
// is converted here to the JOSE form.

import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

export const JWS_MAX_LENGTH = 4096;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
// The same key-id form Loop's web tier pins (a label, never a key-service ARN).
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

export class JwsError extends Error {
  constructor(what: string) {
    super(`jws: ${what}`);
    this.name = 'JwsError';
  }
}

export function base64url(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString('base64url');
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A P-256 public key from SPKI PEM. A private key is refused, never converted. */
export function p256PublicKey(pem: string): KeyObject {
  if (/PRIVATE KEY/.test(pem)) throw new JwsError('a private key is not a public key');
  let key: KeyObject;
  try {
    key = createPublicKey({ key: pem, format: 'pem' });
  } catch {
    throw new JwsError('not a public key');
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new JwsError('not a P-256 public key');
  }
  return key;
}

/** Pinned keys from a JSON object of `{ kid: SPKI PEM }`. Anything malformed pins nothing. */
export function pinnedKeysFromJson(raw: string): ReadonlyMap<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return keys;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return keys;
  for (const [kid, pem] of Object.entries(parsed as Record<string, unknown>)) {
    if (!KEY_ID.test(kid) || typeof pem !== 'string') return new Map();
    try {
      keys.set(kid, p256PublicKey(pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem));
    } catch {
      return new Map();
    }
  }
  return keys;
}

function readLength(der: Uint8Array, at: number): { length: number; next: number } {
  const first = der[at];
  if (first === undefined) throw new JwsError('truncated signature');
  if (first < 0x80) return { length: first, next: at + 1 };
  const count = first & 0x7f;
  if (count < 1 || count > 2) throw new JwsError('unsupported signature length');
  let length = 0;
  for (let i = 0; i < count; i += 1) {
    const b = der[at + 1 + i];
    if (b === undefined) throw new JwsError('truncated signature');
    length = (length << 8) | b;
  }
  return { length, next: at + 1 + count };
}

function readInteger(der: Uint8Array, at: number): { value: Uint8Array; next: number } {
  if (der[at] !== 0x02) throw new JwsError('signature integer expected');
  const { length, next } = readLength(der, at + 1);
  if (length < 1 || next + length > der.length) throw new JwsError('truncated signature');
  let value = der.subarray(next, next + length);
  while (value.length > 1 && value[0] === 0x00) value = value.subarray(1);
  if (value.length > 32) throw new JwsError('signature integer too long');
  return { value, next: next + length };
}

/** A DER `SEQUENCE { r INTEGER, s INTEGER }` as the 64-byte `r || s` JOSE requires. */
export function derToJoseP256(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new JwsError('signature sequence expected');
  const { length, next } = readLength(der, 1);
  if (next + length !== der.length) throw new JwsError('signature length mismatch');
  const r = readInteger(der, next);
  const s = readInteger(der, r.next);
  if (s.next !== der.length) throw new JwsError('trailing signature bytes');
  const out = new Uint8Array(64);
  out.set(r.value, 32 - r.value.length);
  out.set(s.value, 64 - s.value.length);
  return out;
}

/** Signs `header.payload` and returns DER. The private key never reaches this process. */
export interface Es256Signer {
  readonly keyId: string;
  sign(signingInput: Uint8Array): Promise<Uint8Array>;
}

export async function signEs256Jwt(payload: Readonly<Record<string, unknown>>, signer: Es256Signer): Promise<string> {
  if (!KEY_ID.test(signer.keyId)) throw new JwsError('invalid key id');
  const signingInput = `${base64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: signer.keyId }))}.${base64url(JSON.stringify(payload))}`;
  const der = await signer.sign(Buffer.from(signingInput, 'utf8'));
  return `${signingInput}.${base64url(derToJoseP256(der))}`;
}

export type JwsVerification =
  | { readonly ok: true; readonly kid: string; readonly payload: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly refusal: 'MALFORMED' | 'WRONG_ALGORITHM' | 'UNKNOWN_KEY' | 'BAD_SIGNATURE' };

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Verify against pinned keys only. The payload is returned only when the signature holds. */
export function verifyEs256Jwt(token: string, keys: ReadonlyMap<string, KeyObject>): JwsVerification {
  if (typeof token !== 'string' || token.length === 0 || token.length > JWS_MAX_LENGTH) return { ok: false, refusal: 'MALFORMED' };
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) return { ok: false, refusal: 'MALFORMED' };
  const [h, p, s] = parts as [string, string, string];
  const header = decodeJson(h);
  const payload = decodeJson(p);
  if (!header || !payload) return { ok: false, refusal: 'MALFORMED' };
  if (header.alg !== 'ES256' || 'crit' in header || (header.typ !== undefined && header.typ !== 'JWT')) return { ok: false, refusal: 'WRONG_ALGORITHM' };
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
  return valid ? { ok: true, kid, payload } : { ok: false, refusal: 'BAD_SIGNATURE' };
}
