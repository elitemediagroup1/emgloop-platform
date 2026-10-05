// The EMG Loop tracker (public/sdk/emg-loop.js v1.1.0), RUN -- not read: each test loads the real file into a VM
// with a minimal fake DOM, storage that survives page loads (localStorage, and sessionStorage within a tab), a
// controllable clock and captured network. Proves the session semantics, the page-leave semantics, the click
// coverage and the minimization at the source.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

import { EMG_LOOP_SDK_SOURCE, EMG_LOOP_SDK_VERSION } from '../src/app/sdk/sdk-source';

const SDK = readFileSync(join(__dirname, '..', 'public', 'sdk', 'emg-loop.js'), 'utf8');
const MIN = 60_000;
const T0 = Date.parse('2026-10-05T14:00:00Z');

// --- A minimal DOM ----------------------------------------------------------------------------------------

type Attrs = Record<string, string>;
interface FakeEl {
  nodeType: 1;
  tagName: string;
  attrs: Attrs;
  innerText?: string;
  textContent?: string;
  value?: string;
  parentElement: FakeEl | null;
  children: FakeEl[];
  className?: string;
  id?: string;
  getAttribute(n: string): string | null;
  hasAttribute(n: string): boolean;
  matches(sel: string): boolean;
  querySelector(sel: string): FakeEl | null;
}

function matchOne(el: FakeEl, sel: string): boolean {
  const m = /^([a-z]*)(?:\[([a-z-]+)(?:(\*?=)"?([^"\]\s]+)"?(\s+i)?)?\])?$/i.exec(sel.trim());
  if (!m) throw new Error('unsupported selector ' + sel);
  const [, tag, attr, op, val, ci] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  if (!attr) return true;
  const v = el.getAttribute(attr);
  if (v === null) return false;
  if (!op) return true;
  const a = ci ? v.toLowerCase() : v;
  const b = ci ? val!.toLowerCase() : val!;
  return op === '=' ? a === b : a.includes(b);
}

function el(tag: string, attrs: Attrs = {}, opts: { text?: string; hiddenText?: string; value?: string; children?: FakeEl[] } = {}): FakeEl {
  const node: FakeEl = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    attrs,
    // innerText is what is RENDERED; textContent would also include hidden text.
    innerText: opts.text ?? '',
    textContent: (opts.text ?? '') + (opts.hiddenText ?? ''),
    value: opts.value,
    parentElement: null,
    children: opts.children ?? [],
    id: attrs['id'],
    getAttribute: (n) => (n in attrs ? attrs[n]! : null),
    hasAttribute: (n) => n in attrs,
    matches: (sel) => sel.split(',').some((s) => matchOne(node, s)),
    querySelector: (sel) => {
      const walk = (n: FakeEl): FakeEl | null => {
        for (const c of n.children) {
          if (c.matches(sel)) return c;
          const d = walk(c);
          if (d) return d;
        }
        return null;
      };
      return walk(node);
    },
  };
  for (const c of node.children) c.parentElement = node;
  return node;
}

class FakeStorage {
  private m = new Map<string, string>();
  writes: string[] = [];
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.writes.push(k); this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}

/** One browser tab: localStorage across tabs, sessionStorage within the tab, one clock, one network log. */
function browser() {
  const clock = { now: T0 };
  const ls = new FakeStorage();
  const ss = new FakeStorage();
  const sent: Record<string, unknown>[][] = [];
  const requests: { kind: 'fetch' | 'beacon'; contentType: string; headers: string[] }[] = [];
  const held: (() => void)[] = [];
  let hold = false;
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

  function load(path: string, options: { search?: string; referrer?: string; title?: string; host?: string } = {}) {
    const host = options.host ?? 'servicesinmycity.com';
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const winListeners: Record<string, ((e: unknown) => void)[]> = {};
    const intervals: { fn: () => void; ms: number }[] = [];
    const doc = {
      currentScript: { src: 'https://app.emgloop.com/sdk/emg-loop.js', dataset: { property: 'servicesinmycity', ingestKey: 'pk_emg_servicesinmycity', organization: 'servicesinmycity-demo' } },
      readyState: 'complete',
      title: options.title ?? 'ServicesInMyCity',
      referrer: options.referrer ?? '',
      hidden: false,
      documentElement: { scrollHeight: 2000, clientHeight: 1000, scrollTop: 0 },
      addEventListener: (t: string, fn: (e: unknown) => void) => { (listeners[t] ??= []).push(fn); },
      getElementsByTagName: () => [],
    };
    class FakeDate extends Date {
      constructor(...a: unknown[]) { if (a.length === 0) super(clock.now); else super(...(a as [number])); }
      static now() { return clock.now; }
    }
    const win: Record<string, unknown> = {
      localStorage: ls,
      sessionStorage: ss,
      crypto: { randomUUID: uuid },
      addEventListener: (t: string, fn: (e: unknown) => void) => { (winListeners[t] ??= []).push(fn); },
      pageYOffset: 0,
      console,
    };
    const ctx = vm.createContext({
      window: win,
      document: doc,
      location: { pathname: path, search: options.search ?? '', href: `https://${host}${path}${options.search ?? ''}`, host, hostname: host },
      navigator: { sendBeacon: (_u: string, blob: { body: string; type: string }) => { requests.push({ kind: 'beacon', contentType: blob.type, headers: [] }); sent.push(JSON.parse(blob.body).events); return true; } },
      fetch: (_u: string, init: { body: string; headers: Record<string, string> }) => {
        requests.push({ kind: 'fetch', contentType: init.headers['Content-Type'] ?? '', headers: Object.keys(init.headers) });
        sent.push(JSON.parse(init.body).events);
        if (!hold) return Promise.resolve({ ok: true });
        return new Promise((resolve) => held.push(() => resolve({ ok: true })));
      },
      Blob: class { body: string; type: string; constructor(parts: string[], o: { type: string }) { this.body = parts.join(''); this.type = o.type; } },
      setInterval: (fn: () => void, ms: number) => { intervals.push({ fn, ms }); return intervals.length; },
      setTimeout: () => 0,
      URL, URLSearchParams, JSON, Math, Object, String, parseInt, console,
      Date: FakeDate,
    });
    vm.runInContext(SDK, ctx);
    const api = (win as { emgLoop: Record<string, (...a: unknown[]) => void> }).emgLoop;
    const fire = (t: string, target: FakeEl | null) => { for (const fn of listeners[t] ?? []) fn({ target }); };
    return {
      api,
      doc,
      click: (target: FakeEl) => fire('click', target),
      focus: (target: FakeEl) => fire('focusin', target),
      submit: (form: FakeEl) => fire('submit', form),
      scrollTo: (pct: number) => { doc.documentElement.scrollTop = (pct / 100) * 1000; for (const fn of winListeners['scroll'] ?? []) fn({}); },
      heartbeat: () => { for (const i of intervals) if (i.ms === 30_000) i.fn(); },
      flush: () => { for (const i of intervals) if (i.ms === 5_000) i.fn(); },
      hide: () => { doc.hidden = true; for (const fn of listeners['visibilitychange'] ?? []) fn({}); },
      leave: () => { for (const fn of winListeners['pagehide'] ?? []) fn({}); },
    };
  }

  // What the server stores: one row per event id (a re-sent event -- the queue survives a navigation while a
  // request is in flight -- carries the same id, and website ingestion dedupes on it).
  const raw = () => sent.flat() as Record<string, unknown>[];
  const events = () => {
    const seen = new Set<unknown>();
    return raw().filter((e) => (seen.has(e['id']) ? false : (seen.add(e['id']), true)));
  };
  return {
    clock, ls, ss, load, events, raw, requests,
    advance: (ms: number) => { clock.now += ms; },
    holdRequests: (on: boolean) => { hold = on; },
    releaseRequests: async () => { for (const r of held.splice(0)) r(); await new Promise((r) => setImmediate(r)); },
  };
}

const of = (events: Record<string, unknown>[], event: string) => events.filter((e) => e['event'] === event);
const sessions = (events: Record<string, unknown>[]) => [...new Set(events.map((e) => e['sessionId']))];

// --- The source of truth ---------------------------------------------------------------------------------

describe('the tracker source', () => {
  it('sdk-source.ts is a byte-for-byte mirror of the static file browsers load, with its version', () => {
    assert.equal(EMG_LOOP_SDK_SOURCE, SDK, 'regenerate: node apps/web/scripts/sync-sdk-source.cjs');
    assert.equal(EMG_LOOP_SDK_VERSION, '1.1.0');
    assert.match(SDK.split('\n')[0]!, /v1\.1\.0/);
  });
});

// --- Session semantics -------------------------------------------------------------------------------------

describe('session semantics: a visit ends after 30 minutes WITHOUT ACTIVITY, never on a page leave', () => {
  it('an active visitor on one page for 40 minutes, then navigating, stays in ONE session', () => {
    const b = browser();
    const a = b.load('/');
    const btn = el('button', {}, { text: 'Compare' });
    for (let m = 5; m <= 40; m += 5) {
      b.advance(5 * MIN);
      if (m % 10 === 0) a.click(btn);
      else a.heartbeat();
    }
    a.leave();
    b.advance(30_000);
    const p2 = b.load('/plumbers');
    p2.flush();
    const ev = b.events();
    assert.equal(sessions(ev).length, 1, 'one visit');
    assert.equal(of(ev, 'session_start').length, 1);
    assert.equal(of(ev, 'page_view').length, 2);
  });

  it('inactivity over 30 minutes starts a new session on the next activity', () => {
    const b = browser();
    const a = b.load('/');
    a.leave();
    b.advance(31 * MIN);
    const p2 = b.load('/plumbers');
    p2.flush();
    const ev = b.events();
    assert.equal(sessions(ev).length, 2);
    assert.equal(of(ev, 'session_start').length, 2);
    const second = ev.filter((e) => e['sessionId'] === sessions(ev)[1]);
    assert.deepEqual(second.map((e) => e['event']), ['session_start', 'page_view']);
  });

  it('a hidden tab sends no heartbeat and does not keep the visit alive', () => {
    const b = browser();
    const a = b.load('/');
    a.hide();
    for (let i = 0; i < 80; i++) { b.advance(30_000); a.heartbeat(); }
    b.advance(MIN);
    a.click(el('button', {}, { text: 'Back to it' }));
    a.flush();
    const ev = b.events();
    assert.equal(of(ev, 'heartbeat').length, 0, 'no heartbeat while hidden');
    assert.equal(sessions(ev).length, 2, 'the click after 41 idle minutes opens a new visit');
  });

  it('a visible heartbeat IS activity', () => {
    const b = browser();
    const a = b.load('/');
    for (let i = 0; i < 80; i++) { b.advance(30_000); a.heartbeat(); }
    a.click(el('button', {}, { text: 'Still here' }));
    a.flush();
    assert.equal(sessions(b.events()).length, 1);
  });

  it('Page A -> Page B is one session, and leaving a page is page_leave -- never session_end', () => {
    const b = browser();
    const a = b.load('/');
    b.advance(20_000);
    a.leave();
    b.advance(500);
    const p2 = b.load('/plumbers');
    b.advance(10_000);
    p2.leave();
    const ev = b.events();
    assert.equal(sessions(ev).length, 1);
    assert.equal(of(ev, 'session_end').length, 0, 'the tracker never claims a visit ended');
    assert.deepEqual(of(ev, 'page_leave').map((e) => e['page']), ['/', '/plumbers']);
    assert.deepEqual(ev.map((e) => e['event']), ['session_start', 'page_view', 'page_leave', 'page_view', 'page_leave']);
  });

  it('a page leave after the visit lapsed belongs to no visit: it is dropped and opens nothing', () => {
    const b = browser();
    const a = b.load('/');
    a.flush();
    const before = b.events().length;
    b.advance(45 * MIN);
    a.leave();
    assert.equal(b.events().length, before);
    assert.equal(of(b.events(), 'session_start').length, 1);
  });

  it('the visit clock is written to storage at most once a minute, plus on hide and leave -- not on every activity', () => {
    const b = browser();
    const a = b.load('/');
    const btn = el('button', {}, { text: 'Tap' });
    for (let i = 0; i < 600; i++) { b.advance(1_000); a.click(btn); }
    const writes = b.ls.writes.filter((k) => k === 'emg_session_ts').length;
    assert.ok(writes <= 11, `10 minutes of clicks every second wrote the clock ${writes} times`);
    a.leave();
    assert.equal(b.ls.writes.filter((k) => k === 'emg_session_ts').length, writes + 1, 'persisted on leave');
  });

  it('an event re-sent after a navigation (request still in flight) keeps its id, so the server stores it once', () => {
    const b = browser();
    const a = b.load('/');
    const btn = el('button', {}, { text: 'Tap' });
    for (let i = 0; i < 12; i++) { b.advance(1_000); a.click(btn); }
    a.leave();
    b.load('/next').flush();
    const raw = b.raw();
    assert.ok(raw.length > b.events().length, 'some events were sent twice');
    for (const e of b.events()) assert.ok(raw.filter((r) => r['id'] === e['id']).every((r) => JSON.stringify(r) === JSON.stringify(e)), 'a re-send is identical');
  });

  it('every request is CORS-simple: text/plain, no custom header (no preflight, so delivery survives navigation)', () => {
    const b = browser();
    const p = b.load('/');
    p.flush();
    p.leave();
    assert.ok(b.requests.length >= 2);
    for (const r of b.requests) {
      assert.equal(r.contentType, 'text/plain;charset=UTF-8', r.kind);
      assert.deepEqual(r.headers.filter((h) => h !== 'Content-Type'), [], 'no custom header');
    }
  });

  it('navigating before the flush timer loses nothing: the page-hide beacon carries every pending event', () => {
    const b = browser();
    const p = b.load('/');
    p.click(el('button', {}, { text: 'Compare prices' }));
    const form = el('form', { name: 'quote' }, { children: [el('input', { type: 'text', name: 'n' }, { value: 'x' })] });
    p.focus(form.children[0]!);
    p.submit(form);
    p.click(el('a', { href: '/plumbers' }, { text: 'Plumbers' }));
    p.leave();
    assert.deepEqual(b.events().map((e) => e['event']), ['session_start', 'page_view', 'button_click', 'form_start', 'form_submitted', 'link_click', 'page_leave']);
    assert.equal(b.requests.at(-1)!.kind, 'beacon');
    assert.equal(b.ls.getItem('emg_queue'), '[]', 'nothing left behind');
  });

  it('a page hide while a request is in flight beacons everything; the late completion does not drop newer events', async () => {
    const b = browser();
    const p = b.load('/');
    b.holdRequests(true);
    p.flush(); // in flight: session_start, page_view
    p.hide(); // beacon: everything pending, including the in-flight two
    b.holdRequests(false);
    p.doc.hidden = false;
    p.click(el('button', {}, { text: 'Back' }));
    await b.releaseRequests(); // the first request completes late
    p.flush();
    assert.deepEqual(b.events().map((e) => e['event']), ['session_start', 'page_view', 'button_click'], 'the click queued after the hide was delivered, not dropped');
  });

  it('a returning browser keeps its visitor id across separate sessions', () => {
    const b = browser();
    b.load('/').leave();
    b.advance(3 * 24 * 60 * MIN);
    b.load('/guides').flush();
    const ev = b.events();
    assert.equal(sessions(ev).length, 2);
    assert.equal(new Set(ev.map((e) => e['visitorId'])).size, 1);
  });
});

// --- Click coverage ----------------------------------------------------------------------------------------

describe('click coverage: meaningful clicks, minimized at the source', () => {
  function clickOne(target: FakeEl, path = '/') {
    const b = browser();
    const p = b.load(path);
    p.click(target);
    p.flush();
    return b.events().filter((e) => !['session_start', 'page_view'].includes(String(e['event'])));
  }

  it('an internal link click records its label and destination PATH; the next page view follows in the same session', () => {
    const b = browser();
    const p = b.load('/');
    p.click(el('a', { href: '/plumbers/austin-tx?utm_source=x&email=a@b.com#top' }, { text: 'Plumbers in Austin' }));
    p.leave();
    b.load('/plumbers/austin-tx').flush();
    const ev = b.events();
    const link = of(ev, 'link_click')[0]!;
    assert.equal(link['cta'], 'Plumbers in Austin');
    assert.equal(link['destination'], '/plumbers/austin-tx');
    assert.equal(link['elementType'], 'link');
    assert.deepEqual(ev.map((e) => e['event']), ['session_start', 'page_view', 'link_click', 'page_leave', 'page_view']);
    assert.equal(sessions(ev).length, 1);
  });

  it('buttons: a button, a role=button element, a submit button, an input button (its own caption only)', () => {
    assert.deepEqual(clickOne(el('button', {}, { text: 'Compare prices' })).map((e) => [e['event'], e['cta'], e['elementType']]), [['button_click', 'Compare prices', 'button']]);
    assert.deepEqual(clickOne(el('div', { role: 'button', 'aria-label': 'Open menu' })).map((e) => [e['event'], e['cta']]), [['button_click', 'Open menu']]);
    assert.deepEqual(clickOne(el('button', { type: 'submit' }, { text: 'Get quote' })).map((e) => [e['event'], e['elementType']]), [['button_click', 'submit']]);
    assert.deepEqual(clickOne(el('input', { type: 'submit', value: 'Send' })).map((e) => e['cta']), ['Send']);
  });

  it('an explicitly marked CTA', () => {
    const ev = clickOne(el('a', { href: '/quote', 'data-emg-cta': 'Hero quote' }, { text: 'Get started' }));
    assert.deepEqual(ev.map((e) => [e['event'], e['cta'], e['destination']]), [['cta_click', 'Hero quote', '/quote']]);
  });

  it('a phone click never carries the number: not the target, not a label made of it', () => {
    const ev = clickOne(el('a', { href: 'tel:+15125550147' }, { text: 'Call (512) 555-0147' }));
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!['event'], 'phone_click');
    assert.equal(ev[0]!['elementType'], 'phone');
    assert.doesNotMatch(JSON.stringify(ev), /555|0147|15125550147|tel:/);
    assert.equal(clickOne(el('a', { href: 'tel:+15125550147', 'aria-label': 'Call the office' }))[0]!['cta'], 'Call the office');
  });

  it('an email click never carries the address', () => {
    const ev = clickOne(el('a', { href: 'mailto:help@example.com' }, { text: 'help@example.com' }));
    assert.equal(ev[0]!['event'], 'email_click');
    assert.doesNotMatch(JSON.stringify(ev), /help@|example\.com|mailto/);
  });

  it('an outbound click records the destination HOST only', () => {
    const ev = clickOne(el('a', { href: 'https://partner.example/deals/42?ref=emg&token=abc' }, { text: 'See the deal' }));
    assert.deepEqual(ev.map((e) => [e['event'], e['cta'], e['destinationHost'], e['destination']]), [['external_link_click', 'See the deal', 'partner.example', undefined]]);
    assert.doesNotMatch(JSON.stringify(ev), /deals|token|ref=/);
  });

  it('a download records the file PATH (internal) or HOST (external), never a query', () => {
    const internal = clickOne(el('a', { href: '/files/water-heater-guide.pdf?token=abc' }, { text: 'Download the guide' }));
    assert.deepEqual(internal.map((e) => [e['event'], e['destination']]), [['download', '/files/water-heater-guide.pdf']]);
    const external = clickOne(el('a', { href: 'https://cdn.example/x/guide.pdf?sig=1' }, { text: 'Guide' }));
    assert.deepEqual(external.map((e) => [e['event'], e['destinationHost']]), [['download', 'cdn.example']]);
    assert.doesNotMatch(JSON.stringify([internal, external]), /token|sig=/);
  });

  it('same-page anchors and non-interactive elements record nothing', () => {
    assert.deepEqual(clickOne(el('a', { href: '#reviews' }, { text: 'Reviews' })), []);
    assert.deepEqual(clickOne(el('div', {}, { text: 'Some paragraph' })), []);
    assert.deepEqual(clickOne(el('span', {}, { text: 'Text' })), []);
  });

  it('labels are bounded to 80 characters, use rendered text only, and never arbitrary data-* attributes', () => {
    const long = 'Find the best licensed and insured plumbers near you today with free quotes and reviews from neighbors';
    const ev = clickOne(el('button', { 'data-user-id': 'u-123', 'data-secret': 's' }, { text: long, hiddenText: ' HIDDEN-ADMIN-NOTE' }));
    assert.equal(ev[0]!['cta'], long.slice(0, 80));
    assert.doesNotMatch(JSON.stringify(ev), /HIDDEN-ADMIN-NOTE|u-123|data-/);
  });

  it('a click payload holds only the minimized fields', () => {
    const ev = clickOne(el('a', { href: '/x' }, { text: 'X' }))[0]!;
    assert.deepEqual(Object.keys(ev).sort(), ['cta', 'destination', 'elementType', 'event', 'id', 'page', 'property', 'sessionId', 'timestamp', 'title', 'visitorId']);
  });
});

// --- Forms, search, query strings ------------------------------------------------------------------------

describe('forms and pages: no input values, no query strings', () => {
  it('a form submit carries the form name only -- never field contents or passwords', () => {
    const b = browser();
    const p = b.load('/contact');
    const form = el('form', { name: 'quote' }, { children: [el('input', { type: 'text', name: 'name' }, { value: 'Jane Doe' }), el('input', { type: 'email', name: 'email' }, { value: 'jane@example.com' }), el('input', { type: 'password', name: 'pw' }, { value: 'hunter2' })] });
    p.focus(form.children[0]!);
    p.submit(form);
    p.flush();
    const ev = b.events();
    assert.deepEqual(of(ev, 'form_start').map((e) => e['form']), ['quote']);
    assert.deepEqual(of(ev, 'form_submitted').map((e) => e['form']), ['quote']);
    assert.doesNotMatch(JSON.stringify(ev), /Jane|jane@|hunter2/);
  });

  it('a search leaves the browser only as a ZIP code; free-text search terms never do', () => {
    const b = browser();
    const p = b.load('/');
    p.submit(el('form', { name: 'search' }, { children: [el('input', { type: 'search', name: 'q' }, { value: 'burst pipe Jane 5125550147' })] }));
    p.submit(el('form', { name: 'zip' }, { children: [el('input', { type: 'text', name: 'zip' }, { value: '78701' })] }));
    p.api['search']!('water heater repair');
    p.api['search']!('10001');
    p.flush();
    const ev = b.events();
    assert.deepEqual(of(ev, 'zip_search').map((e) => e['zip']), ['78701', '10001']);
    assert.equal(of(ev, 'search_performed').length, 2);
    assert.doesNotMatch(JSON.stringify(ev), /burst|water heater|5125550147|query/);
  });

  it('page identity is the path; utm source/medium only; the referrer is an origin; no campaign, url, screen or contact', () => {
    const b = browser();
    const p = b.load('/', { search: '?utm_source=google&utm_medium=cpc&utm_campaign=Spring+Sale&email=a@b.com', referrer: 'https://www.bing.com/search?q=plumber+jane' });
    p.api['identify']!({ email: 'jane@example.com', phone: '5125550147' });
    p.flush();
    const ev = b.events();
    const view = of(ev, 'page_view')[0]!;
    assert.equal(view['page'], '/');
    assert.equal(view['source'], 'google');
    assert.equal(view['medium'], 'cpc');
    assert.equal(view['referrer'], 'https://www.bing.com');
    const text = JSON.stringify(ev);
    assert.doesNotMatch(text, /Spring|utm_campaign|a@b|plumber|jane|5125550147|"url"|"screen"|"campaign"|"organization"/);
    assert.equal(of(ev, 'identify').length, 1);
  });

  it('scroll milestones are recorded once per page', () => {
    const b = browser();
    const p = b.load('/');
    p.scrollTo(30);
    b.advance(500);
    p.scrollTo(80);
    b.advance(500);
    p.scrollTo(80);
    p.flush();
    assert.deepEqual(of(b.events(), 'scroll_depth').map((e) => e['depth']), [25, 50, 75]);
  });
});
