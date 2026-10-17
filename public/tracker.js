/**
 * Zen-try Lightweight Analytics & Presence Tracker (< 10kb, zero dependencies)
 * Embed: <script src="https://YOUR_DOMAIN/tracker.js" async></script>
 */
(function (window, document) {
  'use strict';

  // Prevent multiple initializations on the same page
  if (window.__ZENTRY_TRACKER_INITIALIZED__ || window.__CHATIFY_TRACKER_INITIALIZED__) return;
  window.__ZENTRY_TRACKER_INITIALIZED__ = true;
  window.__CHATIFY_TRACKER_INITIALIZED__ = true;

  // 1. Resolve Backend API Endpoint
  var currentScript =
    document.currentScript ||
    document.querySelector('script[src*="tracker.js"]');
  var scriptSrc = currentScript ? currentScript.getAttribute('src') || '' : '';
  var scriptUrl = '';
  try {
    scriptUrl = new URL(scriptSrc, window.location.href).origin;
  } catch (e) {
    scriptUrl = window.location.origin;
  }

  var API_ENDPOINT =
    (currentScript && currentScript.getAttribute('data-endpoint')) ||
    scriptUrl + '/api/tracking';

  // The chat widget tracks the same visits itself (with its own visitor), so
  // on a page that has it this script would only count everyone twice.
  if (document.querySelector('script[src*="widget.js"]')) return;

  // Visitors belong to a workspace; without one there is nothing to track.
  var WORKSPACE_ID = currentScript ? currentScript.getAttribute('data-workspace-id') || '' : '';
  if (!/^[0-9a-f-]{36}$/i.test(WORKSPACE_ID)) return;

  // 2. Cookie Fallback Helpers
  function setCookie(name, val, days) {
    var expires = '';
    if (days) {
      var d = new Date();
      d.setTime(d.getTime() + days * 864e5);
      expires = '; expires=' + d.toUTCString();
    }
    document.cookie =
      name + '=' + encodeURIComponent(val) + expires + '; path=/; SameSite=Lax';
  }

  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(^|;\\s*)(' + name + ')=([^;]*)'));
    return match ? decodeURIComponent(match[3]) : null;
  }

  // 3. Visitor ID Persistence (localStorage with Cookie fallback)
  function getOrCreateVisitorId() {
    var vid = null;
    try {
      vid = window.localStorage.getItem('zentry_vid') || window.localStorage.getItem('chatify_vid');
    } catch (e) {}

    if (!vid) {
      vid = getCookie('_zentry_vid') || getCookie('_chatify_vid');
    }

    if (!vid) {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        vid = crypto.randomUUID();
      } else {
        vid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = (Math.random() * 16) | 0;
          var v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
      }
      try {
        window.localStorage.setItem('zentry_vid', vid);
        window.localStorage.setItem('chatify_vid', vid);
      } catch (e) {}
      setCookie('_zentry_vid', vid, 365);
      setCookie('_chatify_vid', vid, 365);
    } else {
      try {
        window.localStorage.setItem('zentry_vid', vid);
      } catch (e) {}
      setCookie('_zentry_vid', vid, 365);
    }
    return vid;
  }

  var VISITOR_ID = getOrCreateVisitorId();

  // The visitor's session token (docs/AUDIT.md H-3): /api/tracking issues it
  // on 'init' and accepts no other event without it.
  var TOKEN_KEY = 'zentry_vtoken';
  var VISITOR_TOKEN = null;
  try {
    VISITOR_TOKEN = window.localStorage.getItem(TOKEN_KEY);
  } catch (e) {}

  function startOverAsNewVisitor() {
    try {
      window.localStorage.removeItem('zentry_vid');
      window.localStorage.removeItem('chatify_vid');
      window.localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
    setCookie('_zentry_vid', '', -1);
    setCookie('_chatify_vid', '', -1);
    VISITOR_TOKEN = null;
    VISITOR_ID = getOrCreateVisitorId();
  }

  // 4. Session & Visit Count Tracking
  function getVisitCount() {
    var isNewSession = false;
    try {
      if (!window.sessionStorage.getItem('zentry_sid') && !window.sessionStorage.getItem('chatify_sid')) {
        isNewSession = true;
        var sid = 's_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
        window.sessionStorage.setItem('zentry_sid', sid);
        window.sessionStorage.setItem('chatify_sid', sid);
      }
    } catch (e) {
      isNewSession = true;
    }

    var count = 1;
    try {
      var saved = window.localStorage.getItem('zentry_vcount') || window.localStorage.getItem('chatify_vcount');
      count = saved ? parseInt(saved, 10) : 0;
      if (isNewSession) {
        count += 1;
        window.localStorage.setItem('zentry_vcount', count.toString());
        window.localStorage.setItem('chatify_vcount', count.toString());
      }
    } catch (e) {
      var cookieCount = getCookie('_zentry_vcount') || getCookie('_chatify_vcount');
      count = cookieCount ? parseInt(cookieCount, 10) : 0;
      if (isNewSession) {
        count += 1;
        setCookie('_zentry_vcount', count.toString(), 365);
        setCookie('_chatify_vcount', count.toString(), 365);
      }
    }
    return count || 1;
  }

  // 5. Client Metadata Detection (Device, Browser, OS)
  function getClientMetadata() {
    var ua = navigator.userAgent || '';
    var isMobile = /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    var isTablet = /(ipad|tablet|(android(?!.*mobile))|(windows(?!.*phone)(.*touch))|kindle|playbook|silk)/i.test(ua);
    var device = isTablet ? 'Tablet' : isMobile ? 'Mobile' : 'Desktop';

    var browser = 'Unknown';
    if (ua.indexOf('Edg/') > -1) browser = 'Edge';
    else if (ua.indexOf('Chrome/') > -1) browser = 'Chrome';
    else if (ua.indexOf('Safari/') > -1 && ua.indexOf('Chrome/') === -1) browser = 'Safari';
    else if (ua.indexOf('Firefox/') > -1) browser = 'Firefox';
    else if (ua.indexOf('OPR/') > -1 || ua.indexOf('Opera/') > -1) browser = 'Opera';

    var os = 'Unknown';
    if (ua.indexOf('Win') > -1) os = 'Windows';
    else if (ua.indexOf('Mac') > -1 && ua.indexOf('iPhone') === -1 && ua.indexOf('iPad') === -1) os = 'macOS';
    else if (ua.indexOf('Linux') > -1) os = 'Linux';
    else if (ua.indexOf('Android') > -1) os = 'Android';
    else if (ua.indexOf('iPhone') > -1 || ua.indexOf('iPad') > -1 || ua.indexOf('iPod') > -1) os = 'iOS';

    return {
      device: device,
      browser: browser,
      os: os,
    };
  }

  // 6. Free Geolocation Lookup with Session Caching
  function fetchLocation(callback) {
    try {
      var cached = window.sessionStorage.getItem('zentry_geo') || window.sessionStorage.getItem('chatify_geo');
      if (cached) {
        return callback(JSON.parse(cached));
      }
    } catch (e) {}

    // Query free geolocation endpoint
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://ipapi.co/json/', true);
    xhr.timeout = 2500;
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var res = JSON.parse(xhr.responseText);
          var geo = {
            city: res.city || null,
            country: res.country_name || res.country || null,
          };
          try {
            window.sessionStorage.setItem('zentry_geo', JSON.stringify(geo));
            window.sessionStorage.setItem('chatify_geo', JSON.stringify(geo));
          } catch (e) {}
          return callback(geo);
        } catch (e) {}
      }
      callback({ city: null, country: null });
    };
    xhr.onerror = xhr.ontimeout = function () {
      callback({ city: null, country: null });
    };
    xhr.send();
  }

  // 7. Dispatcher (fetch with keepalive / Beacon fallback). Waits for the
  // session token: before 'init' has answered there is nothing to prove.
  function sendPayload(payload) {
    if (!VISITOR_TOKEN) return;
    payload.visitor_token = VISITOR_TOKEN;
    var jsonStr = JSON.stringify(payload);
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      var blob = new Blob([jsonStr], { type: 'application/json' });
      var sent = navigator.sendBeacon(API_ENDPOINT, blob);
      if (sent) return;
    }
    if (typeof fetch !== 'undefined') {
      fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonStr,
        keepalive: true,
      }).catch(function () {});
    }
  }

  // 8. Initialization & First Pageview
  var clientMeta = getClientMetadata();
  var visitCount = getVisitCount();
  var lastTrackedUrl = window.location.href;

  function sendInit(geo, retried) {
    if (typeof fetch === 'undefined') return;
    fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'init',
        visitor_id: VISITOR_ID,
        visitor_token: VISITOR_TOKEN,
        workspace_id: WORKSPACE_ID,
        current_page_url: window.location.href,
        current_page_title: document.title,
        referrer_source: document.referrer || 'direct',
        device: clientMeta.device,
        browser: clientMeta.browser,
        os: clientMeta.os,
        ip_location_city: geo.city,
        ip_location_country: geo.country,
        visit_count: visitCount,
      }),
    })
      .then(function (res) {
        if (res.status === 401 && !retried) {
          // This id has a token this browser does not hold: start afresh.
          startOverAsNewVisitor();
          sendInit(geo, true);
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        if (data && data.visitor_token) {
          VISITOR_TOKEN = data.visitor_token;
          try {
            window.localStorage.setItem(TOKEN_KEY, VISITOR_TOKEN);
          } catch (e) {}
        }
      })
      .catch(function () {});
  }

  fetchLocation(function (geo) {
    sendInit(geo, false);
  });

  // 9. 15-Second Heartbeat
  var heartbeatInterval = setInterval(function () {
    sendPayload({
      event: 'heartbeat',
      visitor_id: VISITOR_ID,
      current_page_url: window.location.href,
      current_page_title: document.title,
    });
  }, 15000);

  // 10. SPA Navigation Listener (pushState, replaceState, popstate, hashchange)
  function onUrlChange() {
    var newUrl = window.location.href;
    if (newUrl === lastTrackedUrl) return;
    lastTrackedUrl = newUrl;

    // Small delay to let SPA frameworks update document.title
    setTimeout(function () {
      sendPayload({
        event: 'pageview',
        visitor_id: VISITOR_ID,
        url: window.location.href,
        title: document.title,
      });
    }, 100);
  }

  var wrapHistory = function (type) {
    var orig = window.history[type];
    if (typeof orig === 'function') {
      window.history[type] = function () {
        var result = orig.apply(this, arguments);
        onUrlChange();
        return result;
      };
    }
  };

  wrapHistory('pushState');
  wrapHistory('replaceState');
  window.addEventListener('popstate', onUrlChange);
  window.addEventListener('hashchange', onUrlChange);

  // 11. Tab Close / Pagehide Offline Beacon
  function onPageLeave() {
    sendPayload({
      event: 'offline',
      visitor_id: VISITOR_ID,
    });
  }

  window.addEventListener('pagehide', onPageLeave);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      sendPayload({
        event: 'heartbeat',
        visitor_id: VISITOR_ID,
        current_page_url: window.location.href,
        current_page_title: document.title,
      });
    }
  });
})(window, document);
