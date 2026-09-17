// The EMG Loop wordmark is the official artwork (traced to vector), not a lookalike.
//
// It used to be SVG <text> set in Inter plus a hand-drawn infinity, which rendered with
// the wrong letterforms and proportions. These pin the replacement: both tones render the
// supplied artwork at its own aspect ratio, the public files are plain, font-free,
// script-free vector drawings in the brand colours, and every place that shows the mark
// uses this one component.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { EMG_LOOP_WORDMARK_ASPECT, EMG_LOOP_WORDMARK_SRC, EmgLoopWordmark } from '../src/app/crm/_brand/Logos';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(WEB + p, 'utf8');

describe('The EMG Loop wordmark', () => {
  it('renders the official artwork for each tone, at its own aspect ratio', () => {
    for (const [tone, height] of [['default', 26], ['onDark', 22], ['default', 30]] as const) {
      const html = renderToStaticMarkup(<EmgLoopWordmark height={height} tone={tone} />);
      assert.match(html, new RegExp(`src="${EMG_LOOP_WORDMARK_SRC[tone]}"`));
      assert.match(html, /alt="EMG Loop"/);
      assert.match(html, new RegExp(`width="${Math.round(height * EMG_LOOP_WORDMARK_ASPECT)}" height="${height}"`));
      assert.equal(/<text|<svg/.test(html), false, 'no lookalike drawing');
    }
    const code = read('src/app/crm/_brand/Logos.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/<text|<svg/.test(code), false, 'the component draws nothing itself');
  });

  it('ships two font-free, script-free vector files in the brand colours, sized as the component says', () => {
    for (const [file, start, end] of [
      [EMG_LOOP_WORDMARK_SRC.default, '#213366', '#5f9e8f'],
      [EMG_LOOP_WORDMARK_SRC.onDark, '#ffffff', '#8fd3c3'],
    ] as const) {
      const path = 'public' + file;
      assert.ok(existsSync(WEB + path), path);
      const svg = read(path);
      assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
      assert.equal(/<text|<script|<foreignObject|\son[a-z]+=|href=|<image|@import|url\((?!#g\))/i.test(svg), false, `${path} is a plain drawing`);
      const vb = svg.match(/viewBox="([\d. ]+)"/)![1]!.split(' ').map(Number);
      assert.ok(Math.abs(vb[2]! / vb[3]! - EMG_LOOP_WORDMARK_ASPECT) < 1e-9, 'aspect matches the component');
      assert.match(svg, new RegExp(`<stop offset="0" stop-color="${start}"/><stop offset="1" stop-color="${end}"/>`));
      assert.equal((svg.match(/<path /g) ?? []).length, 1);
      assert.match(svg, /fill-rule="evenodd"/);
      assert.ok(svg.length < 60_000, 'small enough to serve as a static asset');
    }
  });

  it('is the one mark the shell and the sign-in screen use', () => {
    const shell = read('src/workspaces/WorkspaceShell.tsx');
    assert.match(shell, /<EmgLoopWordmark height=\{22\} tone="onDark" \/>/, 'the navy rail');
    assert.match(shell, /<EmgLoopWordmark height=\{22\} \/>/, 'the light phone header');
    const login = read('src/app/crm/login/page.tsx');
    assert.equal((login.match(/<EmgLoopWordmark /g) ?? []).length, 2);
    const auth = read('src/app/crm/sprint7.css');
    assert.equal(/loop-auth__(brand-top|mobile-brand) svg/.test(auth), false, 'no rule reshapes the old drawing');
    assert.match(auth, /\.loop-auth__mobile-brand \.emg-wordmark \{\n  height: 26px;\n  width: auto;/);
  });
});
