import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  ConnectionSecretSealer, ConnectionSecretUnopenable, type ConnectionSecretBinding,
} from '../src/services/connections/connection-secret-sealer';

const KEY = randomBytes(32);
const sealer = new ConnectionSecretSealer(KEY);
const teams: ConnectionSecretBinding = { organizationId: 'org_a', userId: 'u1', provider: 'MICROSOFT_TEAMS', credentialKind: 'OAUTH_REFRESH_TOKEN' };
const telegram: ConnectionSecretBinding = { organizationId: 'org_a', userId: 'u1', provider: 'TELEGRAM', credentialKind: 'MTPROTO_SESSION' };

test('round-trips a secret and never stores it raw', () => {
  const sealed = sealer.seal(teams, 'refresh-token-xyz');
  assert.equal(sealer.open(teams, sealed), 'refresh-token-xyz');
  assert.equal(Buffer.from(sealed.sealed).toString('utf8').includes('refresh-token-xyz'), false, 'ciphertext is not the plaintext');
  assert.match(sealed.keyRef, /^connection-secret\/[0-9a-f]{16}$/);
});

test('binding is enforced: another org/user/provider/kind cannot open it', () => {
  const sealed = sealer.seal(teams, 'secret-1');
  for (const wrong of [
    { ...teams, organizationId: 'org_b' },
    { ...teams, userId: 'u2' },
    { ...teams, provider: 'TELEGRAM' as const },
    { ...teams, credentialKind: 'MTPROTO_SESSION' as const },
  ]) {
    assert.throws(() => sealer.open(wrong, sealed), ConnectionSecretUnopenable, JSON.stringify(wrong));
  }
});

test('a Telegram session and a Teams token do not cross-open', () => {
  const t = sealer.seal(telegram, 'mtproto-session-string');
  assert.equal(sealer.open(telegram, t), 'mtproto-session-string');
  assert.throws(() => sealer.open(teams, t), ConnectionSecretUnopenable);
});

test('a different key (rotation) makes an old secret unopenable, not silently wrong', () => {
  const sealed = sealer.seal(teams, 'secret-1');
  const other = new ConnectionSecretSealer(randomBytes(32));
  assert.throws(() => other.open(teams, sealed), ConnectionSecretUnopenable);
});

test('an empty secret is refused', () => {
  assert.throws(() => sealer.seal(teams, ''));
});
