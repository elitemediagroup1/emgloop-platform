// Google OAuth for the Google Workspace connection: request shapes and failure classes,
// against a recording network double. No live call is made. ID-token verification has its
// own suite (google-workspace-id-token.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GOOGLE_OAUTH_ENDPOINTS,
  exchangeGoogleAuthorizationCode,
  googleAuthorizationUrl,
  refreshGoogleAccessToken,
  revokeGoogleToken,
} from '../src/google-workspace/oauth';

const CLIENT = { clientId: '123456789012-abcdef.apps.googleusercontent.com', clientSecret: 'client-secret-for-tests' };
const REDIRECT = 'https://app.emgloop.com/api/integrations/google/callback';

type Call = { url: string; init: { method: string; headers: Record<string, string>; body?: string } };

function network(responses: Array<{ status: number; body?: unknown } | 'throw' | 'hang'>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: Call['init'] & { signal?: AbortSignal }) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { status: 500 };
    if (next === 'throw') throw new Error('socket hang up with secret client-secret-for-tests');
    if (next === 'hang') {
      return new Promise<never>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return {
      status: next.status,
      json: async () => {
        if (next.body === undefined) throw new Error('not json');
        return next.body;
      },
    };
  };
  return { calls, fetchImpl };
}

test('the authorization URL asks for exactly what the flow documents: code, offline, cumulative, consent, state, nonce', () => {
  const url = new URL(
    googleAuthorizationUrl({
      clientId: CLIENT.clientId,
      redirectUri: REDIRECT,
      scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.metadata'],
      state: 'state-value',
      nonce: 'nonce-value',
    }),
  );
  assert.equal(`${url.origin}${url.pathname}`, GOOGLE_OAUTH_ENDPOINTS.authorize);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    response_type: 'code',
    client_id: CLIENT.clientId,
    redirect_uri: REDIRECT,
    scope: 'openid email https://www.googleapis.com/auth/gmail.metadata',
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state: 'state-value',
    nonce: 'nonce-value',
  });
  assert.equal(url.searchParams.has('hd'), false, 'no hosted-domain hint: the audience is External');
  assert.equal(url.searchParams.has('client_secret'), false, 'the secret never goes to the browser');
  const hinted = new URL(googleAuthorizationUrl({ clientId: CLIENT.clientId, redirectUri: REDIRECT, scopes: ['openid'], state: 's', nonce: 'n', loginHint: '110169484474386276334' }));
  assert.equal(hinted.searchParams.get('login_hint'), '110169484474386276334');
});

test('the code is exchanged server-side, form-encoded, with the client secret and the exact redirect URI', async () => {
  const { calls, fetchImpl } = network([
    { status: 200, body: { access_token: 'ya29.access', expires_in: 3599, refresh_token: '1//refresh', scope: 'openid email', token_type: 'Bearer', id_token: 'a.b.c' } },
  ]);
  const result = await exchangeGoogleAuthorizationCode({ fetchImpl, client: CLIENT, redirectUri: REDIRECT, code: '4/auth-code' });
  assert.deepEqual(result, {
    ok: true,
    grant: { accessToken: 'ya29.access', expiresInSeconds: 3599, refreshToken: '1//refresh', scope: 'openid email', idToken: 'a.b.c' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, GOOGLE_OAUTH_ENDPOINTS.token);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.equal(calls[0]!.init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0]!.init.body)), {
    code: '4/auth-code',
    client_id: CLIENT.clientId,
    client_secret: CLIENT.clientSecret,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
  });
});

test('failures are classes only: no body, code, token or secret is ever returned', async () => {
  const cases: Array<[Parameters<typeof network>[0][number], string]> = [
    [{ status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request with 4/auth-code' } }, 'INVALID_GRANT'],
    [{ status: 401, body: { error: 'invalid_client', error_description: 'client-secret-for-tests' } }, 'INVALID_CLIENT'],
    [{ status: 400, body: { error: 'unauthorized_client' } }, 'INVALID_CLIENT'],
    [{ status: 500, body: { error: 'server_error' } }, 'REJECTED'],
    [{ status: 502 }, 'REJECTED'],
    [{ status: 200, body: { token_type: 'Bearer' } }, 'MALFORMED'],
    [{ status: 200 }, 'MALFORMED'],
    ['throw', 'NETWORK'],
    ['hang', 'TIMEOUT'],
  ];
  for (const [response, failure] of cases) {
    const { fetchImpl } = network([response]);
    const result = await exchangeGoogleAuthorizationCode({ fetchImpl, client: CLIENT, redirectUri: REDIRECT, code: '4/auth-code', timeoutMs: 30 });
    assert.deepEqual(result, { ok: false, failure }, JSON.stringify(response));
    const text = JSON.stringify(result);
    for (const secret of ['4/auth-code', CLIENT.clientSecret, 'Bad Request', 'server_error']) assert.equal(text.includes(secret), false);
  }
});

test('refresh uses the stored refresh token and reports a dead grant as INVALID_GRANT', async () => {
  const ok = network([{ status: 200, body: { access_token: 'ya29.fresh', expires_in: 3600, scope: 'openid email' } }]);
  const refreshed = await refreshGoogleAccessToken({ fetchImpl: ok.fetchImpl, client: CLIENT, refreshToken: '1//refresh' });
  assert.deepEqual(refreshed, { ok: true, grant: { accessToken: 'ya29.fresh', expiresInSeconds: 3600, refreshToken: null, scope: 'openid email', idToken: null } });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(ok.calls[0]!.init.body)), {
    client_id: CLIENT.clientId,
    client_secret: CLIENT.clientSecret,
    refresh_token: '1//refresh',
    grant_type: 'refresh_token',
  });
  const dead = network([{ status: 400, body: { error: 'invalid_grant' } }]);
  assert.deepEqual(await refreshGoogleAccessToken({ fetchImpl: dead.fetchImpl, client: CLIENT, refreshToken: '1//refresh' }), { ok: false, failure: 'INVALID_GRANT' });
});

test('revoke posts the token to the revoke endpoint; an already-invalid token counts as revoked', async () => {
  const ok = network([{ status: 200, body: {} }]);
  assert.deepEqual(await revokeGoogleToken({ fetchImpl: ok.fetchImpl, token: '1//refresh token' }), { ok: true });
  assert.equal(ok.calls[0]!.url, `${GOOGLE_OAUTH_ENDPOINTS.revoke}?token=1%2F%2Frefresh+token`);
  assert.equal(ok.calls[0]!.init.method, 'POST');
  assert.equal(ok.calls[0]!.init.headers['content-type'], 'application/x-www-form-urlencoded');
  const gone = network([{ status: 400, body: { error: 'invalid_token' } }]);
  assert.deepEqual(await revokeGoogleToken({ fetchImpl: gone.fetchImpl, token: 't' }), { ok: true });
  const failed = network([{ status: 503 }]);
  assert.deepEqual(await revokeGoogleToken({ fetchImpl: failed.fetchImpl, token: 't' }), { ok: false, failure: 'REJECTED' });
  const down = network(['throw']);
  assert.deepEqual(await revokeGoogleToken({ fetchImpl: down.fetchImpl, token: 't' }), { ok: false, failure: 'NETWORK' });
});
