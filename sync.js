/* ------------------------------------------------------------------
   Shared-storage layer for Site Reports.

   Your app is untouched. It still reads and writes localStorage exactly
   as it always did. This file sits in front of localStorage and:

     1. On load  - pulls the shared report from the server and puts it
                   into localStorage BEFORE the app starts, so the app
                   finds it right where it expects.
     2. On save  - uploads any new photos to permanent storage, swaps the
                   base64 blobs for URLs, and pushes the report up to the
                   server so everyone else sees it.

   Net effect: same app, but the data lives on the server instead of
   inside one browser -- and the 5 MB ceiling is gone.
   ------------------------------------------------------------------ */
(function () {
  'use strict';

  var KEY = 'lfg-site-report-v1';
  var SAVE_DEBOUNCE_MS = 1500;

  var origGet = localStorage.getItem.bind(localStorage);
  var origSet = localStorage.setItem.bind(localStorage);

  // In-memory mirror. Used if localStorage refuses a write (quota) so the
  // app keeps working instead of showing "too many photos".
  var memory = null;
  var serverHadNothing = true;

  function cacheLocally(value) {
    memory = value;
    try { origSet(KEY, value); } catch (e) { /* quota - memory covers us */ }
  }

  /* ---------- 1. Preload the shared report, synchronously ---------- */
  // Deliberately synchronous: the app reads localStorage the instant it
  // mounts, so the data has to already be there. One blocking request on
  // first paint is a fair trade for not touching the app's code.
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/report', false);
    xhr.send(null);
    if (xhr.status === 200 && xhr.responseText && xhr.responseText !== 'null') {
      cacheLocally(xhr.responseText);
      serverHadNothing = false;
    }
  } catch (e) {
    // Offline or server down - fall through to whatever is already cached
    // locally. The app stays usable in the field with no signal.
  }

  /* ---------- 2. Serve reads from cache ---------- */
  localStorage.getItem = function (k) {
    if (k === KEY && memory !== null) return memory;
    return origGet(k);
  };

  /* ---------- 3. Photo offloading ---------- */
  var IMG_RE = /^data:image\/[a-zA-Z+]+;base64,/;

  function uploadPhoto(dataUrl) {
    return fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photo: dataUrl })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.url) || dataUrl; })
      .catch(function () { return dataUrl; }); // keep base64 rather than lose the photo
  }

  // Walks the report and replaces every base64 photo with a hosted URL.
  function offloadPhotos(report) {
    var jobs = [];

    function walkLots(lots) {
      (lots || []).forEach(function (lot) {
        (lot.issues || []).forEach(function (issue) {
          (issue.photos || []).forEach(function (photo, idx) {
            if (typeof photo === 'string' && IMG_RE.test(photo)) {
              jobs.push(
                uploadPhoto(photo).then(function (url) { issue.photos[idx] = url; })
              );
            }
          });
        });
      });
    }

    walkLots(report.lots);
    (report.history || []).forEach(function (h) { walkLots(h.lots); });

    return Promise.all(jobs).then(function () { return report; });
  }

  /* ---------- 4. Intercept saves ---------- */
  var timer = null;
  var latest = null;
  var inFlight = false;

  function pushToServer() {
    if (inFlight || latest === null) return;
    var payload = latest;
    latest = null;
    inFlight = true;

    var report;
    try { report = JSON.parse(payload); }
    catch (e) { inFlight = false; return; }

    offloadPhotos(report)
      .then(function (clean) {
        var body = JSON.stringify(clean);
        cacheLocally(body); // photos are URLs now - this fits comfortably
        return fetch('/api/report', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: body
        });
      })
      .then(function (r) {
        window.dispatchEvent(new CustomEvent('report-sync', {
          detail: { ok: r && r.ok }
        }));
      })
      .catch(function () {
        window.dispatchEvent(new CustomEvent('report-sync', { detail: { ok: false } }));
      })
      .then(function () {
        inFlight = false;
        if (latest !== null) pushToServer(); // coalesce edits made while saving
      });
  }

  localStorage.setItem = function (k, v) {
    if (k !== KEY) return origSet(k, v);
    cacheLocally(v);         // instant local save, never throws
    latest = v;
    clearTimeout(timer);
    timer = setTimeout(pushToServer, SAVE_DEBOUNCE_MS);
  };

  /* ---------- 5. First-run migration ---------- */
  // If the server has nothing yet but this browser already holds a report
  // (your machine, first visit after deploy), push it up so the existing
  // Rogers Branch work becomes the shared copy everyone sees.
  if (serverHadNothing) {
    var existing = origGet(KEY);
    if (existing) {
      memory = existing;
      latest = existing;
      setTimeout(pushToServer, 0);
    }
  }

  // Don't lose the last keystroke if the tab closes mid-debounce.
  window.addEventListener('beforeunload', function () {
    if (latest !== null && navigator.sendBeacon) {
      try {
        navigator.sendBeacon(
          '/api/report',
          new Blob([latest], { type: 'application/json' })
        );
      } catch (e) {}
    }
  });
})();
