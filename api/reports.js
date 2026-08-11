// Per-report storage. Each report is its own object in Blob storage, keyed by
// its own id, so two people working on different reports can never overwrite
// each other -- and starting a new report can't displace an existing one.
//
//   GET  /api/reports        -> [ {...}, {...} ]   every report, newest first
//   PUT  /api/reports        -> body: a single report object, saved by its id
//   DELETE /api/reports?id=X -> removes one report
//
// Photos are not stored here; they live in Blob storage as URLs (see upload.js).

import { put, list, del } from '@vercel/blob';

const PREFIX = 'reports/';

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

function authorized(req) {
  const required = process.env.EDIT_KEY;
  if (!required) return true; // no key configured -> open, as before
  return req.headers['x-edit-key'] === required;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    /* ---------------- read: open to everyone ---------------- */
    if (req.method === 'GET') {
      const { blobs } = await list({ prefix: PREFIX, limit: 1000 });

      const reports = await Promise.all(
        blobs.map(async (b) => {
          try {
            const r = await fetch(b.url, { cache: 'no-store' });
            return await r.json();
          } catch (e) {
            return null;
          }
        })
      );

      const clean = reports
        .filter(Boolean)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

      return res.status(200).json(clean);
    }

    /* ---------------- write: gated by EDIT_KEY --------------- */
    if (req.method === 'PUT' || req.method === 'POST') {
      if (!authorized(req)) {
        return res.status(401).json({ error: 'This report is read-only.' });
      }

      const report = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!report || !report.id) {
        return res.status(400).json({ error: 'Report must have an id.' });
      }

      report.updatedAt = report.updatedAt || Date.now();

      await put(`${PREFIX}${report.id}.json`, JSON.stringify(report), {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });

      return res.status(200).json({ ok: true, id: report.id, savedAt: report.updatedAt });
    }

    if (req.method === 'DELETE') {
      if (!authorized(req)) {
        return res.status(401).json({ error: 'This report is read-only.' });
      }
      const id = (req.query && req.query.id) || '';
      if (!id) return res.status(400).json({ error: 'Missing id.' });

      const { blobs } = await list({ prefix: `${PREFIX}${id}.json`, limit: 1 });
      if (blobs.length) await del(blobs[0].url);

      return res.status(200).json({ ok: true, deleted: id });
    }

    res.setHeader('Allow', 'GET, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
}
