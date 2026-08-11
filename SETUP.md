# Site Reports — shared storage setup

Your app is unchanged. Everything it does, it still does. The only difference
is that reports now live on the server instead of inside one browser, so
anyone who opens the link sees every report.

## What's in this folder

| File | What it does |
|---|---|
| `index.html` | Your app, with one line added to load `sync.js` |
| `sync.js` | Sits in front of localStorage — pulls reports down, pushes saves up |
| `api/report.js` | Stores and serves the shared report |
| `api/upload.js` | Stores photos permanently and returns URLs |
| `package.json` | Tells Vercel it needs the storage library |

## Setup — about 10 minutes, all in the Vercel dashboard

**1. Create the storage**

Go to your project → **Storage** → **Create Database** → choose **Blob** →
name it anything → **Create**. Connect it to the `site-reports` project when
prompted. This adds a `BLOB_READ_WRITE_TOKEN` automatically — you don't have
to copy anything.

Blob is free on the Hobby plan up to 1 GB. Your current report is about 2.5 MB.

**2. Deploy this folder**

Drag this whole `site-reports` folder onto Vercel, or connect it to a GitHub
repo first (recommended — see below). Vercel will install the dependency and
publish the API routes on its own.

**3. First visit does the migration**

Open the site **on this computer** first. `sync.js` sees the server is empty,
finds your existing Rogers Branch report in this browser, and uploads it —
photos and all. After that it's the shared copy. Watch for the photos to
finish uploading before closing the tab (36 of them, maybe a minute).

**4. Check it worked**

Open the site in a private/incognito window. You should see the Rogers Branch
report, not the Willow Bend placeholder.

## Every report is stored separately

Reports are saved individually in Blob storage, one file per report, keyed by
the report's own id (`reports/<id>.json`). This matters:

- Starting a new report can never displace an existing one
- Two people working on **different** reports cannot overwrite each other
- Nothing lives in a single all-or-nothing blob any more

The app still shows the most recently updated report as the open one, with
the rest in history — same as it always did.

## Locking down editing

`EDIT_KEY` makes the site read-only for everyone except devices you unlock.
Viewers notice no difference; they open the link and see every report.

**Turn it on:** Vercel → project → Settings → Environment Variables → add
`EDIT_KEY` with any phrase you like. Redeploy.

**Unlock your own devices:** visit the site once with the key in the URL —

    https://site-reports-lfg.vercel.app/?edit=YOUR_KEY

The key is saved on that device and stripped from the address bar
immediately, so it doesn't sit in your browser history. Do this on your
laptop and your phone. Anyone without it can read but not save.

If `EDIT_KEY` is not set, the site stays open to edits from anyone.

## Worth doing: put this in GitHub

There's currently no repo — this folder is the only copy of the code. If you
create a GitHub repo and connect it in Vercel (Settings → Git), you get
version history and every push deploys automatically. Right now a lost folder
means a lost app.

## Two things I fixed along the way

**The 5 MB wall.** Photos were stored as base64 text directly inside the
report, and browser storage caps at 5 MB. You were at 94.5% — one or two more
photos from a failed save. Photos now upload to Blob storage and the report
keeps only the URL, so the ceiling is gone.

**Duplicated history.** Every saved version kept a complete second copy of
every photo — your `history` was 2,476,395 bytes against 2,476,154 for the
live report, an almost exact mirror. Since photos are URLs now, history
snapshots are text-sized instead of megabytes.

## Backups already taken

In your Downloads folder:

- `lfg-site-report-backup-2026-08-11.json` — full data, photos included
- `index.html` — your original app, untouched

Keep both until the migration above is confirmed working.
