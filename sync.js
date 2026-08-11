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
    // history must hold EVERY report, including the open one. The app builds
    // its Outstanding / Completed / All Reports lists from history alone, so
    // anything left out of it is invisible in those views.
    state.history = sorted;
    return state;
  }

  /* ---------- 1. Preload every report, synchronously ---------- */
  // Synchronous on purpose: the app reads localStorage the moment it mounts,
  // so the data has to already be sitting there.
  var serverHadNothing = true;
  var loadedAtStartup = [];   // exactly what the server held when we opened
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/reports', false);
    xhr.send(null);
    if (xhr.status === 200) {
      var list = JSON.parse(xhr.responseText || '[]');
      loadedAtStartup = list;
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

  /* ---------- 2b. Three-way merge ----------
     The author edits a report's content; other departments tick items
     complete on that same report. Both are writing to the same record, so a
     plain overwrite loses one side. We resolve it by comparing three
     versions of every field:

       base   - what the server held when THIS device opened the page
       ours   - what this device has now
       theirs - what the server holds at the moment we save

     If we didn't touch a field, take theirs. If we did, keep ours. Sign-offs
     (doneMap) are unioned, never overwritten, so a tick is never lost.
  --------------------------------------------------------------------- */
  function byId(arr) {
    var m = {};
    (arr || []).forEach(function (x) { if (x && x.id) m[x.id] = x; });
    return m;
  }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  function mergeFields(base, ours, theirs, skip) {
    var out = {};
    var keys = {};
    Object.keys(theirs || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(ours || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      if (skip && skip.indexOf(k) !== -1) return;
      var b = base ? base[k] : undefined;
      // untouched by us -> accept whatever the server has
      out[k] = same(ours ? ours[k] : undefined, b) ? (theirs || {})[k] : (ours || {})[k];
    });
    return out;
  }

  function mergeIssue(base, ours, theirs) {
    if (!ours) return theirs;
    if (!theirs) return ours;
    var out = mergeFields(base, ours, theirs, ['doneMap']);
    // union of sign-offs: if either side marked a department done, it's done
    var dm = {};
    Object.keys((theirs.doneMap) || {}).forEach(function (d) { dm[d] = theirs.doneMap[d]; });
    Object.keys((ours.doneMap) || {}).forEach(function (d) { dm[d] = ours.doneMap[d]; });
    out.doneMap = dm;
    return out;
  }

  function mergeLot(base, ours, theirs) {
    if (!ours) return theirs;
    if (!theirs) return ours;
    var out = mergeFields(base, ours, theirs, ['issues']);
    var bI = byId(base && base.issues), oI = byId(ours.issues), tI = byId(theirs.issues);
    var order = (ours.issues || []).map(function (i) { return i.id; });
    (theirs.issues || []).forEach(function (i) {
      if (order.indexOf(i.id) === -1 && !bI[i.id]) order.push(i.id); // added by them
    });
    out.issues = order.map(function (id) {
      return mergeIssue(bI[id], oI[id], tI[id]);
    }).filter(Boolean);
    return out;
  }

  function mergeReport(base, ours, theirs) {
    if (!theirs || !base) return ours;
    if (same(fingerprint(theirs), fingerprint(base))) return ours; // nobody else changed it
    var out = mergeFields(base, ours, theirs, ['lots']);
    var bL = byId(base.lots), oL = byId(ours.lots), tL = byId(theirs.lots);
    var order = (ours.lots || []).map(function (l) { return l.id; });
    (theirs.lots || []).forEach(function (l) {
      if (order.indexOf(l.id) === -1 && !bL[l.id]) order.push(l.id);
    });
    out.lots = order.map(function (id) {
      return mergeLot(bL[id], oL[id], tL[id]);
    }).filter(Boolean);
    return out;
  }

  function baselineFor(id) {
    for (var i = 0; i < loadedAtStartup.length; i++) {
      if (loadedAtStartup[i] && loadedAtStartup[i].id === id) return loadedAtStartup[i];
    }
    return null;
  }

  /* ---------- 3. Intercept saves ---------- */
  var timer = null;
  var latest = null;
  var inFlight = false;
  // id -> JSON string, so we only PUT reports this device actually changed.
  // Seeded with what the server held at page load: without this, the first
  // save would push back every report we merely READ, silently reverting
  // anyone else's edits made since we opened the page.
  // Content fingerprint, ignoring updatedAt - otherwise the timestamp we stamp
  // on every push would make each report look changed forever.
  function fingerprint(r) {
    var copy = {};
    Object.keys(r).forEach(function (k) { if (k !== 'updatedAt') copy[k] = r[k]; });
    return JSON.stringify(copy);
  }

  var lastSent = {};
  loadedAtStartup.forEach(function (r) {
    if (r && r.id) lastSent[r.id] = fingerprint(r);
  });

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

    // The open report now also appears in history, so the same id shows up
    // twice. Keep the first - that's the live one being edited.
    var seenId = {};
    reports = reports.filter(function (r) {
      if (seenId[r.id]) return false;
      seenId[r.id] = true;
      return true;
    });

    // Only finalized reports go to the shared server. A report you are still
    // writing stays on your own device until you press FINALIZE REPORT, so
    // nobody sees half-finished work and New Report never creates a blank.
    reports = reports.filter(function (r) { return r.published === true; });

    offloadPhotos(reports)
      .then(function (clean) {
        // Photos are URLs now - refresh the local cache so it stays small.
        var rebuilt = assemble(clean);
        if (rebuilt) cacheLocally(JSON.stringify(rebuilt));

        var changed = clean.filter(function (r) {
          var s = fingerprint(r);
          if (lastSent[r.id] === s) return false;
          lastSent[r.id] = s;
          return true;
        });

        return Promise.all(changed.map(function (r) {
          // Re-read this report immediately before writing, so anything a
          // colleague changed while we had the page open gets merged in
          // rather than flattened.
          return fetch('/api/reports?t=' + Date.now(), { cache: 'no-store' })
            .then(function (res) { return res.ok ? res.json() : []; })
            .then(function (serverList) {
              var theirs = null;
              (serverList || []).forEach(function (x) { if (x && x.id === r.id) theirs = x; });
              var merged = mergeReport(baselineFor(r.id), r, theirs);
              merged.updatedAt = Date.now();
              // this merged state becomes our new baseline
              lastSent[r.id] = fingerprint(merged);
              for (var i = 0; i < loadedAtStartup.length; i++) {
                if (loadedAtStartup[i] && loadedAtStartup[i].id === r.id) {
                  loadedAtStartup[i] = JSON.parse(JSON.stringify(merged));
                }
              }
              return fetch('/api/reports', {
                method: 'PUT',
                headers: editHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(merged)
              });
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
