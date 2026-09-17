// Google ID-token verification: the signature against Google's published keys first, then
// the claims. Keys are generated here and served by a recording key-set double with a
// controllable clock. No live call is made.
//
// WHAT THESE PROVE
//   - A token signed with a published key verifies; a token whose signature does not verify
//     is refused, and none of its claims are read.
//   - Only RS256 is accepted; `none`, HS256 and every other algorithm are refused before a
//     key is fetched.
//   - An unknown key id refetches the key set once (rotation), at most once a minute.
//   - The key set is kept exactly as long as Google's Cache-Control and Age allow, never
//     used stale, and a key Google retires stops verifying.
//   - When the key set cannot be fetched or read, nothing verifies, and no token, body or
//     error text escapes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import {
  GOOGLE_ID_TOKEN_ALGORITHM,
  GOOGLE_JWKS_URI,
  GOOGLE_SIGNING_KEYS_MAX_AGE_SECONDS,
  GoogleSigningKeys,
  googleSigningKeysLifetimeSeconds,
  verifyGoogleIdToken,
  type GoogleIdTokenExpectations,
} from '../src/google-workspace/id-token';

const CLIENT_ID = '123456789012-abcdef.apps.googleusercontent.com';
const NOW = 1_800_000_000;
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

interface TestKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly jwk: Record<string, unknown>;
}

function rsaKey(kid: string, modulusLength = 2048): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength });
  return { kid, privateKey, publicKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

const KEY_A = rsaKey('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
const KEY_B = rsaKey('f10f87405a979c1df36df26606734f33cd85c271');
const IMPOSTOR = rsaKey(KEY_A.kid);

const GOOD = {
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  azp: CLIENT_ID,
  sub: '110169484474386276334',
  email: 'person@example.com',
  email_verified: true,
  iat: NOW - 10,
  exp: NOW + 3600,
  nonce: 'the-nonce',
};

/** A compact JWS, signed RS256 with `key` unless the header says otherwise. */
function signed(claims: Record<string, unknown>, key: TestKey = KEY_A, header: Record<string, unknown> = { alg: 'RS256', kid: key.kid, typ: 'JWT' }) {
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${sign('sha256', Buffer.from(input), key.privateKey).toString('base64url')}`;
}

type Answer = { status: number; body?: unknown; cacheControl?: string | null; age?: string } | 'throw' | 'hang';

/** Google's key-set endpoint, answering from a queue (the last answer repeats), with a clock. */
function googleKeys(answers: Answer[], options: { timeoutMs?: number } = {}) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  let nowMs = NOW * 1000;
  const queue = [...answers];
  const fetchImpl = async (url: string, init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal }) => {
    calls.push({ url, method: init.method, headers: init.headers });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next === 'throw') throw new Error(`connect ECONNREFUSED ${GOOGLE_JWKS_URI} while holding ${signed(GOOD)}`);
    if (next === 'hang') return new Promise<never>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const headers: Record<string, string> = {};
    if (next.cacheControl !== null) headers['cache-control'] = next.cacheControl ?? 'public, max-age=23247, must-revalidate, no-transform';
    if (next.age !== undefined) headers.age = next.age;
    return {
      status: next.status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => {
        if (next.body === undefined) throw new SyntaxError('Unexpected token < in JSON: <html>secret-looking body</html>');
        return next.body;
      },
    };
  };
  const keys = new GoogleSigningKeys({ fetchImpl, nowMs: () => nowMs, timeoutMs: options.timeoutMs });
  return {
    keys,
    calls,
    advance(seconds: number) {
      nowMs += seconds * 1000;
    },
    verify(token: string, over: Partial<GoogleIdTokenExpectations> = {}) {
      return verifyGoogleIdToken(token, {
        clientId: CLIENT_ID,
        nonceMatches: (n) => n === 'the-nonce',
        nowSeconds: Math.floor(nowMs / 1000),
        allowedHostedDomains: [],
        signingKeys: keys,
        ...over,
      });
    },
  };
}

const published = (...keys: TestKey[]) => ({ keys: keys.map((k) => k.jwk) });
const verdict = (r: Awaited<ReturnType<typeof verifyGoogleIdToken>>) => (r.ok ? 'ACCEPTED' : r.refusal);

// --- Valid signature ------------------------------------------------------------------------

test('a token signed with a key Google publishes verifies, and yields the account id, email and Workspace domain', async () => {
  const g = googleKeys([{ status: 200, body: published(KEY_A, KEY_B) }]);
  assert.deepEqual(await g.verify(signed(GOOD)), { ok: true, identity: { subject: GOOD.sub, email: GOOD.email, hostedDomain: null } });
  assert.deepEqual(await g.verify(signed({ ...GOOD, iss: 'accounts.google.com', hd: 'Example.COM', email_verified: 'true' }, KEY_B)), {
    ok: true,
    identity: { subject: GOOD.sub, email: GOOD.email, hostedDomain: 'example.com' },
  });
  assert.equal(verdict(await g.verify(signed({ ...GOOD, aud: [CLIENT_ID, 'other'], azp: CLIENT_ID }))), 'ACCEPTED');
  assert.equal(verdict(await g.verify(signed({ ...GOOD, azp: undefined }))), 'ACCEPTED', 'azp is optional with a single audience');
  assert.equal(verdict(await g.verify(signed(GOOD, KEY_A, { alg: 'RS256', kid: KEY_A.kid }))), 'ACCEPTED', 'typ is not required');

  assert.equal(g.calls.length, 1, 'one fetch serves every verification while the set is fresh');
  assert.deepEqual(g.calls[0], { url: 'https://www.googleapis.com/oauth2/v3/certs', method: 'GET', headers: { accept: 'application/json' } });
  assert.equal(GOOGLE_JWKS_URI, 'https://www.googleapis.com/oauth2/v3/certs');
  assert.equal(GOOGLE_ID_TOKEN_ALGORITHM, 'RS256');
  assert.equal(await g.keys.ready(), true);
});

// --- Invalid signature ------------------------------------------------------------------------

test('a signature that does not verify is refused, and none of the token’s claims are read', async () => {
  const g = googleKeys([{ status: 200, body: published(KEY_A) }]);
  const genuine = signed(GOOD);
  const [h, , sig] = genuine.split('.') as [string, string, string];

  // The payload swapped for another account's, keeping Google's signature.
  assert.equal(verdict(await g.verify(`${h}.${b64({ ...GOOD, sub: '110000000000000000999' })}.${sig}`)), 'SIGNATURE');
  // Signed by someone else's key under the id of Google's key.
  assert.equal(verdict(await g.verify(signed(GOOD, IMPOSTOR))), 'SIGNATURE');
  // A signature cut short, flipped, or taken from another token.
  assert.equal(verdict(await g.verify(`${h}.${genuine.split('.')[1]}.${sig.slice(0, -4)}`)), 'SIGNATURE');
  const flipped = Buffer.from(sig, 'base64url');
  flipped[10] = flipped[10]! ^ 0x01;
  assert.equal(verdict(await g.verify(`${h}.${genuine.split('.')[1]}.${flipped.toString('base64url')}`)), 'SIGNATURE');
  assert.equal(verdict(await g.verify(`${h}.${genuine.split('.')[1]}.${signed({ ...GOOD, nonce: 'x' }).split('.')[2]}`)), 'SIGNATURE');

  // Claims that would each be refused on their own are never reached: the signature decides first.
  for (const claims of [{ ...GOOD, iss: 'https://evil.example' }, { ...GOOD, exp: NOW - 9999 }, { ...GOOD, nonce: 'wrong' }, { ...GOOD, email_verified: false }]) {
    assert.equal(verdict(await g.verify(signed(claims, IMPOSTOR))), 'SIGNATURE', JSON.stringify(claims));
  }
  let nonceRead = false;
  await g.verify(signed(GOOD, IMPOSTOR), { nonceMatches: () => (nonceRead = true) });
  assert.equal(nonceRead, false, 'the nonce of an unverified token is never even compared');
  assert.equal(verdict(await g.verify(`${h}.not-the-payload.${sig}`)), 'SIGNATURE', 'an unreadable payload is not parsed before the signature');
});

// --- Unknown kid ------------------------------------------------------------------------------

test('a key id Google does not publish is refused after one refetch, and refetches are rate limited', async () => {
  const stranger = rsaKey('0000000000000000000000000000000000000000');
  const g = googleKeys([{ status: 200, body: published(KEY_A) }]);
  assert.equal(verdict(await g.verify(signed(GOOD, stranger))), 'UNKNOWN_KEY');
  assert.equal(g.calls.length, 1, 'the first fetch just happened: no second one');

  g.advance(30);
  assert.equal(verdict(await g.verify(signed(GOOD, stranger))), 'UNKNOWN_KEY');
  assert.equal(g.calls.length, 1, 'within a minute of the last fetch, an unknown id does not reach Google');
  for (let i = 0; i < 20; i += 1) await g.verify(signed(GOOD, rsaKeyFor(i)));
  assert.equal(g.calls.length, 1, 'a stream of invented key ids is not a stream of requests');

  g.advance(31);
  assert.equal(verdict(await g.verify(signed(GOOD, stranger))), 'UNKNOWN_KEY');
  assert.equal(g.calls.length, 2, 'after a minute, one refetch in case Google rotated');
  assert.equal(verdict(await g.verify(signed(GOOD))), 'ACCEPTED', 'the known key still verifies without another fetch');
  assert.equal(g.calls.length, 2);

  for (const header of [{ alg: 'RS256' }, { alg: 'RS256', kid: '' }, { alg: 'RS256', kid: 7 }, { alg: 'RS256', kid: 'has spaces' }, { alg: 'RS256', kid: 'k'.repeat(129) }]) {
    assert.equal(verdict(await g.verify(signed(GOOD, KEY_A, header))), 'MALFORMED', JSON.stringify(header));
  }
  assert.equal(g.calls.length, 2, 'a token without a usable key id never reaches Google');
});

const invented = new Map<number, TestKey>();
function rsaKeyFor(i: number): TestKey {
  // The key material does not matter (no key is found); only the id varies.
  if (!invented.has(i)) invented.set(i, { ...IMPOSTOR, kid: `invented-${i}` });
  return invented.get(i)!;
}

// --- Unexpected alg ---------------------------------------------------------------------------

test('only RS256 is accepted: none, HS256, other algorithms and a missing alg are refused before any key is fetched', async () => {
  const g = googleKeys([{ status: 200, body: published(KEY_A) }]);
  const body = b64(GOOD);
  const hs256 = (secret: string | Buffer) => {
    const input = `${b64({ alg: 'HS256', kid: KEY_A.kid })}.${body}`;
    return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
  };
  const withAlg = (alg: unknown) => {
    const input = `${b64({ alg, kid: KEY_A.kid })}.${body}`;
    return `${input}.${sign('sha256', Buffer.from(input), KEY_A.privateKey).toString('base64url')}`;
  };
  const refusedAlgorithms = [
    `${b64({ alg: 'none' })}.${body}.`,
    `${b64({ alg: 'none', kid: KEY_A.kid })}.${body}.`,
    `${b64({ alg: 'none', kid: KEY_A.kid })}.${body}.c2ln`,
    // The classic confusion: Google's public key used as an HMAC secret.
    hs256(KEY_A.publicKey.export({ format: 'pem', type: 'spki' }) as string),
    hs256(JSON.stringify(KEY_A.jwk)),
    withAlg('RS512'),
    withAlg('RS384'),
    withAlg('PS256'),
    withAlg('ES256'),
    withAlg('EdDSA'),
    withAlg('rs256'),
    withAlg(' RS256'),
    withAlg(['RS256']),
    withAlg(null),
    withAlg(undefined),
  ];
  for (const token of refusedAlgorithms) assert.equal(verdict(await g.verify(token)), 'ALGORITHM', token.split('.')[0]);
  assert.equal(g.calls.length, 0, 'an unacceptable algorithm never reaches Google');

  // A critical header extension is not understood, so the token is refused.
  assert.equal(verdict(await g.verify(signed(GOOD, KEY_A, { alg: 'RS256', kid: KEY_A.kid, crit: ['exp'] }))), 'MALFORMED');
  // A key carried in the token itself is ignored: only Google's set is consulted.
  const selfSigned = rsaKey('self-supplied');
  const carried = signed(GOOD, selfSigned, { alg: 'RS256', kid: selfSigned.kid, jwk: selfSigned.jwk, jku: 'https://evil.example/certs', x5u: 'https://evil.example/x5u' });
  assert.equal(verdict(await g.verify(carried)), 'UNKNOWN_KEY');
  assert.ok(g.calls.every((c) => c.url === GOOGLE_JWKS_URI), 'no URL from a token header is ever fetched');
});

test('a published key is used only if it is an RSA signing key of at least 2048 bits for RS256, under one id', async () => {
  const small = rsaKey('small-key', 1024);
  const encryption = rsaKey('enc-key');
  const otherAlg = rsaKey('rs512-key');
  const otherOps = rsaKey('ops-key');
  const twice = rsaKey('twice');
  const alsoTwice = rsaKey('twice');
  const plain = rsaKey('no-alg-no-use');
  const g = googleKeys([
    {
      status: 200,
      body: {
        keys: [
          KEY_A.jwk,
          { ...plain.jwk, alg: undefined, use: undefined },
          small.jwk,
          { ...encryption.jwk, use: 'enc' },
          { ...otherAlg.jwk, alg: 'RS512' },
          { ...otherOps.jwk, key_ops: ['encrypt'] },
          twice.jwk,
          alsoTwice.jwk,
          { kty: 'EC', kid: 'ec-key', crv: 'P-256', x: 'x', y: 'y' },
          { kty: 'RSA', kid: 'unreadable', n: '!!', e: 'AQAB' },
          { kty: 'RSA', kid: 'no-modulus', e: 'AQAB' },
          'not a key',
          null,
        ],
      },
    },
  ]);
  assert.equal(verdict(await g.verify(signed(GOOD))), 'ACCEPTED');
  assert.equal(verdict(await g.verify(signed(GOOD, plain))), 'ACCEPTED', 'alg and use are optional in a JWK; Google publishes them');
  for (const key of [small, encryption, otherAlg, otherOps, twice, alsoTwice]) {
    assert.equal(verdict(await g.verify(signed(GOOD, key))), 'UNKNOWN_KEY', key.kid);
  }
  assert.equal(verdict(await g.verify(signed(GOOD, { ...IMPOSTOR, kid: plain.kid }))), 'SIGNATURE', 'the usable key is Google’s, not the token’s');
});

// --- Rotation and caching ------------------------------------------------------------------------

test('Google’s Cache-Control and Age decide how long keys are kept; a stale set is never used', async () => {
  const g = googleKeys([
    { status: 200, body: published(KEY_A), cacheControl: 'public, max-age=300, must-revalidate, no-transform', age: '100' },
    { status: 200, body: published(KEY_A), cacheControl: 'public, max-age=300, must-revalidate, no-transform' },
  ]);
  await g.verify(signed(GOOD));
  g.advance(199);
  await g.verify(signed(GOOD));
  assert.equal(g.calls.length, 1, 'fresh for max-age less Age: 200 seconds');
  g.advance(1);
  assert.equal(verdict(await g.verify(signed(GOOD))), 'ACCEPTED');
  assert.equal(g.calls.length, 2, 'at 200 seconds the set is stale and fetched again');
  g.advance(299);
  await g.verify(signed(GOOD));
  assert.equal(g.calls.length, 2);

  // Without max-age (or with no-store / no-cache) a set serves only the verification that fetched it.
  for (const cacheControl of [null, 'public', 'no-store', 'no-cache, max-age=600', 'max-age=abc']) {
    const once = googleKeys([{ status: 200, body: published(KEY_A), cacheControl }]);
    assert.equal(verdict(await once.verify(signed(GOOD))), 'ACCEPTED', String(cacheControl));
    assert.equal(verdict(await once.verify(signed(GOOD))), 'ACCEPTED', String(cacheControl));
    assert.equal(once.calls.length, 2, `not cached: ${cacheControl}`);
  }

  assert.equal(googleSigningKeysLifetimeSeconds('public, max-age=23247, must-revalidate, no-transform', '16'), 23231, 'Google’s headers as served on 2026-09-17');
  assert.equal(googleSigningKeysLifetimeSeconds('private, MAX-AGE=60', null), 60);
  assert.equal(googleSigningKeysLifetimeSeconds('max-age=60', '61'), 0, 'already older than max-age');
  assert.equal(googleSigningKeysLifetimeSeconds('max-age=60', 'soon'), 60, 'an unreadable Age is ignored');
  assert.equal(googleSigningKeysLifetimeSeconds('max-age=99999999', null), GOOGLE_SIGNING_KEYS_MAX_AGE_SECONDS, 'capped at a day');
  assert.equal(googleSigningKeysLifetimeSeconds('max-age=-5', null), 0);
  assert.equal(googleSigningKeysLifetimeSeconds('', null), 0);
});

test('a rotated key is picked up by refetching, and a key Google retires stops verifying', async () => {
  const LONG = { ...GOOD, exp: NOW + 86_400 };
  const g = googleKeys([
    { status: 200, body: published(KEY_A), cacheControl: 'public, max-age=3600' },
    // Google publishes B alongside A before signing with it...
    { status: 200, body: published(KEY_A, KEY_B), cacheControl: 'public, max-age=3600' },
    // ...and later retires A.
    { status: 200, body: published(KEY_B), cacheControl: 'public, max-age=3600' },
  ]);
  assert.equal(verdict(await g.verify(signed(LONG))), 'ACCEPTED');
  g.advance(120);
  assert.equal(verdict(await g.verify(signed(LONG, KEY_B))), 'ACCEPTED', 'a new key id within the cache lifetime triggers one refetch');
  assert.equal(g.calls.length, 2);
  assert.equal(verdict(await g.verify(signed(LONG))), 'ACCEPTED', 'A is still published');
  assert.equal(verdict(await g.verify(signed(LONG, KEY_B))), 'ACCEPTED');
  assert.equal(g.calls.length, 2, 'the refreshed set is cached for its own max-age');

  g.advance(3600);
  assert.equal(verdict(await g.verify(signed(LONG, KEY_B))), 'ACCEPTED');
  assert.equal(g.calls.length, 3, 'expired: fetched again');
  assert.equal(verdict(await g.verify(signed(LONG))), 'UNKNOWN_KEY', 'A was retired: a token signed with it no longer verifies');
  assert.equal(g.calls.length, 3, 'and the set just fetched is not fetched again for it');
});

test('verifications that arrive together share one fetch', async () => {
  const g = googleKeys([{ status: 200, body: published(KEY_A, KEY_B) }]);
  const results = await Promise.all([g.verify(signed(GOOD)), g.verify(signed(GOOD, KEY_B)), g.keys.ready(), g.verify(signed(GOOD))]);
  assert.deepEqual(results.map((r) => (typeof r === 'boolean' ? r : verdict(r))), ['ACCEPTED', 'ACCEPTED', true, 'ACCEPTED']);
  assert.equal(g.calls.length, 1);
});

// --- JWKS / network unavailable ------------------------------------------------------------------

test('when Google’s keys cannot be fetched or read, nothing verifies and nothing leaks', async () => {
  const logged: unknown[] = [];
  const original = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  console.error = console.warn = console.log = console.info = (...args: unknown[]) => void logged.push(args);
  try {
    const failures: Answer[] = [
      'throw',
      'hang',
      { status: 500, body: { error: 'backend' } },
      { status: 404, body: published(KEY_A) },
      { status: 304 },
      { status: 200 },
      { status: 200, body: null },
      { status: 200, body: [] },
      { status: 200, body: { keys: [] } },
      { status: 200, body: { keys: 'many' } },
      { status: 200, body: { keys: [{ kty: 'EC', kid: KEY_A.kid, crv: 'P-256', x: 'a', y: 'b' }] } },
      { status: 200, body: { certs: published(KEY_A).keys } },
    ];
    for (const failure of failures) {
      const g = googleKeys([failure], { timeoutMs: 20 });
      const token = signed(GOOD);
      const result = await g.verify(token);
      const label = typeof failure === 'string' ? failure : JSON.stringify(failure).slice(0, 60);
      assert.deepEqual(result, { ok: false, refusal: 'KEYS_UNAVAILABLE' }, label);
      assert.equal(await g.keys.ready(), false, label);
      const text = JSON.stringify(result);
      for (const secret of [token, token.split('.')[2]!, 'ECONNREFUSED', 'secret-looking', 'backend', GOOD.email]) assert.equal(text.includes(secret), false, `${label}: ${secret}`);
    }
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(logged, [], 'nothing is logged');
});

test('a stale key set is not used when the refetch fails, and verification recovers when Google answers again', async () => {
  const g = googleKeys([
    { status: 200, body: published(KEY_A), cacheControl: 'public, max-age=60' },
    'throw',
    { status: 503 },
    { status: 200, body: published(KEY_A), cacheControl: 'public, max-age=60' },
  ]);
  assert.equal(verdict(await g.verify(signed(GOOD))), 'ACCEPTED');
  g.advance(60);
  assert.equal(verdict(await g.verify(signed(GOOD))), 'KEYS_UNAVAILABLE', 'must-revalidate: the expired set is not a fallback');
  assert.equal(verdict(await g.verify(signed(GOOD))), 'KEYS_UNAVAILABLE');
  assert.equal(await g.keys.ready(), true, 'Google answers again');
  assert.equal(verdict(await g.verify(signed(GOOD))), 'ACCEPTED');
  assert.equal(g.calls.length, 4);

  // A refetch for an unknown key id that fails leaves the fresh set in place, and refuses the token.
  const h = googleKeys([{ status: 200, body: published(KEY_A), cacheControl: 'public, max-age=3600' }, 'throw', { status: 200, body: published(KEY_A, KEY_B) }]);
  assert.equal(verdict(await h.verify(signed(GOOD))), 'ACCEPTED');
  h.advance(61);
  assert.equal(verdict(await h.verify(signed(GOOD, KEY_B))), 'KEYS_UNAVAILABLE');
  assert.equal(verdict(await h.verify(signed(GOOD))), 'ACCEPTED', 'the still-fresh set keeps verifying');
  assert.equal(h.calls.length, 2);
});

// --- Claims, once the signature has verified -------------------------------------------------------

test('every claim the architecture names is checked on a verified token', async () => {
  const g = googleKeys([{ status: 200, body: published(KEY_A) }]);
  const refused = async (claims: Record<string, unknown>, over: Partial<GoogleIdTokenExpectations> = {}) => verdict(await g.verify(signed(claims), over));
  assert.equal(await refused({ ...GOOD, iss: 'https://evil.example' }), 'ISSUER');
  assert.equal(await refused({ ...GOOD, iss: undefined }), 'ISSUER');
  assert.equal(await refused({ ...GOOD, aud: 'someone-else.apps.googleusercontent.com' }), 'AUDIENCE');
  assert.equal(await refused({ ...GOOD, aud: [CLIENT_ID, 'other'], azp: 'other' }), 'AUDIENCE');
  assert.equal(await refused({ ...GOOD, aud: [CLIENT_ID, 'other'], azp: undefined }), 'AUDIENCE');
  assert.equal(await refused({ ...GOOD, azp: 'other' }), 'AUDIENCE');
  assert.equal(await refused({ ...GOOD, exp: NOW - 61 }), 'EXPIRED');
  assert.equal(await refused({ ...GOOD, exp: undefined }), 'EXPIRED');
  assert.equal(await refused({ ...GOOD, exp: NOW - 30 }), 'ACCEPTED', 'within the skew allowance');
  assert.equal(await refused({ ...GOOD, iat: NOW + 120 }), 'NOT_YET_VALID');
  assert.equal(await refused({ ...GOOD, nonce: 'another-nonce' }), 'NONCE');
  assert.equal(await refused({ ...GOOD, nonce: undefined }), 'NONCE');
  assert.equal(await refused({ ...GOOD, nonce: '' }), 'NONCE');
  assert.equal(await refused({ ...GOOD, email_verified: false }), 'EMAIL_UNVERIFIED');
  assert.equal(await refused({ ...GOOD, email_verified: undefined }), 'EMAIL_UNVERIFIED');
  assert.equal(await refused({ ...GOOD, email: undefined }), 'EMAIL_UNVERIFIED');
  assert.equal(await refused({ ...GOOD, sub: undefined }), 'MALFORMED');
  assert.equal(await refused({ ...GOOD, sub: 'has spaces' }), 'MALFORMED');
});

test('a domain restriction, when an organization configures one, admits only its Workspace domains', async () => {
  const g = googleKeys([{ status: 200, body: published(KEY_A) }]);
  const restricted = { allowedHostedDomains: ['example.com'] };
  const domain = async (claims: Record<string, unknown>) => {
    const r = await g.verify(signed(claims), restricted);
    return r.ok ? r.identity.hostedDomain : r.refusal;
  };
  assert.equal(await domain({ ...GOOD, hd: 'example.com' }), 'example.com');
  assert.equal(await domain({ ...GOOD, hd: 'EXAMPLE.com' }), 'example.com');
  assert.equal(await domain({ ...GOOD, hd: 'other.com' }), 'DOMAIN_NOT_ALLOWED');
  assert.equal(await domain({ ...GOOD }), 'DOMAIN_NOT_ALLOWED', 'an account outside any Workspace is refused when a restriction exists');
  assert.equal(verdict(await g.verify(signed({ ...GOOD, hd: 'anything.org' }))), 'ACCEPTED', 'no restriction: any domain');
});

test('a malformed token is refused before any key is fetched', async () => {
  const g = googleKeys([{ status: 200, body: published(KEY_A) }]);
  const sig = signed(GOOD).split('.')[2]!;
  for (const token of [
    '',
    'a.b',
    'a.b.c.d',
    `${b64({ alg: 'RS256', kid: KEY_A.kid })}.${b64(GOOD)}.`,
    `!!.${b64(GOOD)}.${sig}`,
    `${b64({ alg: 'RS256', kid: KEY_A.kid })}.!!.${sig}`,
    `${b64({ alg: 'RS256', kid: KEY_A.kid })}..${sig}`,
    `bm90IGpzb24.${b64(GOOD)}.${sig}`,
    `${b64(['RS256'])}.${b64(GOOD)}.${sig}`,
    `${b64({ alg: 'RS256', kid: KEY_A.kid })}.${b64(GOOD)}.${sig}=`,
    `${'a'.repeat(16_385)}.b.c`,
    null as unknown as string,
  ]) {
    assert.deepEqual(await g.verify(token), { ok: false, refusal: 'MALFORMED' }, String(token).slice(0, 80));
  }
  assert.equal(g.calls.length, 0);
  // A payload that is not an object is found only after the signature verified.
  assert.equal(verdict(await g.verify(signed([1, 2] as unknown as Record<string, unknown>))), 'MALFORMED');
});
