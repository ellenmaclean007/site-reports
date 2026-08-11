// GET  /api/report  -> returns the shared report JSON (or null if none yet)
// PUT  /api/report  -> saves the shared report JSON
//
// Photos are NOT stored in here. The browser uploads each photo to /api/upload
// first and stores only the returned URL, so this JSON stays small and fast.

import { put, list } from '@vercel/blob';

const BLOB_NAME = 'report-current.json';

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (req.method === 'GET') {
      const { blobs } = await list({ prefix: BLOB_NAME, limit: 1 });
      if (!blobs.length) {
        res.setHeader('Content-Type', 'application/json');
        return res.status(200).send('null');
      }
      const upstream = await fetch(blobs[0].url, { cache: 'no-store' });
      const text = await upstream.text();
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).send(text);
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      // Optional write protection. If EDIT_KEY is set in Vercel env vars,
      // the browser must send a matching x-edit-key header to save.
      const required = process.env.EDIT_KEY;
      if (required && req.headers['x-edit-key'] !== required) {
        return res.status(401).json({ error: 'Not authorized to edit.' });
      }

      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!body || body === 'null') {
        return res.status(400).json({ error: 'Empty body.' });
      }

      await put(BLOB_NAME, body, {
        access: 'public',
        contentType: 'application/json',
        addRandomSuffix: false,
        allowOverwrite: true,
      });

      return res.status(200).json({ ok: true, savedAt: Date.now() });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
}
