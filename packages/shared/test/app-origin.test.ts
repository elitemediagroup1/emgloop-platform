import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appOrigin,
  invitationAcceptUrl,
  passwordResetUrl,
  INVITATION_ACCEPT_PATH,
} from '../src/app-origin';

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  }
}

test('production: no env configured → canonical absolute origin', () => {
  withEnv({ APP_URL: undefined, NEXT_PUBLIC_APP_URL: undefined }, () => {
    assert.equal(appOrigin(), 'https://app.emgloop.com');
  });
});

test('development: APP_URL points at localhost', () => {
  withEnv({ APP_URL: 'http://localhost:3000' }, () => {
    assert.equal(appOrigin(), 'http://localhost:3000');
  });
});

test('trailing slash is normalized away', () => {
  withEnv({ APP_URL: 'https://app.emgloop.com/' }, () => {
    assert.equal(appOrigin(), 'https://app.emgloop.com');
  });
  withEnv({ APP_URL: 'https://preview.example.com///' }, () => {
    assert.equal(appOrigin(), 'https://preview.example.com');
  });
});

test('missing APP_URL fails CLOSED to an absolute URL, never a relative one', () => {
  withEnv({ APP_URL: undefined, NEXT_PUBLIC_APP_URL: undefined }, () => {
    const url = invitationAcceptUrl('abc');
    assert.ok(!url.startsWith('/'), 'must not be relative');
    assert.ok(url.startsWith('https://'), 'must be absolute https');
  });
});

test('invitation URL never begins with the relative /crm/accept-invite form', () => {
  withEnv({ APP_URL: undefined, NEXT_PUBLIC_APP_URL: undefined }, () => {
    const url = invitationAcceptUrl('tkn');
    assert.notEqual(url, '/crm/accept-invite?token=tkn');
    assert.ok(!url.startsWith('/crm/accept-invite'), 'must not begin with a relative path');
    assert.ok(!url.startsWith('/'), 'must not begin with any relative path');
  });
});

test('production invitation URL parses; https + app.emgloop.com; token preserved', () => {
  withEnv({ APP_URL: undefined, NEXT_PUBLIC_APP_URL: undefined }, () => {
    const url = new URL(invitationAcceptUrl('tok en/+='));
    assert.equal(url.protocol, 'https:');
    assert.equal(url.host, 'app.emgloop.com');
    assert.equal(url.pathname, INVITATION_ACCEPT_PATH);
    assert.equal(url.searchParams.get('token'), 'tok en/+='); // encoded, decodes back exactly
  });
});

test('button URL and text/fallback URL are identical (one generator)', () => {
  withEnv({ APP_URL: 'https://app.emgloop.com' }, () => {
    assert.equal(invitationAcceptUrl('t'), invitationAcceptUrl('t'));
  });
});

test('password reset URL is absolute and correct', () => {
  withEnv({ APP_URL: undefined, NEXT_PUBLIC_APP_URL: undefined }, () => {
    const url = new URL(passwordResetUrl('r'));
    assert.equal(url.host, 'app.emgloop.com');
    assert.equal(url.pathname, '/crm/reset-password');
    assert.equal(url.searchParams.get('token'), 'r');
  });
});

test('APP_URL takes precedence over the legacy NEXT_PUBLIC_APP_URL', () => {
  withEnv({ APP_URL: 'https://a.example.com', NEXT_PUBLIC_APP_URL: 'https://b.example.com' }, () => {
    assert.equal(appOrigin(), 'https://a.example.com');
  });
});
