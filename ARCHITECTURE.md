# QT 월드: architecture

A Korean devotional ("QT", 큐티) multiplayer world in the browser. People walk a low-poly 3D village,
read today's word (오늘의 말씀), meditate (묵상), share meditations as lanterns (등불), chat at the
campfire, pray in voice rooms, write and read testimonies and diaries in the library (이야기 도서관),
exchange letters (✉️ 답장 편지), and listen to worship music (찬양) through the official YouTube player.

- **Client:** `client/`. A single page built with Vite, TypeScript and three.js. There is no framework;
  the DOM is built with `el()`/`button()`.
- **Server:** `server/`. Node with `http`, `ws` and `better-sqlite3`. One process serves `/api` (HTTP JSON),
  `/ws` (the realtime world), the built client and Web Push.
- **Contract:** `shared/protocol.ts`. Wire messages, validation and shared constants, imported by both sides.
- **Live:** https://qt.log2u.me. The Docker container `qt-worlds` (port 5181 inside, `127.0.0.1:5190` on the host)
  runs behind a Cloudflare tunnel (`qt-tunnel`). See `deploy/README.md`.

The measured performance baselines are in `docs/perf/2026-11-13-optimization-audit.md`. Product plans are in
`PLAN.md` and `docs/plans/`, and known issues are in `docs/BACKLOG.md`.

---

## 1. Code map

Line counts are approximate, as of 2026-11-13.

### Client (`client/src`)

| Path | Lines | Purpose |
|---|---|---|
| `main.ts` | 190 | Boot: entry screen → connect → `new Game`. Creates the one `WorshipPlayer` and `AudioEngine`, and sets the `tablet`/`phone-land` body classes. |
| `game/Game.ts` | 1,520 | **Hub.** Renderer and loop (`tick`), the three spaces (world / 골방 / library) and their transitions, HUD prompts, wiring of every view, test hooks (`installTestHooks`) and `publishDebug`. |
| `game/Social.ts` | 400 | Multiplayer glue: `NetClient` ↔ remote avatars, seats, campfire chat, voice. |
| `game/Devotion.ts` | 210 | Today's word, the daily letter, meditation flow, 말씀 책. |
| `game/Shop.ts`, `game/looks.ts`, `game/Photo.ts` | 260 / 90 / 100 | 나눔 소품 가게 client state; appearance helpers; 📸 photos from the WebGL canvas. |
| `net/NetClient.ts` | 520 | The WebSocket client: hello/welcome, reconnects, message dispatch. |
| `net/RemotePlayers.ts` | 360 | Interpolated remote avatars from snapshots. |
| `net/api.ts` | 60 | `api<T>(method, path, body)`: a fetch wrapper (cookies, JSON, errors). |
| `world/*` | ~3,000 | Terrain chunks (`ChunkManager`, `Heightfield`), `DayNight`, `Landmarks`, `Library` interior, `Interior` (골방), `LanternField`, `ShopStall`, `NameTag`, `config.ts` (world layout). |
| `entities/*` | ~1,300 | `Avatar` (meshes and outfit textures), `PlayerController`, `Props`. |
| `systems/*` | ~370 | `Input` (keyboard, touch joystick), `CameraRig`. |
| `ui/WorshipPlayer.ts` | 1,030 | The single YouTube player: API loading, playlist, fold states, dock/room layouts, background pause, and the phone facade (lazy creation). |
| `ui/LibraryView.ts` | 1,490 | Library sheets: bookcases, reader, writer, diary/photos, letters, 받은 편지 inbox, reports. |
| `ui/*View.ts`, `ui/*.ts` | ~5,000 | One file per sheet or widget: `WordBookView`, `MeditationView`, `SettingsView`, `NotifySettings`, `GroupsView`, `ShopView`, `CustomizeView`, `OutfitPainter`, `AdminView`, `ReportView`, `Guide`, `Legal`, `Hud`, `ChatPanel`, `VoicePanel`, `EntryScreen` … |
| `ui/dom.ts` | 100 | `el()`, `button()` and **`Modal`** (every sheet: one open at a time, Esc, focus return, `worlds-modal` event). |
| `voice/VoiceClient.ts` | 540 | WebRTC voice prayer rooms (signalling over `/ws`). |
| `audio/AudioEngine.ts` | 400 | Ambience and settings (volumes, mute). |
| `pwa/pwa.ts`, `client/sw/` | 210 | Service worker registration and update toast; `vite.config.ts` generates `dist/sw.js` with the precache list. |
| `legal/pages.ts`, `config/legal.ts` | 540 | `/privacy` and `/terms` (rendered at build time). |
| `config/worship.ts` | 30 | The worship playlist (YouTube ids and titles). |
| `styles.css` | 6,070 | **All CSS in one file**, appended per milestone (see conventions). |
| `vite-env.d.ts` | 35 | `WorldsDebug` (the `__WORLDS_DEBUG__` shape). |

### Server (`server/src`)

| Path | Lines | Purpose |
|---|---|---|
| `index.ts` | 225 | Wiring: env, DB, services, `Api`, `Room`, static client, the `/health`, `/api`, `/ws` routing, timers (shop 1 s, push 1 min, sweep 1 h). |
| `api.ts` | 960 | **Every HTTP route** (about 90) in one class, with rate limiters, calling services and then `room.*Changed()` fan-out. |
| `Room.ts` | 840 | The realtime world: sockets, join, 12 Hz snapshots, seats (mats, logs, benches, desks), campfire chat, voice signalling, footprint sampling, day change. |
| `http.ts` | 470 | `sendJson`/`readJson`, `HttpError`, `RateLimiter`, request info (trusted proxies), `StaticClient` (gzip and brotli, cache headers), `securityHeaders` (CSP). |
| `db.ts` | 450 | `openDb` (pragmas) and the **append-only `MIGRATIONS` array** (`PRAGMA user_version`). |
| `auth.ts`, `account.ts` | 440 / 350 | Sessions, Google OIDC (plus the mock provider), nicknames, consent; export and 회원 탈퇴. |
| `services.ts` | 630 | WordBook, Group, Lantern and GroupChat services. |
| `library.ts`, `letters.ts`, `diary.ts`, `shots.ts`, `footprints.ts` | 590 / 540 / 160 / 250 / 150 | 이야기 도서관: books, letters, diary drafts, screenshots, 발자취. |
| `shop.ts`, `looks.ts` | 455 / 330 | 나눔 소품 가게 (windows, stock, idempotent rentals); 꾸미기 (appearance, drawn outfits, reports). |
| `push.ts` | 510 | Web Push: subscriptions, preferences, daily/prayer/prop/story/letter/reply/diary kinds. |
| `dailyWord.ts` | 400 | 오늘의 말씀 from the baked Bible text (`data/bible-krv.json`, `data/curated-verses.json`). |
| `rateLimit.ts` | 20 | `TokenBucket` for WebSocket messages. |
| `scripts/backup.mjs` | 170 | Online SQLite backup plus the photo mirror and `--restore-photos`. |
| `test/*.test.mjs` | 250 | `node --test` unit tests against `dist/` (curated verses, trusted proxies, KST day change, static encodings). |

### Shared (`shared/protocol.ts`, 1,030 lines)

Wire types (`ClientMessage`, `ServerMessage`), `parseClientMessage` (server-side validation), world coordinates and
seats (`CAMPFIRE`, `MATS`, `BENCH_SEATS`, `DESK_SEATS`, `LIBRARY_DOOR`, `seatSpot`), KST helpers (`kstDateOf`,
`kstTimeOf`, `kstDayNumber`, `seoulDate`), the shop catalogue and windows, library and letter types, `TERMS_VERSION`,
and the PII detector. The server compiles it into `server/dist/shared/`.

### Other

- `client/scripts/`: browser end-to-end suites (`*-test.mjs`), the smoke test and `lib/harness.mjs`.
- `data/`: Bible text and curated verses, baked into the image.
- `deploy/`: the deploy README, the nginx config and **example** env files only.
- `docs/`: audits (`perf/`), plans, QA notes and screenshots written by the tests.

---

## 2. Layers and data flow

```
client/src  ──HTTP /api (JSON, cookie session)──▶  server/src/api.ts ─▶ services (*.ts) ─▶ db.ts (SQLite)
     │                                                    │
     │                                                    └─ room.*Changed() ─┐
     └──WebSocket /ws (shared/protocol.ts messages)──▶  Room.ts ◀─────────────┘
                                                          │
                     12 Hz snapshot (one JSON frame per space, shared by all) ─▶ every client
push.ts (minute tick) ─▶ Web Push service ─▶ service worker (client/sw/sw.js) ─▶ notification ─▶ ?book=… deep link
```

- **Boot:** `main.ts` → `EntryScreen` (guest nickname, or Google sign-in → nickname + consent) → `NetClient.connect()`
  → `welcome` (id, seed, today's word, seats, shop state …) → `new Game(...)` → `game.start()`.
- **HTTP write:** route in `api.ts` (rate limit, `signedIn`) → service method (validation, SQL) → `d.room.<thing>Changed()`
  pushes the change over `/ws` to the people concerned (for example `lanternAdded`, `libraryChanged`, `letters(userId, unread)`).
- **Realtime:** clients send `state` at most 12 Hz, only when something changed. `Room` validates the message
  (`parseClientMessage`, `TokenBucket`) and broadcasts snapshots at `SNAPSHOT_HZ = 12`. Seats, chat and voice
  signalling are separate messages.
- **Spaces:** world, 골방 (per-player interior) and library (a shared interior). Players in another space are sent
  as hidden.
- **Timers (server):** shop clock 1 s, push scheduler 1 min, sweep 1 h (sessions, old chat, photos), footprint
  sample 20 s, day change checked every tick (cheap arithmetic; it sends the new 오늘의 말씀 at 00:00 KST).
- **Push:** `push.ts` decides due notifications (daily word time, prayer, prop expiry, 공감 batches, letters,
  replies, the diary reminder) per user preferences. `WORLDS_PUSH_MOCK=1` records them instead (tests).
- **Badges:** the 📬 unread-letters count comes from `GET /api/library/letters/unread` on sign-in (one SQL COUNT),
  then live via the `letters` WS message. The full inbox (`/api/library/letters/inbox`) is fetched only when
  받은 편지 opens.

---

## 3. Conventions

- **DOM:** build with `el(tag, class, text)` and `button(label, class, onClick)`. Never use `innerHTML` with data.
- **Sheets:** every overlay is a `Modal` (`ui/dom.ts`). Only one is open at a time; game input pauses while it's
  open. The worship player reacts to `worlds-modal`.
- **KST time:** Korea is a fixed +9 h (no daylight saving). Use `kstDateOf(ms)`, `kstTimeOf(ms)`, `kstDayNumber(ms)`
  and `seoulDate()` from `shared/protocol.ts`. Don't add a new `+ 9 * 3600_000` copy, and don't use `Intl` in hot
  paths (it cost 77 µs per call).
- **Idempotent writes:** retryable writes carry a client `requestId` (letters: `/^[A-Za-z0-9_-]{8,64}$/` with
  `UNIQUE(user_id, request_id)`; shop rentals: UUID with `rental_requests`). A replay returns the first result and
  never counts against rate limits.
- **Anonymous masking:** anonymous lanterns, books (글쓴이) and letters (익명의 성도) show `ANONYMOUS_NAME`/`BOOK_AUTHOR_NAME`
  to everyone except the author (and admins). **No account id ever leaves the server**; the la/lb/m51 suites
  deep-scan responses for leaks.
- **Reports and auto-hide:** looks, books and letters each have a report table. `*_HIDE_REPORTS` distinct reporters
  hide the item until an admin reviews it (`review = 'kept' | 'restored'`).
- **Consent gating:** signed-in users must agree to the current `TERMS_VERSION` (이용약관, 개인정보처리방침,
  만 14세 이상) before anything is written. `/api/me` reports `needsConsent`.
- **YouTube rules (RMF and policy; never relax them):**
  - only the official IFrame embed (youtube-nocookie), unmodified;
  - **one** player/iframe;
  - while a video exists and plays it is fully on screen at ≥ 200×200, with nothing drawn over it;
  - folded (접기) or hidden page → paused, never background playback;
  - phones show a facade (thumbnail and title from `i.ytimg.com`) and load nothing from YouTube until the user
    turns to worship (`WORSHIP_LAZY`);
  - the songs are never downloaded or re-hosted.
- **Test switches:** `?test=1` turns on client test hooks (`window.__WORLDS_TEST__`) **and** the `__WORLDS_DEBUG__`
  mirror. Real players never pay for either. Server: `WORLDS_TEST_MODE`, `WORLDS_AUTH_MOCK`, `WORLDS_ALLOW_TEST_DATES`
  and `WORLDS_PUSH_MOCK`. The server refuses to start with any of them under `NODE_ENV=production`.
- **Migrations:** append a new string to `MIGRATIONS` in `server/src/db.ts`. Never edit an applied one. Use
  `IF NOT EXISTS` for indexes.
- **CSS, the appending problem:** `styles.css` grew one block per milestone, so later blocks win by source order
  and specificity (for example, `#worship { width }` is set in 29 places). When you must touch layout:
  - first find **every** rule for that element (`grep -n '#worship' styles.css`);
  - change the existing rule rather than appending an override;
  - if you add a block, add **one** clearly labelled block, scoped to a new class (as the facade block at the end
    does);
  - don't add new body classes;
  - rerun the layout suites (b1, m42, m53, p13).

  The split into per-feature files with `data-*` state is planned (audit §3, Phase 2).
- **Render cost:** the world renders every frame, except behind 꾸미기 (every 4th frame) and behind a sheet that
  covers the screen (`COVERED_FPS` = 8; every phone sheet and near-full ones elsewhere). Phones cap the pixel ratio
  at 1.25, tablets at 1.5 and desktop at 1.75.
- **Copy:** user-facing text is Korean, warm and short. Code comments are English and explain *why*.

---

## 4. How to add X

| X | Files |
|---|---|
| **Seat type** | `shared/protocol.ts` (`SeatKind`, `SEAT_COUNTS`, the seat spots, `seatSpot`) → `Room.ts` (seat array, `seats(kind)`, join/leave, snapshot) → client `Social.ts` / `world/*` (mesh plus the sit prompt in `Game.updateHud`) → a test like `m54-test.mjs`. Benches touched 10 files (commit b4f1a6a): follow it. |
| **Report target** | migration (`<thing>_reports`, `hidden_at`, `review`) → service `report()` with `*_HIDE_REPORTS` → route in `api.ts` with `storyReportLimit`-style limiter → admin list/review (`AdminView.ts`, admin routes) → `ReportView`/a 🚩 button → the account export and delete paths in `account.ts`. Pattern: `letters.ts`. |
| **Push kind** | migration column(s) in `push_prefs` → `PushPayload.kind` and the prefs column lists in `push.ts` (about 4 places) and `account.ts` (export) → the trigger (service or scheduler) → `NotifySettings.ts` toggle → `client/sw/sw.js` if it needs a special click URL → m6/lb push checks. |
| **Sheet (view)** | `ui/<Name>View.ts` owning a `Modal('<name>-overlay', '<한국어 이름>')` → construct and wire it in `Game.ts` (and the HUD/⚙ entry) → CSS in one labelled block → expose `isOpen`/`describe()` in `publishDebug` if tests need it → run b1/m42/p13 (the worship player must stay clear of it on phones). |
| **WS message** | `shared/protocol.ts`: add it to `ClientMessage` or `ServerMessage` and validate it in `parseClientMessage` → `Room.handle()` `case` → `NetClient` dispatch → `Social`/`Game` handler. Bump `v` only for breaking changes. |
| **API route** | `api.ts`: `r('METHOD', '/api/...', handler, open?)` with `this.signedIn(user)`, a `RateLimiter` for writes and `readJson` → the service → `d.room.*Changed()` if others must see it. Put typed response shapes in `shared/protocol.ts` when the client reads them. |
| **DB migration** | Append to `MIGRATIONS` (`db.ts`). Never edit old entries. Test on a copy of a real-shaped DB: `openDb()` migrates on start, and the container does it on deploy. |
| **Landmark** | `world/config.ts` (position) → `world/Landmarks.ts` (meshes; merge static parts) → `LANDMARKS` for `?at=`. |
| **Test** | Copy a small suite (for example `m54-test.mjs`) and use `lib/harness.mjs` (`startServer`, `freshDb`, `launch`, `loginJoin`, `until`, `debug`). Pick unused ports in 5182–5189 or 5194–5199, never 5180/5181/5190. Wait on `__WORLDS_DEBUG__` predicates, not sleeps. Always load pages with `?test=1`. |

---

## 5. Tests

| Tier | Command | Time on the N100 | When |
|---|---|---|---|
| Server unit | `cd server && npm run build && npm test` | ~2 s | always |
| **Smoke** | `cd client && npm run build && (cd ../server && npm run build) && npm run test:smoke` | **~1 min** (target < 4) | before every commit |
| One suite | `node client/scripts/<suite>-test.mjs` (after building both) | 1–15 min each | when you touch that area |
| Everything | `cd client && npm run test:all` (smoke, then every suite in order, stopping at the first failure) | hours | per milestone or nightly |

The smoke test (`client/scripts/smoke-test.mjs`) starts one server with `SERVE_CLIENT=1`, mock login, push mock and a
throwaway DB on port 5188, then runs a phone and a desktop browser. It checks:

- `/health`, `/api/me`, the CSP header, brotli/gzip encodings;
- sign-up with consent, the world rendering, and the HUD's four buttons;
- the phone pixel ratio, the phone worship facade with no YouTube requests, and the desktop player;
- `/letters/unread` (and that sign-in never fetches the inbox);
- 말씀 → 묵상 → 등불 (seen live by the other player);
- render-on-demand under a phone sheet;
- campfire chat both ways;
- a library bookcase list;
- the ⚙ pages.

Which suite covers what:

| Suite | Area |
|---|---|
| m2 | multiplayer, snapshots, mats, campfire chat, reconnect, day change |
| m3 | 골방, 오늘의 말씀, meditation, word book |
| m31 / m41 / m42 | worship player (dock, room, playlist, fold states) |
| m4 | accounts, groups, lanterns, production mode |
| m5v / m52 / m53 / m54 | voice rooms; tablet chat layout; fold layouts; benches |
| m51 | anonymous lanterns |
| m6 | Web Push, PWA, offline |
| m7 | legal pages, consent, backup, hidden-page pause |
| m8 | 꾸미기, outfit reports, admin |
| m9 | 나눔 소품 가게 |
| m10 | HUD and sheets |
| b1 / p13 | phone and tablet worship layouts with sheets; phone landscape |
| la / lb | library (books, desks, photos, 발자취); letters, inbox, backups |
| smoke | the fast cross-section above |

Harness notes: `freshDb(name)` gives each run its own DB under `server/data/test/`. Tests run SwiftShader WebGL, so
frame rates are meaningless; assert state, not fps. Touch tests stub `https://www.youtube.com/iframe_api` (see
`YT_STUB` in b1/p13/smoke). Screenshots go to `docs/screenshots/`.

---

## 6. Deploy

- **Dev (do not touch from agents):** Vite on **5180** and the Node server on **5181**, run by the owner with nvm
  Node 20. The container uses Node 22 LTS, and the code runs on both. Moving dev to Node 22 means
  `nvm use 22 && (cd server && npm rebuild better-sqlite3)` and restarting the dev servers, so the owner does it.
- **Live:**
  ```bash
  cd /home/hyun/projects/worlds
  docker exec qt-worlds node server/scripts/backup.mjs     # backup first, always
  docker compose build qt-worlds
  docker compose up -d qt-worlds                          # migrations run on start
  docker compose ps; curl -s http://127.0.0.1:5190/health
  ```
  `qt-tunnel` (cloudflared) is never rebuilt for app changes. Details, restore and nginx/Cloudflare notes are in
  `deploy/README.md`.
- **Throwaway checks:** build under another tag (`docker build -t qt-worlds-check .`), run it on `127.0.0.1:5195`
  with a temporary volume, then remove both. Never reuse the names `qt-worlds`/`qt-tunnel` or the volume
  `qt-worlds-data`.

## 7. Secrets

- Never read, print or copy `deploy/.env.live`, `deploy/.env.tunnel`, `deploy/*token*`, `deploy/*key*`,
  `~/.config/qt-worlds/` or any key file. They are gitignored and the repo is **public**.
- Templates: `deploy/.env.live.example` (live container) and `server/.env.example` (local server).
- Tests generate throwaway VAPID keys and use the mock OIDC provider (`WORLDS_AUTH_MOCK=1`). They never need real
  credentials.
