# muSync

**Local-first music organizer with a transparent algorithm.**

muSync is a browser-based music library manager. You own the data — it lives in your browser, never on a server, never in the cloud. It catalogs your songs, learns how you listen, and offers a Smart Shuffle that shows you exactly *why* it picked what it picked. If you don't like what it does, you can see the weights it uses and change them.

---

## Table of contents

- [What it is](#what-it-is)
- [Philosophy](#philosophy)
- [Feature status](#feature-status)
- [Architecture](#architecture)
- [Data model](#data-model)
- [The algorithm](#the-algorithm)
- [Storage strategy](#storage-strategy)
- [Getting started (development)](#getting-started-development)
- [Building for production](#building-for-production)
- [Deploying to GitHub Pages](#deploying-to-github-pages)
- [Importing music](#importing-music)
- [Backup and recovery](#backup-and-recovery)
- [Project layout](#project-layout)
- [Roadmap](#roadmap)
- [Credits](#credits)

---

## What it is

muSync is a **single-page application** that stores your entire music library — songs, artists, credits, listening history, playlists — **in your own browser**, using SQLite compiled to WebAssembly, persisted to IndexedDB.

There is no backend. There is no account. There is no upload. When you close the tab, your data stays on your device. When you open it on a different computer, that computer has its own copy. The **Backup** panel is how you move data between devices.

What muSync does:

- **Catalogs** songs with structured metadata (title, artists with roles, listening stats).
- **Detects duplicates** (exact title + artist, or fuzzy title match).
- **Plays** attached audio/video files stored in the browser.
- **Learns** your listening patterns over time.
- **Generates** three kinds of queues: linear, random, and Smart.
- **Shows its work** — every weight, every transition, every stat it uses is visible and editable.

---

## Philosophy

Three rules drive every design decision:

1. **Your data is yours.** No server. No analytics. No third-party API calls. The only network request muSync ever makes is fetching its own static assets (JS/WASM/CSS) and — on first import only — a helper script from a public CDN for the file inspector.

2. **The algorithm is not a black box.** Every factor that goes into a Smart Shuffle recommendation is named, weighted, and adjustable. The "What I know about you" panel shows you the raw telemetry the algorithm learns from. The "Algorithm settings" panel lets you override it.

3. **Nothing you can't undo.** Backups are one click. Migrations run in transactions. Deletes require confirmation. Schema changes are versioned and reversible in principle.

---

## Feature status

**Working**

- Add songs individually or in bulk via CSV (Spotify / YouTube Music exports).
- Multi-artist credits with `MAIN` / `FEATURED` roles.
- Search, sort (6 modes), edit, delete.
- Duplicate detection: exact `title + artist`, and fuzzy (normalized title).
- Per-song "Why" panel: play count, completions, skips, manual picks, last-played, top-predecessor transitions.
- Listening event recording: START / SKIP / COMPLETE, with `previous_event_id` chaining.
- Automatic transition aggregation (`transitions` table).
- Automatic per-song stats aggregation (`song_stats` table).
- Three playback modes: `none` (library order), `random`, `smart`.
- Visible, persistent, reorderable queue.
- Backup / restore via `.db` file download/upload.
- SQLite schema migrations (versioned, run automatically on boot).
- OPFS-backed media storage with IndexedDB fallback.

**In progress / next**

- **Auto-advance** — the queue currently generates and persists but playback doesn't walk through it automatically yet.
- **Video playback** — files are stored correctly but the player element needs to switch to `<video>` for video mime types.
- **Drag-reorder in library** for the "Manual order" sort mode.
- **Real learning** — learned-weight proposal is implemented but fires even with zero data; will be gated on a minimum event count.

**Planned**

- Album / year metadata (columns exist, not populated).
- Advanced duplicate merge (choose which entry to keep, migrate history).
- Playlist snapshots (export a specific ordering).
- Explicit re-computation of transitions / stats from raw events (rebuild from source).

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  index.html                                                  │
│   panels: add / library / playback / queue / duplicates /    │
│           knowledge / weights / backup / csv import / player │
└───────────────┬──────────────────────────────────────────────┘
                │
        ┌───────▼───────┐
        │   main.js     │  boot, wire events, glue
        └───┬───┬───┬───┘
            │   │   │
   ┌────────▼─┐ │ ┌─▼────────────┐
   │  db.js   │ │ │ algorithm.js │  weights, scoring, learning
   │ migrations│ │ └─┬────────────┘
   │ pragmas  │ │   │
   └────┬─────┘ │ ┌─▼────────────┐
        │       │ │  shuffle.js  │  none / random / smart
   ┌────▼─────┐ │ └─┬────────────┘
   │library.js│ │   │
   │ queries  │◄┼───┘
   └────┬─────┘ │
        │       │
   ┌────▼───────▼────┐      ┌─────────────────────┐
   │  storage.js     │      │  idb-kv.js          │
   │  OPFS ⇄ IDB     │      │  (DB blob + KV)     │
   │  audio/video    │      └─────────────────────┘
   └─────────────────┘
```

**`src/main.js`** is the entry point. It boots the DB, wires all UI event handlers, and orchestrates playback. It does not contain business logic — that lives in the modules below it.

**`src/db.js`** opens SQLite via `sql.js`, applies pragmas, runs versioned migrations, and handles persistence to IndexedDB. It exports generic SQL helpers (`exec`, `run`, `queryAll`, `queryOne`, `tx`) and a debounced `persist()`.

**`src/library.js`** holds every read/write operation the rest of the app needs: `listSongs`, `addSongInternal`, `updateSong`, `deleteSongs`, `findDuplicates`, `attachMedia`, `recordEvent`, `topTransitions`, `songStats`, `saveQueue`, `loadQueue`, etc. **No other module runs raw SQL against user tables.** This is the single point of contact with the schema, which means schema changes only touch two files: `db.js` (migration) and `library.js` (query).

**`src/algorithm.js`** implements the four-factor scoring function used by Smart Shuffle, plus the learned-weight heuristic and the "should I propose a change?" logic.

**`src/shuffle.js`** builds queues for each of the three modes. Smart mode is a Markov chain that consults `transitions`, `song_stats`, and the scoring function.

**`src/storage.js`** stores audio/video blobs. It uses **OPFS (Origin Private File System)** when available — streaming, huge capacity, real files — and falls back to **IndexedDB** transparently. Same three-function API either way: `saveFile`, `getFile`, `deleteFile`.

**`src/idb-kv.js`** is a tiny key/value wrapper over IndexedDB, used exclusively to persist the SQLite DB blob (`musync.db.blob`) and small UI prefs.

**`src/ui/*.js`** are pure presentation modules. Each owns one panel. They never touch SQL directly — they call into `library.js`.

---

## Data model

The schema is deliberately more normalized than a simple song list needs. A "song" in the UI is the composition of several rows.

```
works                    (the abstract song idea — title, artist credit)
  └── recordings         (a specific recording of that work — could be studio/live/remix later)
        └── media        (a link to a stored file)
              └── local_files    (metadata about the file: name, size, format)
  └── credits            (who is credited, in what role, in what order)
        └── artists      (canonical artist records, deduplicated by name)
  └── playlist_entries   (the library's manual ordering)
  └── song_stats         (incrementally-maintained per-song aggregates)
  └── transitions        (incrementally-maintained "A → B" play counts)

playback_sessions        (one session per browser tab, roughly)
  └── listening_events   (START / SKIP / COMPLETE, chained via previous_event_id)

queues                   (persisted Smart Shuffle queues)
  └── queue_items        (ordered entries with cached reasons)

settings                 (key/value JSON; includes schema_version, weights, prefs)
```

Why so many tables?

- **Multiple artists per song with roles.** The `credits` table lets a song have a main artist, featured artists, and (later) producers, composers, remixers. `role` and `order_index` preserve the presentation order.
- **Audio files are decoupled from songs.** You can attach, detach, or replace a file without touching the song's identity or losing its listening history.
- **Stats and transitions are precomputed.** The alternative is running a self-join over `listening_events` every time the UI renders — fine at 100 events, catastrophic at 500,000.
- **History is immutable.** `listening_events` is append-only. If the aggregate tables ever get out of sync, they can be rebuilt from the raw events.

---

## The algorithm

Smart Shuffle picks the next song by scoring every candidate on four factors, each normalized to `0..1`, and multiplying by a user weight (default `0..100`).

| Factor | What it measures | Signal |
|---|---|---|
| **Transition strength** | How often `current → candidate` has happened in your history | `transitions[current][candidate] / max(transitions[current])` |
| **Novelty boost** | How long since you last played the candidate | `min(1, days_since_last_play / 14)` |
| **Time-of-day match** | How often you play this song at the current hour | `hour_histogram[now] / total_plays_of_song` |
| **Skip penalty** | How often you skip this song | `-skip_count / play_count` |

The weighted sum is the candidate's score. Highest score wins, gets added to the queue, and becomes the new `current` for the next iteration. That's it — no neural nets, no embeddings, no opaque model. Every number that goes in is a number you can see.

**Defaults:**

```js
{ transition: 40, novelty: 25, timeOfDay: 20, skipPenalty: 15 }
```

**Learned weights:** the algorithm periodically derives an "observed" weight profile by looking at how much of your history is transition-driven, how novel your picks are, how peaked your hour histogram is, and how often you skip. If the learned profile differs from the current weights by more than a threshold (sum of absolute differences ≥ 12), it shows a "The algorithm thinks it learned something" prompt in the Algorithm settings panel. You can accept the new weights, dismiss the suggestion (it won't be offered again for that same learned profile), or turn learning off entirely with the "Learning: on/off" toggle.

No ML. No training. Just observation and arithmetic, in a form you can read in `src/algorithm.js` in a minute.

---

## Storage strategy

| Data | Where | Why |
|---|---|---|
| SQLite DB blob (all metadata) | **IndexedDB** (`musync-kv` DB, key `musync.db.blob`) | Async, huge, binary-safe. |
| Audio/video files | **OPFS**, fallback IndexedDB (`musync-files` DB) | OPFS is streamable, filesystem-like, no size ceiling. IDB is the safety net. |
| Small prefs (selected mode, learning toggle) | **SQLite `settings` table** | Consolidated with everything else. |
| Legacy `localStorage['musync.db']` | **Read on first boot only** | Auto-migrated to IndexedDB. Kept as `musync.db.broken` if unreadable. |

**Nothing in `localStorage` is used for live data.** That was the old architecture. The current version reads the old key once, imports it, and never touches it again — except to leave the rescue copy in place.

**Capacity expectations:**

- Metadata: SQLite blob stays under a few MB even at 50k songs. IndexedDB handles this trivially.
- Audio: one file per song. OPFS capacity is limited by browser quota, typically 50%+ of free disk space.
- Video: same, but OPFS's streaming read is the reason it's viable at all. IndexedDB would load the whole video into memory on read; OPFS reads just the bytes the `<video>` element requests.

---

## Getting started (development)

**Requirements:** Node 20+, npm 10+.

```bash
# clone
git clone https://github.com/<you>/muSync.git
cd muSync

# install
npm install

# dev server
npm run dev -- --host
```

Vite serves at `http://localhost:5173/muSync/`. The `--host` flag exposes it on your LAN so you can open it from a phone or another device for testing. In GitHub Codespaces, Vite will detect the environment and hand you a forwarded URL.

**First boot:**

1. `initDb()` checks IndexedDB for `musync.db.blob`.
2. If absent, it checks `localStorage['musync.db']` and migrates if found.
3. If still absent, it creates a fresh empty DB.
4. Migrations run. `schema_version` is stored in `settings`.
5. The app renders.

Open DevTools → Console. You'll see one of:

```
[db] loaded from IndexedDB
[db] migrated from legacy localStorage (kept as rescue copy)
[db] fresh database
```

---

## Building for production

```bash
npm run build
```

Output goes to `dist/`. Because `vite.config.js` sets `base: '/muSync/'`, all asset URLs are prefixed correctly for a GitHub Pages project site.

To preview the production build locally:

```bash
npm run preview
```

This serves the built files at `http://localhost:4173/muSync/`.

**Important:** `sql.js`'s WASM binary is emitted to `dist/assets/`. If you ever see a 404 on `sql-wasm-*.wasm`, the fix is in `src/db.js` — the `?url` import is what tells Vite to emit it. Don't remove that line.

---

## Deploying to GitHub Pages

The repository ships with a GitHub Actions workflow at `.github/workflows/deploy.yml`. On every push to `main`:

1. Checkout.
2. `npm install`.
3. `npm run build`.
4. Upload `dist/` as a Pages artifact.
5. Deploy to Pages.

**One-time setup in your repo:**

1. Go to **Settings → Pages**.
2. Under **Build and deployment → Source**, select **GitHub Actions**.
3. Push to `main` — the workflow runs automatically.

Your app will be live at:

```
https://<your-username>.github.io/muSync/
```

**Case matters.** The repo name is `muSync` (capital S), so the Pages path is `/muSync/` (capital S). This matches `base` in `vite.config.js` and `start_url` in `public/manifest.webmanifest`. If you ever rename the repo, update both.

**Deploy to Pages for real use.** Codespaces URLs are ephemeral — every time the Codespace restarts, the random subdomain changes, and with it your browser's origin, and with *that*, your IndexedDB. Deploying to Pages gives you a stable URL where your data persists indefinitely. Use `npm run dev` for development; use the Pages URL as your daily driver.

---

## Importing music

Two paths.

### CSV import

The **Import from CSV** panel accepts a comma-separated file with a title column and an artist column. Header matching is loose and case-insensitive:

- Title column: matched against `track name`, `title`, or anything containing those words.
- Artist column: matched against `artist name(s)`, `artist name`, `artist`, or anything containing "artist".

Both Spotify account-data exports and YouTube Music Takeout CSVs work out of the box.

**Artist separation.** Multiple artists are separated by **semicolons only** — not commas, because many artist names contain commas ("Earth, Wind & Fire"). `feat.` inside an artist name is preserved as part of the name, not treated as a separator.

Examples that parse correctly:

```
Daft Punk; Julian Casablancas          → two credits: Daft Punk (MAIN), Julian Casablancas (FEATURED)
Kendrick Lamar; feat. SZA              → two credits: Kendrick Lamar (MAIN), "feat. SZA" (FEATURED)
Earth, Wind & Fire                     → one credit: Earth, Wind & Fire (MAIN)
```

**Duplicates.** Re-importing the same CSV twice will produce duplicates. Run the Duplicates panel afterward to clean up.

### Backup restore

If you already have a `musync-*.db` file from a previous version, use **Backup → Upload library**. It reads the file, runs migrations if needed, and replaces the current database.

---

## Backup and recovery

**Backup → Download library** produces a `musync-<timestamp>.db` file — a plain SQLite database. That file is *your entire library*. It contains all works, artists, credits, listening history, stats, and queue state.

**Backup → Upload library** reads such a file and replaces the current database.

**How often to back up:** any time you'd be annoyed to lose the last N days of listening. A weekly download to cloud storage or a USB stick is plenty.

**What's not in a backup:** audio files and video files. Those live in OPFS/IndexedDB separately because they're large. If you've attached audio, download it separately or back up the browser profile. *Note: exporting attached media alongside the DB is a planned feature.*

**What if the DB gets corrupted:**

1. The old `localStorage['musync.db']` copy, if present, is preserved as `localStorage['musync.db.broken']` — you can extract it from DevTools if needed.
2. Your most recent downloaded `.db` file works via Upload library.
3. If neither exists, the schema migrations are non-destructive and you can usually start fresh and re-import from CSV.

---

## Project layout

```
.
├── .github/
│   └── workflows/
│       └── deploy.yml              GitHub Pages deployment
├── public/
│   └── manifest.webmanifest        PWA manifest
├── src/
│   ├── main.js                     Entry point; UI wiring; playback; CSV parser
│   ├── db.js                       SQLite init; pragmas; migrations; persistence
│   ├── library.js                  All read/write queries against the schema
│   ├── algorithm.js                Scoring; learned weights; proposal logic
│   ├── shuffle.js                  Queue generation (none / random / smart)
│   ├── storage.js                  OPFS ⇄ IndexedDB media storage
│   ├── idb-kv.js                   Tiny IndexedDB key/value store (DB blob)
│   ├── idb.js                      Compatibility shim (re-exports from storage.js)
│   ├── style.css                   All styles
│   └── ui/
│       ├── render.js               Library list + inline edit
│       ├── duplicates.js           Duplicate scan + bulk delete
│       ├── queue.js                Queue rendering + drag reorder
│       ├── knowledge.js            Knowledge panel + "Why this song"
│       ├── weights.js              Algorithm settings + learned-diff prompt
│       └── status.js               Shared status helper
├── index.html                      SPA shell; all panels declared here
├── package.json
├── vite.config.js
└── README.md
```

**Where to look for what:**

- Add a new field to a song? Start at `db.js` (add a migration), then `library.js` (add it to `addSongInternal` / `updateSong` / `listSongs`), then `ui/render.js` (display it).
- Change the algorithm? `algorithm.js`. Weights live there; scoring lives there.
- Fix a bug in playback? `main.js`. The `playFile` function is the entire playback path.
- Add a new panel? Add HTML to `index.html`, add a new module under `src/ui/`, call it from `main.js`.

---

## Roadmap

**Near term**

1. **Auto-advance queue.** Playback currently stops at end-of-song. Wire `audio.onended` to advance to the next queue item, skip deleted songs, and log a `COMPLETE` event.
2. **Video playback.** Detect `video/*` mime types and swap the `<audio>` element for a `<video>` element in the fixed player.
3. **Drag reorder in library.** Enable drag handles in the "Manual order" sort mode so the `playlist_entries.position` column becomes user-editable.
4. **Gate the learning prompt.** Currently fires on zero data. Require at least 50 playback events before proposing learned weights.

**Medium term**

5. Album and year columns populated from CSV (schema already supports them).
6. Advanced duplicate merge: choose the winner, migrate listening history from the losers.
7. Rebuild-transitions tool: regenerate `transitions` and `song_stats` from raw `listening_events` (useful after schema changes).
8. Export queue as a plain text list.

**Long term**

9. Playlist snapshots (multiple named orderings of the same works).
10. Multi-device sync via an optional user-controlled sync target (never a muSync server — likely a WebDAV folder or a Git repo).
11. Embedded album art.

---

## Credits

Built as a solo project, for personal use, with the belief that recommendation algorithms should be legible.

**Stack:** Vite · vanilla JS (no framework) · `sql.js` (SQLite in WASM) · OPFS / IndexedDB · Web Audio / HTMLMediaElement.

**License:** (add when you decide — MIT and Apache-2.0 are the common defaults for solo OSS projects.)
