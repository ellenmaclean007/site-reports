// POST /api/upload  { photo: "data:image/jpeg;base64,..." }  -> { url }
//
// Takes one base64 photo from the browser, stores it in Vercel Blob, and
// returns a permanent URL. The app then stores the URL instead of the
// megabytes of base64 -- which is what removes the 5 MB ceiling entirely.

import { put } from '@vercel/blob';

export const config = {
  api: { bodyParser: { sizeLimit: '12mb' } },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const required = process.env.EDIT_KEY;
    if (required && req.headers['x-edit-key'] !== required) {
      return res.status(401).json({ error: 'Not authorized to upload.' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const dataUrl = body && body.photo;

    const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl || '');
    if (!match) return res.status(400).json({ error: 'Expected a base64 image data URL.' });

    const contentType = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    const ext = (contentType.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const name = `photos/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;

    const blob = await put(name, buffer, {
      access: 'public',
      contentType,
      addRandomSuffix: false,
    });

    return res.status(200).json({ url: blob.url });
  } catch (err) {
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
}
