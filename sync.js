/* ------------------------------------------------------------------
   Shared storage for Site Reports.

   Your app is untouched. It still reads and writes localStorage exactly
   as it always did. This file sits in front of localStorage and:

     1. On load  - pulls EVERY report from the server and assembles them
                   into the shape your app expects (newest as the open
                   report, the rest as history).
     2. On save  - uploads new photos, then writes each report to the
                   server individually, keyed by its own id.

   Because reports are stored separately rather than as one big blob,
   two people working on different reports cannot overwrite each other,
   and starting a new report can never displace an existing one.

   Editing is gated by an edit key when EDIT_KEY is set on the server.
   Unlock a device once by visiting:  <site>/?edit=YOUR_KEY
   ------------------------------------------------------------------ */
(function () {
  'use strict';

  var KEY = 'lfg-site-report-v1';
  var EDIT_KEY_STORE = 'lfg-edit-key';
  var SAVE_DEBOUNCE_MS = 1500;

  var origGet = localStorage.getItem.bind(localStorage);
  var origSet = localStorage.setItem.bind(localStorage);

  var memory = null;

  function cacheLocally(value) {
    memory = value;
    try { origSet(KEY, value); } catch (e) { /* quota - memory covers us */ }
  }

  /* ---------- edit key ---------- */
  // Visiting /?edit=SOMEKEY stores the key on this device and cleans the URL,
  // so the key never lingers in the address bar or in browser history.
  try {
    var qs = new URLSearchParams(location.search);
    if (qs.has('edit')) {
      localStorage.setItem(EDIT_KEY_STORE, qs.get('edit'));
      qs.delete('edit');
      history.replaceState({}, '', location.pathname + (qs.toString() ? '?' + qs : ''));
    }
  } catch (e) {}

  function editHeaders(extra) {
    var h = extra || {};
    try {
      var k = origGet(EDIT_KEY_STORE);
      if (k) h['x-edit-key'] = k;
    } catch (e) {}
    return h;
  }

  /* ---------- report <-> app-state conversion ---------- */
  var STATE_ONLY = ['history', 'zoom', 'viewOnly', 'filterDept', 'saved', 'screen',
                    'logDept', 'logStatus', 'logView', 'openDept'];

  function toReport(state) {
    var r = {};
    Object.keys(state).forEach(function (k) {
      if (STATE_ONLY.indexOf(k) === -1) r[k] = state[k];
    });
    return r;
  }

  // Server gives us a flat list. The app wants one open report plus history.
  function assemble(reports) {
    if (!reports || !reports.length) return null;
    var sorted = reports.slice().sort(function (a, b) {
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    var current = sorted[0];
    var state = {};
    Object.keys(current).forEach(function (k) { state[k] = current[k]; });
    state.history = sorted.slice(1);
    return state;
  }

  /* ---------- 1. Preload every report, synchronously ---------- */
  // Synchronous on purpose: the app reads localStorage the moment it mounts,
  // so the data has to already be sitting there.
  var serverHadNothing = true;
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/reports', false);
    xhr.send(null);
    if (xhr.status === 200) {
      var list = JSON.parse(xhr.responseText || '[]');
      var assembled = assemble(list);
      if (assembled) {
        cacheLocally(JSON.stringify(assembled));
        serverHadNothing = false;
      }
    }
  } catch (e) {
    // Offline - fall back to whatever this device already has cached, so the
    // app stays usable on a job site with no signal.
  }

  localStorage.getItem = function (k) {
    if (k === KEY && memory !== null) return memory;
    return origGet(k);
  };

  /* ---------- 2. Photo offloading ---------- */
  var IMG_RE = /^data:image\/[a-zA-Z+]+;base64,/;

  function uploadPhoto(dataUrl) {
    return fetch('/api/upload', {
      method: 'POST',
      headers: editHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ photo: dataUrl })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.url) || dataUrl; })
      .catch(function () { return dataUrl; }); // keep base64 rather than lose a photo
  }

  function offloadPhotos(reports) {
    var jobs = [];
    reports.forEach(function (rep) {
      (rep.lots || []).forEach(function (lot) {
        (lot.issues || []).forEach(function (issue) {
          (issue.photos || []).forEach(function (photo, idx) {
            if (typeof photo === 'string' && IMG_RE.test(photo)) {
              jobs.push(uploadPhoto(photo).then(function (url) {
                issue.photos[idx] = url;
              }));
            }
          });
        });
      });
    });
    return Promise.all(jobs).then(function () { return reports; });
  }

  /* ---------- 3. Intercept saves ---------- */
  var timer = null;
  var latest = null;
  var inFlight = false;
  var lastSent = {}; // id -> JSON string, so we only PUT what actually changed

  function pushToServer() {
    if (inFlight || latest === null) return;
    var payload = latest;
    latest = null;
    inFlight = true;

    var state;
    try { state = JSON.parse(payload); }
    catch (e) { inFlight = false; return; }

    // Every report this device knows about: the open one plus its history.
    var reports = [toReport(state)].concat(state.history || []);
    reports = reports.filter(function (r) { return r && r.id; });

    offloadPhotos(reports)
      .then(function (clean) {
        // Photos are URLs now - refresh the local cache so it stays small.
        var rebuilt = assemble(clean);
        if (rebuilt) cacheLocally(JSON.stringify(rebuilt));

        var changed = clean.filter(function (r) {
          var s = JSON.stringify(r);
          if (lastSent[r.id] === s) return false;
          lastSent[r.id] = s;
          return true;
        });

        return Promise.all(changed.map(function (r) {
          r.updatedAt = Date.now();
          return fetch('/api/reports', {
            method: 'PUT',
            headers: editHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify(r)
          });
        }));
      })
      .then(function (results) {
        var ok = results.every(function (r) { return r && r.ok; });
        var denied = results.some(function (r) { return r && r.status === 401; });
        window.dispatchEvent(new CustomEvent('report-sync', {
          detail: { ok: ok, readOnly: denied }
        }));
      })
      .catch(function () {
        window.dispatchEvent(new CustomEvent('report-sync', { detail: { ok: false } }));
      })
      .then(function () {
        inFlight = false;
        if (latest !== null) pushToServer();
      });
  }

  localStorage.setItem = function (k, v) {
    if (k !== KEY) return origSet(k, v);
    cacheLocally(v);
    latest = v;
    clearTimeout(timer);
    timer = setTimeout(pushToServer, SAVE_DEBOUNCE_MS);
  };

  /* ---------- 4. First-run migration ---------- */
  if (serverHadNothing) {
    var existing = origGet(KEY);
    if (existing) {
      memory = existing;
      latest = existing;
      setTimeout(pushToServer, 0);
    }
  }
})();
