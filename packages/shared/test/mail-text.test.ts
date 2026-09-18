// Reading an email as text: what a reader sees, and what can never reach them as markup.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mailReadableText, mailTextFromHtml, mailWithoutQuotedTail } from '../src/mail-text';

test('HTML becomes text, and nothing that arrives as markup survives as markup', () => {
  const html = '<p>Hi Matt,</p><p>Pricing is <b>still</b> open.</p><div>Ben</div>';
  assert.equal(mailTextFromHtml(html), 'Hi Matt,\n\nPricing is still open.\n\nBen');

  // Script, style and friends are removed WITH their contents: stripping their tags would leave
  // the source behind as text, which is how "sanitized" output still shows somebody code.
  const hostile = '<p>Hello</p><script>alert(document.cookie)</script><style>body{display:none}</style>';
  const text = mailTextFromHtml(hostile);
  assert.equal(text.includes('alert'), false);
  assert.equal(text.includes('display:none'), false);
  assert.equal(text, 'Hello');

  for (const attack of [
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">click</a>',
    '<iframe src="https://evil.example"></iframe>',
    '<svg/onload=alert(1)>',
    '<form action="https://evil.example"><input name="password"></form>',
  ]) {
    const out = mailTextFromHtml(attack);
    assert.equal(/[<>]/.test(out), false, attack);
    assert.equal(out.includes('onerror'), false, attack);
    assert.equal(out.includes('javascript:'), false, attack);
  }

  // Entities are decoded so a reader sees words, and decoding cannot reintroduce markup because
  // the result is rendered as text, never as HTML.
  assert.equal(mailTextFromHtml('<p>Ben &amp; Co &mdash; 30&nbsp;days</p>'), 'Ben & Co — 30 days');
});

test('a reader is shown text, the HTML fallback, or an honest nothing', () => {
  assert.equal(mailReadableText({ text: 'plain wins', html: '<p>ignored</p>' }), 'plain wins');
  assert.equal(mailReadableText({ text: '   ', html: '<p>fallback</p>' }), 'fallback');
  assert.equal(mailReadableText({ text: null, html: null }), null);
  // A message whose only content is an image has no words, and Loop does not invent some.
  assert.equal(mailReadableText({ text: null, html: '<img src="https://tracker.example/x.gif">' }), null);
});

test('the quoted history is cut, and a message that is only a reply is not emptied', () => {
  const reply = 'Sounds good.\n\nOn Thu, 18 Sep 2026 at 09:12, Ben <ben@x.example> wrote:\n> what about pricing?';
  const cut = mailWithoutQuotedTail(reply);
  assert.equal(cut.body, 'Sounds good.');
  assert.ok(cut.quotedLines > 0);

  assert.equal(mailWithoutQuotedTail('no quote here').body, 'no quote here');
  // A message that opens with a quote keeps it: cutting everything would leave nothing to read.
  assert.equal(mailWithoutQuotedTail('> only a quote').body, '> only a quote');
  assert.equal(mailWithoutQuotedTail('Yes.\n-----Original Message-----\nFrom: Ben').body, 'Yes.');
});
