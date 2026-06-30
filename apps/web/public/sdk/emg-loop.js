/* EMG Loop SDK - emg-loop.js (Sprint 17). First-party website intelligence.
 * Lightweight, dependency-free browser tracker for every EMG property. It
 * captures sessions, page views, scroll depth, CTA/phone/email/outbound clicks,
 * form starts/submits, searches and ZIP searches, appointment requests,
 * downloads, AI chat + planner events, then batches them and POSTs to the EMG
 * Loop website webhook with retry + offline queue + heartbeat. No third-party
 * analytics libraries. Configure via the script tag data-* attributes:
 *   <script src="https://app.emgloop.com/sdk/emg-loop.js"
 *           data-property="servicesinmycity" data-ingest-key="pk_emg_servicesinmycity" data-organization="emg" async><\/script>
 *
 * Source of truth: apps/web/src/app/sdk/sdk-source.ts (kept in sync). This
 * static file is what the CDN serves at /sdk/emg-loop.js; /api/sdk/emg-loop
 * serves the identical source for programmatic consumers.
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
    organization: ds.organization || 'emg',
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
  var VISITOR_KEY = 'emg_visitor_id';
  var SESSION_KEY = 'emg_session_id';
  var SESSION_TS_KEY = 'emg_session_ts';
  var SESSION_MAX_IDLE = 30 * 60 * 1000;

  var visitorId = get(ls, VISITOR_KEY);
  if (!visitorId) { visitorId = uuid(); set(ls, VISITOR_KEY, visitorId); }

  var isNewSession = false;
  function currentSession() {
    var now = Date.now();
    var sid = get(ss, SESSION_KEY) || get(ls, SESSION_KEY);
    var last = parseInt(get(ss, SESSION_TS_KEY) || get(ls, SESSION_TS_KEY), 10) || 0;
    var fresh = sid && now - last < SESSION_MAX_IDLE;
    if (!fresh) { sid = uuid(); isNewSession = true; }
    set(ss, SESSION_KEY, sid); set(ls, SESSION_KEY, sid);
    set(ss, SESSION_TS_KEY, String(now)); set(ls, SESSION_TS_KEY, String(now));
    return sid;
  }
  var sessionId = currentSession();

  var identity = {};
  try { identity = JSON.parse(get(ls, 'emg_identity') || '{}') || {}; } catch (e) { identity = {}; }

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

  function baseFields() {
    return {
      property: config.property,
      organization: config.organization,
      visitorId: visitorId,
      sessionId: sessionId,
      page: location.pathname + location.search,
      url: location.href,
      title: document.title,
      referrer: document.referrer || undefined,
      source: (param('utm_source') || param('gclid')) ? (param('utm_source') || 'paid') : undefined,
      campaign: param('utm_campaign') || undefined,
      medium: param('utm_medium') || undefined,
      screen: (window.screen ? window.screen.width + 'x' + window.screen.height : undefined),
      email: identity.email,
      phone: identity.phone
    };
  }

  function track(event, props) {
    var ev = baseFields();
    ev.event = event;
    ev.id = uuid();
    ev.timestamp = new Date().toISOString();
    if (props) { for (var k in props) { if (Object.prototype.hasOwnProperty.call(props, k) && props[k] !== undefined) ev[k] = props[k]; } }
    queue.push(ev);
    persistQueue();
    log('queued', event, props || {});
    if (queue.length >= config.batchSize) flush();
  }

  function flush(useBeacon) {
    if (flushing || queue.length === 0) return;
    flushing = true;
    var batch = queue.slice(0, Math.max(config.batchSize, queue.length));
    var body = JSON.stringify({ property: config.property, organization: config.organization, ingestKey: config.ingestKey, events: batch });

    function onDone(ok) {
      flushing = false;
      if (ok) {
        queue = queue.slice(batch.length);
        persistQueue();
        retries = 0;
        if (queue.length > 0) flush();
      } else {
        retries = Math.min(retries + 1, config.maxRetries);
        var delay = Math.min(1000 * Math.pow(2, retries), 30000);
        log('flush failed; retry in', delay);
        setTimeout(function () { flush(); }, delay);
      }
    }

    if (useBeacon && navigator.sendBeacon) {
      try {
        var blob = new Blob([body], { type: 'application/json' });
        var sent = navigator.sendBeacon(config.endpoint, blob);
        onDone(sent);
        return;
      } catch (e) {}
    }

    try {
      fetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-EMG-Ingest-Key': config.ingestKey || '' },
        body: body,
        keepalive: true,
        credentials: 'omit'
      })
        .then(function (r) { onDone(r && r.ok); })
        .catch(function () { onDone(false); });
    } catch (e) { onDone(false); }
  }

  function instrument() {
    if (isNewSession) track('session_start', {});
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

    document.addEventListener('click', function (e) {
      var a = closest(e.target, 'a, button, [data-emg-cta]');
      if (!a) return;
      var href = (a.getAttribute && a.getAttribute('href')) || '';
      var cta = (a.getAttribute && (a.getAttribute('data-emg-cta') || a.getAttribute('data-cta'))) || textOf(a);
      if (href.indexOf('tel:') === 0) { track('phone_click', { cta: cta, phone_target: href.slice(4) }); return; }
      if (href.indexOf('mailto:') === 0) { track('email_click', { cta: cta, email_target: href.slice(7) }); return; }
      if (isDownload(href)) { track('download', { cta: cta, file: href }); return; }
      if (isOutbound(href)) { track('external_link_click', { cta: cta, target: href }); return; }
      if (a.hasAttribute && (a.hasAttribute('data-emg-cta') || a.hasAttribute('data-cta'))) { track('cta_click', { cta: cta }); }
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
      var q = searchValue(f);
      if (isZip(q)) { track('zip_search', { query: q, form: name }); return; }
      if (/search/i.test(name) || q) { track('search_performed', { query: q, form: name }); return; }
      if (/appoint|book|schedule/i.test(name)) { track('appointment_requested', { form: name }); return; }
      track('form_submitted', { form: name });
    }, true);
  }

  setInterval(function () { track('heartbeat', { visible: !document.hidden }); }, config.heartbeatMs);
  setInterval(function () { flush(); }, config.flushIntervalMs);
  document.addEventListener('visibilitychange', function () { if (document.hidden) flush(true); });
  window.addEventListener('pagehide', function () { track('session_end', {}); flush(true); });
  window.addEventListener('online', function () { flush(); });

  window.emgLoop = {
    version: '1.0.0',
    config: { property: config.property, organization: config.organization, endpoint: config.endpoint, ingestKey: config.ingestKey },
    track: track,
    flush: function () { flush(); },
    identify: function (traits) {
      if (!traits) return;
      for (var k in traits) { if (Object.prototype.hasOwnProperty.call(traits, k) && traits[k]) identity[k] = traits[k]; }
      set(ls, 'emg_identity', JSON.stringify(identity));
      track('identify', {});
    },
    chatStart: function (p) { track('chat_started', p || {}); },
    chatComplete: function (p) { track('chat_completed', p || {}); },
    plannerStart: function (p) { track('planner_started', p || {}); },
    plannerSave: function (p) { track('planner_saved', p || {}); },
    search: function (q, p) { track('search_performed', Object.assign({ query: q }, p || {})); }
  };

  function throttle(fn, ms) {
    var t = 0;
    return function () { var n = Date.now(); if (n - t >= ms) { t = n; fn(); } };
  }
  function closest(el, sel) {
    while (el && el.nodeType === 1) { if (el.matches && el.matches(sel)) return el; el = el.parentElement; }
    return null;
  }
  function textOf(el) { return (el.textContent || '').trim().slice(0, 80); }
  function isOutbound(href) {
    if (!href || href.indexOf('http') !== 0) return false;
    try { return new URL(href).host !== location.host; } catch (e) { return false; }
  }
  function isDownload(href) { return /\.(pdf|zip|csv|xlsx?|docx?|pptx?|mp3|mp4|dmg|exe|pkg)(\?|$)/i.test(href || ''); }
  function formId(f) { return f.id || f.name || (f.action || '') + ':' + (f.className || ''); }
  function formName(f) { return f.getAttribute('name') || f.getAttribute('id') || f.getAttribute('data-emg-form') || 'form'; }
  function searchValue(f) {
    var el = f.querySelector('input[type=search], input[name*=search i], input[name*=query i], input[name*=zip i], input[type=text]');
    return el && el.value ? String(el.value).trim().slice(0, 120) : '';
  }
  function isZip(v) { return /^\d{5}(-\d{4})?$/.test(v || ''); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', instrument);
  } else {
    instrument();
  }
  log('initialized', config.property);
})(typeof window !== 'undefined' ? window : this, typeof document !== 'undefined' ? document : null);
