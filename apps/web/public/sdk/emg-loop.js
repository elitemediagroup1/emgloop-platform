/* EMG Loop SDK - emg-loop.js v1.1.0. First-party website intelligence for EMG properties.
 * Dependency-free browser tracker. It records an anonymous visit -- pages, scroll depth, meaningful clicks,
 * form starts/submits, ZIP searches, appointment requests, chat/planner activity -- batches the events and POSTs
 * them to the EMG Loop website webhook with retry and an offline queue. Not session replay: no DOM, no mouse
 * movement, no keystrokes, no input values. Configure via the script tag's data-* attributes:
 *   <script src="https://app.emgloop.com/sdk/emg-loop.js"
 *           data-property="servicesinmycity" data-ingest-key="pk_emg_servicesinmycity" async></script>
 *
 * SESSION (v1.1.0): one visit is one session id. It ends after 30 minutes WITHOUT MEANINGFUL ACTIVITY -- page
 * views, scrolling, clicks, form starts/submits, searches, appointment requests, chat/planner calls, and a
 * heartbeat while the page is visible all count. Activity updates the last-active time in memory; it is written
 * to storage at most once a minute and when the page is hidden or left, so navigating to the next page continues
 * the same session. Leaving a page sends `page_leave` -- never an end of the session.
 *
 * DELIVERY (v1.1.0): every request is CORS-simple (text/plain, no custom header; the public ingest key is in the
 * body), so no preflight is needed and page-hide beacons survive navigation. Delivered events are forgotten by id.
 *
 * MINIMIZED AT THE SOURCE: the page is its path (no query string); the referrer is its origin; utm source/medium
 * only; click labels are visible text or aria-label, collapsed and capped at 80 characters, and dropped when they
 * look like an email or phone number; link destinations are a path (internal) or a host (outbound); a search
 * leaves the browser only when it is a 5- or 9-digit ZIP. The Loop server minimizes again before storing.
 *
 * Source of truth: THIS file. apps/web/src/app/sdk/sdk-source.ts mirrors it byte for byte (a test enforces it).
 */
(function (window, document) {
  'use strict';
  if (!window || !document) return;
  if (window.__emgLoopLoaded) return;
  window.__emgLoopLoaded = true;

  var current =
    document.currentScript ||
    (function () {
      var s = document.getElementsByTagName('script');
      for (var i = s.length - 1; i >= 0; i--) {
        if (s[i].src && s[i].src.indexOf('emg-loop.js') !== -1) return s[i];
      }
      return null;
    })();
  var ds = (current && current.dataset) || {};
  var origin = (function () {
    try { return new URL(current.src).origin; } catch (e) { return 'https://app.emgloop.com'; }
  })();

  var config = {
    property: ds.property || 'website',
    ingestKey: ds.ingestKey || ds.key || '',
    endpoint: ds.endpoint || (origin + '/api/webhooks/website'),
    batchSize: parseInt(ds.batchSize, 10) || 10,
    flushIntervalMs: parseInt(ds.flushInterval, 10) || 5000,
    heartbeatMs: parseInt(ds.heartbeat, 10) || 30000,
    maxRetries: parseInt(ds.maxRetries, 10) || 5,
    scrollMilestones: [25, 50, 75, 100],
    debug: ds.debug === 'true'
  };

  function safeStore(kind) {
    try {
      var s = window[kind];
      var k = '__emg_probe';
      s.setItem(k, '1'); s.removeItem(k);
      return s;
    } catch (e) { return null; }
  }
  var ls = safeStore('localStorage');
  var ss = safeStore('sessionStorage');
  var mem = {};
  function get(store, key) {
    try { return store ? store.getItem(key) : mem[key] || null; } catch (e) { return mem[key] || null; }
  }
  function set(store, key, val) {
    try { if (store) { store.setItem(key, val); return; } } catch (e) {}
    mem[key] = val;
  }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) { try { return window.crypto.randomUUID(); } catch (e) {} }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ---- Anonymous identity: a browser id (persistent) and a visit id (30 minutes of inactivity) -----------
  var VISITOR_KEY = 'emg_visitor_id';
  var SESSION_KEY = 'emg_session_id';
  var SESSION_TS_KEY = 'emg_session_ts';
  var SESSION_MAX_IDLE = 30 * 60 * 1000;
  var PERSIST_EVERY = 60 * 1000;

  var visitorId = get(ls, VISITOR_KEY);
  if (!visitorId) { visitorId = uuid(); set(ls, VISITOR_KEY, visitorId); }

  var sessionId = get(ss, SESSION_KEY) || get(ls, SESSION_KEY);
  var lastActive = parseInt(get(ss, SESSION_TS_KEY) || get(ls, SESSION_TS_KEY), 10) || 0;
  var lastPersisted = 0;
  var pendingStart = false;

  function persistSession(now) {
    set(ss, SESSION_KEY, sessionId); set(ls, SESSION_KEY, sessionId);
    set(ss, SESSION_TS_KEY, String(lastActive)); set(ls, SESSION_TS_KEY, String(lastActive));
    lastPersisted = now;
  }
  // The current visit, renewed only after 30 minutes without meaningful activity.
  function ensureSession(now) {
    if (!sessionId || now - lastActive >= SESSION_MAX_IDLE) {
      sessionId = uuid();
      lastActive = now;
      pendingStart = true;
      persistSession(now);
    }
  }
  // Meaningful activity: keep the visit alive. In memory always; in storage at most once a minute.
  function touch(now) {
    ensureSession(now);
    lastActive = now;
    if (now - lastPersisted >= PERSIST_EVERY) persistSession(now);
  }

  // ---- Event queue with batching + retry + offline persistence ------------------------------------------
  var QUEUE_KEY = 'emg_queue';
  var queue = [];
  try { queue = JSON.parse(get(ls, QUEUE_KEY) || '[]') || []; } catch (e) { queue = []; }
  var flushing = false;
  var retries = 0;

  function persistQueue() { set(ls, QUEUE_KEY, JSON.stringify(queue.slice(0, 200))); }
  function log() { if (config.debug && window.console) console.log.apply(console, ['[emg-loop]'].concat([].slice.call(arguments))); }

  function param(name) {
    try { return new URLSearchParams(location.search).get(name) || ''; } catch (e) { return ''; }
  }
  function referrerOrigin() {
    try { return document.referrer ? new URL(document.referrer).origin : undefined; } catch (e) { return undefined; }
  }

  function baseFields() {
    return {
      property: config.property,
      visitorId: visitorId,
      sessionId: sessionId,
      page: location.pathname,
      title: bound(document.title, 120),
      referrer: referrerOrigin(),
      source: (param('utm_source') || param('gclid')) ? (param('utm_source') || 'paid') : undefined,
      medium: param('utm_medium') || undefined
    };
  }

  function push(event, props, now) {
    var ev = baseFields();
    ev.event = event;
    ev.id = uuid();
    ev.timestamp = new Date(now).toISOString();
    if (props) { for (var k in props) { if (Object.prototype.hasOwnProperty.call(props, k) && props[k] !== undefined && props[k] !== null && props[k] !== '') ev[k] = props[k]; } }
    queue.push(ev);
  }

  // Record an event. `activity` events keep the visit alive (and may open a new one after 30 idle minutes).
  function track(event, props, activity) {
    var now = Date.now();
    if (activity !== false) {
      touch(now);
      if (pendingStart && event !== 'session_start') { pendingStart = false; push('session_start', {}, now); }
    } else if (!sessionId || now - lastActive >= SESSION_MAX_IDLE) {
      // Not activity, and the visit has lapsed: it belongs to no visit. Never open a new one for it.
      return;
    }
    push(event, props, now);
    persistQueue();
    log('queued', event, props || {});
    if (queue.length >= config.batchSize) flush();
  }

  // Delivery is a CORS-SIMPLE request: a text/plain body (the JSON text) and no custom header -- the public ingest
  // key travels in the body. A simple request needs no preflight, so a page-hide beacon and a keepalive fetch both
  // survive navigation (browsers drop preflighted requests at unload, which lost events before v1.1.0).
  var CONTENT_TYPE = 'text/plain;charset=UTF-8';
  function forget(batch) {
    var sent = {};
    for (var i = 0; i < batch.length; i++) sent[batch[i].id] = true;
    // By id, never by position: events queued while a request was in flight stay queued.
    queue = queue.filter(function (e) { return !sent[e.id]; });
    persistQueue();
  }

  function flush(useBeacon) {
    if (queue.length === 0) return;
    // Leaving or hiding the page: hand EVERYTHING pending to the browser, even while a request is in flight. A
    // duplicate carries the same event id and is stored once.
    if (useBeacon && navigator.sendBeacon) {
      var all = queue.slice(0);
      try {
        var blob = new Blob([JSON.stringify({ property: config.property, ingestKey: config.ingestKey, events: all })], { type: CONTENT_TYPE });
        if (navigator.sendBeacon(config.endpoint, blob)) { forget(all); return; }
      } catch (e) {}
    }
    if (flushing) return;
    flushing = true;
    var batch = queue.slice(0, Math.max(config.batchSize, queue.length));
    var body = JSON.stringify({ property: config.property, ingestKey: config.ingestKey, events: batch });

    function onDone(ok) {
      flushing = false;
      if (ok) {
        forget(batch);
        retries = 0;
        if (queue.length > 0) flush();
      } else {
        retries = Math.min(retries + 1, config.maxRetries);
        var delay = Math.min(1000 * Math.pow(2, retries), 30000);
        log('flush failed; retry in', delay);
        setTimeout(function () { flush(); }, delay);
      }
    }

    try {
      fetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': CONTENT_TYPE },
        body: body,
        keepalive: true,
        credentials: 'omit'
      })
        .then(function (r) { onDone(r && r.ok); })
        .catch(function () { onDone(false); });
    } catch (e) { onDone(false); }
  }

  // ---- Minimization helpers --------------------------------------------------------------------------
  var EMAIL_LIKE = /[^\s@/]+@[^\s@/]+\.[a-z]{2,}/i;
  var PHONE_LIKE = /(?:\d[\s().-]*){7,}/;
  function bound(text, max) {
    var s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return undefined;
    if (EMAIL_LIKE.test(s) || PHONE_LIKE.test(s)) return undefined;
    return s.length > max ? s.slice(0, max) : s;
  }
  // A clickable element's human label: aria-label, an explicit CTA name, its RENDERED text (never hidden text),
  // its title, an image's alt, or a button input's own caption. Never an input's typed value.
  function labelOf(el) {
    var a = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('data-emg-cta') || el.getAttribute('data-cta'));
    if (a && a !== 'true' && a !== '') return bound(a, 80);
    if (el.tagName === 'INPUT') {
      var t = (el.getAttribute('type') || '').toLowerCase();
      return (t === 'submit' || t === 'button' || t === 'reset') ? bound(el.getAttribute('value'), 80) : undefined;
    }
    var text = typeof el.innerText === 'string' ? el.innerText : '';
    if (bound(text, 80)) return bound(text, 80);
    if (el.getAttribute && el.getAttribute('title')) return bound(el.getAttribute('title'), 80);
    var img = el.querySelector && el.querySelector('img[alt]');
    return img ? bound(img.getAttribute('alt'), 80) : undefined;
  }
  function parseHref(href) {
    try { return new URL(href, location.href); } catch (e) { return null; }
  }
  function isDownloadPath(path) { return /\.(pdf|zip|csv|xlsx?|docx?|pptx?|mp3|mp4|dmg|exe|pkg)$/i.test(path || ''); }
  function isZip(v) { return /^\d{5}(-\d{4})?$/.test(v || ''); }

  // ---- Instrumentation --------------------------------------------------------------------------------
  function instrument() {
    track('page_view', {});

    var hit = {};
    function onScroll() {
      var h = document.documentElement;
      var max = (h.scrollHeight - h.clientHeight) || 1;
      var pct = Math.min(100, Math.round(((h.scrollTop || window.pageYOffset) / max) * 100));
      for (var i = 0; i < config.scrollMilestones.length; i++) {
        var m = config.scrollMilestones[i];
        if (pct >= m && !hit[m]) { hit[m] = true; track('scroll_depth', { depth: m }); }
      }
    }
    window.addEventListener('scroll', throttle(onScroll, 400), { passive: true });

    // Meaningful clicks only: links, buttons, explicit CTAs. Never coordinates, never the DOM, never other elements.
    document.addEventListener('click', function (e) {
      var el = closest(e.target, 'a[href], button, [role="button"], input[type="submit"], input[type="button"], [data-emg-cta], [data-cta]');
      if (!el) return;
      var label = labelOf(el);
      var explicit = el.hasAttribute && (el.hasAttribute('data-emg-cta') || el.hasAttribute('data-cta'));
      var href = (el.tagName === 'A' && el.getAttribute('href')) || '';
      if (href) {
        var lower = href.toLowerCase();
        if (lower.indexOf('tel:') === 0) { track('phone_click', { cta: label, elementType: 'phone' }); return; }
        if (lower.indexOf('mailto:') === 0) { track('email_click', { cta: label, elementType: 'email' }); return; }
        var u = parseHref(href);
        if (u && (u.protocol === 'http:' || u.protocol === 'https:')) {
          var internal = u.host === location.host;
          if (isDownloadPath(u.pathname)) {
            track('download', internal ? { cta: label, elementType: 'download', destination: u.pathname } : { cta: label, elementType: 'download', destinationHost: u.host });
            return;
          }
          if (!internal) { track('external_link_click', { cta: label, elementType: 'outbound', destinationHost: u.host }); return; }
          if (explicit) { track('cta_click', { cta: label, elementType: 'cta', destination: u.pathname }); return; }
          // A same-page anchor is not a navigation.
          if (u.pathname === location.pathname && u.hash) return;
          track('link_click', { cta: label, elementType: 'link', destination: u.pathname });
          return;
        }
        if (!explicit) return;
      }
      if (explicit) { track('cta_click', { cta: label, elementType: 'cta' }); return; }
      var type = (el.getAttribute && (el.getAttribute('type') || '').toLowerCase()) || '';
      track('button_click', { cta: label, elementType: type === 'submit' ? 'submit' : 'button' });
    }, true);

    var started = {};
    document.addEventListener('focusin', function (e) {
      var f = closest(e.target, 'form');
      if (f && !started[formId(f)]) { started[formId(f)] = true; track('form_start', { form: formName(f) }); }
    }, true);
    document.addEventListener('submit', function (e) {
      var f = e.target;
      if (!f || f.tagName !== 'FORM') return;
      var name = formName(f);
      var zip = zipValue(f);
      if (zip) { track('zip_search', { zip: zip, form: name }); return; }
      if (/search/i.test(name) || hasSearchInput(f)) { track('search_performed', { form: name }); return; }
      if (/appoint|book|schedule/i.test(name)) { track('appointment_requested', { form: name }); return; }
      track('form_submitted', { form: name });
    }, true);
  }

  // A heartbeat while the page is VISIBLE is activity; a hidden tab sends nothing and lets the visit lapse.
  setInterval(function () { if (!document.hidden) track('heartbeat', {}); }, config.heartbeatMs);
  setInterval(function () { flush(); }, config.flushIntervalMs);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { persistSession(Date.now()); flush(true); }
  });
  // Leaving a page (including moving to the next one) is NOT the end of the visit: the visit ends only after 30
  // minutes without activity. Persist the visit clock so the next page continues it.
  window.addEventListener('pagehide', function () {
    track('page_leave', {}, false);
    persistSession(Date.now());
    flush(true);
  });
  window.addEventListener('online', function () { flush(); });

  window.emgLoop = {
    version: '1.1.0',
    config: { property: config.property, endpoint: config.endpoint, ingestKey: config.ingestKey },
    track: function (event, props) { track(String(event || 'custom'), {}); },
    flush: function () { flush(); },
    // Anonymous by design: identify() records that the site identified the browser, and sends no traits.
    identify: function () { track('identify', {}, false); },
    chatStart: function () { track('chat_started', {}); },
    chatComplete: function () { track('chat_completed', {}); },
    plannerStart: function () { track('planner_started', {}); },
    plannerSave: function () { track('planner_saved', {}); },
    // Only a ZIP code ever leaves the browser; free-text search terms do not.
    search: function (q) { var z = String(q || '').trim(); track(isZip(z) ? 'zip_search' : 'search_performed', isZip(z) ? { zip: z } : {}); }
  };

  function throttle(fn, ms) {
    var t = 0;
    return function () { var n = Date.now(); if (n - t >= ms) { t = n; fn(); } };
  }
  function closest(el, sel) {
    while (el && el.nodeType === 1) { if (el.matches && el.matches(sel)) return el; el = el.parentElement; }
    return null;
  }
  function formId(f) { return f.id || f.getAttribute('name') || (f.getAttribute('action') || '') + ':' + (f.className || ''); }
  function formName(f) { return bound(f.getAttribute('name') || f.getAttribute('id') || f.getAttribute('data-emg-form') || 'form', 80) || 'form'; }
  function searchInput(f) {
    return f.querySelector('input[type=search], input[name*=search i], input[name*=query i], input[name*=zip i], input[type=text]');
  }
  function hasSearchInput(f) { return !!f.querySelector('input[type=search], input[name*=search i], input[name*=query i]'); }
  // The ONLY input value ever read: a ZIP code, sent only when the whole value is one.
  function zipValue(f) {
    var el = searchInput(f);
    var v = el && el.value ? String(el.value).trim() : '';
    return isZip(v) ? v : '';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', instrument);
  } else {
    instrument();
  }
  log('initialized', config.property);
})(typeof window !== 'undefined' ? window : this, typeof document !== 'undefined' ? document : null);
