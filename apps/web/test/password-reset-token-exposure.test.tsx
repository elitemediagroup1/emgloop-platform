// Password reset: the reset link reaches only the account's own inbox.
//
// requestResetAction used to redirect the requester to
// /crm/forgot-password?sent=1&token=<plaintext>, and the page rendered that token
// as a working "Set a new password" link. /crm/forgot-password is public, so
// anyone who typed a user's email address -- an OWNER's included -- received a
// valid reset link for that account, and the extra parameter told them the
// account existed. These tests pin the fix at the source: the action's redirects
// carry no token, both branches land on the same URL, and the page neither reads
// nor renders one.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const code = (s: string) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

function functionBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

describe('Password reset request never exposes the reset token', () => {
  const body = code(functionBody(read('../src/auth/actions.ts'), 'requestResetAction'));

  it('still issues a token and emails the reset link', () => {
    assert.match(body, /createPasswordReset\(/);
    assert.match(body, /sendPasswordResetEmail\(/);
  });

  it('no redirect carries the token, and every redirect is the same destination', () => {
    const redirects = [...body.matchAll(/redirect\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    assert.ok(redirects.length >= 1);
    for (const r of redirects) {
      assert.doesNotMatch(r, /token/i, `redirect(${r})`);
      assert.equal(r, "'/crm/forgot-password?sent=1'", 'one identical destination whether or not the account exists');
    }
  });
});

describe('The forgot-password page never reads or renders a token', () => {
  const page = code(read('../src/app/crm/forgot-password/page.tsx'));

  it('does not accept a token parameter', () => {
    assert.doesNotMatch(page, /searchParams\.token|token\?\s*:/);
  });

  it('does not link to reset-password', () => {
    assert.doesNotMatch(page, /reset-password/);
  });
});
