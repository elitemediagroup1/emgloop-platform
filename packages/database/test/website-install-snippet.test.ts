// The Website Manager's install snippet (sdkInstallScript) is what an operator pastes into a site. Until 2026-10-05
// its opening <script> tag was never closed (`async` then `</script>`), so a pasted snippet left the element open and
// swallowed the markup after it. This test parses it the way a browser tokenizes a start tag.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EMG_WEBSITE_PROPERTIES, propertyIngestKey, sdkInstallScript } from '../src/integration-catalog';
import { webPropertyIngestKey } from '@emgloop/shared';

/** The start tag up to its closing '>' (outside quotes), and what follows. */
function splitStartTag(html: string): { tag: string; rest: string } | null {
  let quote: string | null = null;
  for (let i = 0; i < html.length; i++) {
    const c = html[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return { tag: html.slice(0, i + 1), rest: html.slice(i + 1) };
  }
  return null;
}

test('every portfolio snippet is a well-formed external script: closed start tag, empty body, closing tag', () => {
  for (const p of EMG_WEBSITE_PROPERTIES) {
    const html = sdkInstallScript(p, 'servicesinmycity-demo');
    const split = splitStartTag(html);
    assert.ok(split, `${p.key}: the start tag closes`);
    assert.doesNotMatch(split!.tag, /<\/script/i, `${p.key}: the closing tag is not inside the start tag`);
    assert.match(split!.tag, /^<script\s/);
    assert.match(split!.tag, /\sasync>$/);
    assert.equal(split!.rest.trim(), '</script>', `${p.key}: nothing between the tags`);
    assert.match(split!.tag, new RegExp(`data-property="${p.key}"`));
    assert.match(split!.tag, new RegExp(`data-ingest-key="${propertyIngestKey(p)}"`));
    assert.equal(propertyIngestKey(p), webPropertyIngestKey(p.key), 'the snippet key is the key admission resolves');
    assert.match(split!.tag, /src="https:\/\/app\.emgloop\.com\/sdk\/emg-loop\.js"/);
  }
});
