# QT 월드 — code optimization audit (2026-11-13)

Repo `worlds` at **HEAD f48cd87**. Report only: no app code was changed. All measurements were taken on the
production box itself (Intel N100, 4 cores, no GPU), with the dev servers (5180/5181) and the live
container running in the background, so treat absolute CPU numbers as ±30 %. Throwaway scripts lived in a
scratch directory and were deleted afterwards.

**How this was measured**

| What | How |
|---|---|
| Bundle | `vite build --outDir <scratch>` (plus `--sourcemap` for attribution). Bytes were attributed per source module from the sourcemap, and gzip/brotli computed with Node zlib. |
| Live check | `curl` of https://qt.log2u.me: same asset hash `index-C7JYGnFt.js`, served gzip, 263,170 B. |
| Server CPU | `server/dist` (identical to a fresh `tsc` of HEAD) in production mode on :5183 with a throwaway DB. N raw WebSocket bots each sent `state` at 12 Hz while walking circles. CPU came from `/proc/<pid>/stat`; one run used `--cpu-prof`. |
| N+1 timings | Seeded a scratch DB (200 users, 120 lanterns × 15 reactions, 80 stories, 260 letter threads for one user plus 3,000 background letters). The compiled services were called directly. |
| Client | Playwright + SwiftShader (the harness `launch()`), phone profile (390×844, DPR 2, touch) and desktop (1280×720). Readings came from `window.__WORLDS_DEBUG__.renderer` with 12 bots online, plus a CDP CPU profile (6 s at the campfire, phone). |
| SQL | `EXPLAIN QUERY PLAN` against a DB migrated to the current schema. |

---

## 0. Headline numbers

| Metric | Value |
|---|---|
| JS bundle (single chunk) | **932.6 kB raw / 263 kB gzip / 213 kB brotli** (the "680 kB" in the brief is out of date) |
| CSS | 84.5 kB raw / 17.4 kB gzip (source `styles.css`: 6,025 lines, 117 kB, 936 rule blocks) |
| three.js share of the JS | 421 kB raw / 115 kB gzip (**46 %**). Tree-shaking already works: no loaders or animation code is included. The remainder is the WebGLRenderer and its full ShaderLib. |
| App code in the JS | about 490 kB raw (of which `ui/` is 161 kB) |
| First load on a phone, all hosts (6 s after entering) | app origin **286 kB**, but YouTube embed **1.23 MB** plus googlevideo **1.42 MB** (the video starts buffering in the dock), fonts 41 kB, google.com 25 kB |
| Draw calls / triangles (phone, no shadows, 12 remote players) | plaza **173 / 11.8k**, campfire 177 / 11.9k, lantern hill 182 / 13.1k, library **158 / 3.1k** |
| Draw calls / triangles (desktop, shadows on) | plaza 264 / 18.5k, lantern hill 283 / 21.1k, library 228 / 4.8k |
| Draw calls (phone, plaza, 0 remotes) | 111, so each remote avatar adds **about 5 draw calls** |
| Client main thread (phone, SwiftShader) | 89 % idle, so the GPU or fill rate is the bottleneck. `tick()` is 3.5 % of wall time, and `publishDebug()` is about **9 % of tick()** |
| Server CPU (one core = 100 %) | idle 1.7 %; N=10: 5.7 %; N=30: 4.5 %; N=50: **7.5 %**; N=100: 13.7 % (about 0.11 ms of CPU per player per 1/12 s tick). RSS 77 → 89 MB |
| **Snapshot downlink per client** | N=10: 9.2 KB/s; N=30: 27 KB/s; N=50: **45 KB/s (≈ 163 MB/hour per phone)**; N=100: 90 KB/s. This is O(N²) in total egress: 2.3 MB/s for the server at N=50 |
| Snapshot frame size | 785 B at 10 players, 3.85 kB at 50, 7.7 kB at 100 (about 77 B per player, JSON) |
| `seoulDate()` (Intl) | **77 µs per call**, called 12×/s by `checkDayChange`, and as costly as building and sending the snapshots. Arithmetic KST takes 0.7 µs |
| `letters.unreadCount(user)` | **43 ms per call** with 260 threads (522 `db.prepare()` calls). It blocks the event loop, so every client's snapshot is delayed |
| `lanterns.listFor()` per join | 4.2 ms, 122 `prepare()` calls, 19 kB JSON |
| Docker image | 321 MB, of which the base `node:20-bookworm-slim` is about 295 MB. App layers: node_modules 17.1 MB (better-sqlite3 `deps/` sqlite source is 9.6 MB of it), Bible 5.8 MB, client dist 1.3 MB. **Node 20 reached end of life in April 2026.** |

---

## 1. Summary — top findings

| # | Area | Finding | Evidence | Expected gain | Effort | Risk |
|---|---|---|---|---|---|---|
| 1 | Network | Snapshots resend every player at 12 Hz in verbose JSON, including idle, seated and hidden players. Downlink is O(N²). | 45 KB/s per phone at N=50; about 77 B per player; `Room.ts:773-803` | −60 to −85 % mobile data (skip unchanged players, compact arrays, ≤4 Hz for far or hidden players) | M | M (protocol version bump; client interpolation) |
| 2 | Download | The YouTube embed is created right after entering, and the video buffers, even when nobody presses play | 1.23 MB player + 1.42 MB video vs 286 kB for the whole app; `main.ts:36`, `WorshipPlayer.ts:50-70, 823` | −2.6 MB on first entry for phones (use a thumbnail facade and create `YT.Player` on the first tap or unfold) | S–M | M (autoplay/RMF policy rules in the player) |
| 3 | Server | `unreadCount()` rebuilds the whole 받은 편지 inbox (N+1, 522 prepares) after every letter, reply and read, and on every sign-in | 43 ms per call (seeded); `letters.ts:232-271`; `api.ts:687,691,708,736`; `Game.ts:781` | ≥40 ms less event-loop blocking per letter event; one SQL `COUNT` ≈ 0.2 ms | S–M | L |
| 4 | Bundle | No code splitting: library, settings, admin, customize/painter, voice, groups, shop and guide are all in the entry chunk | 132 kB raw / 53 kB gzip of lazy-able app code (measured per module) | −15 % JS on first load (−53 kB gz). Parse/compile on mid-range Android about −60 to −100 ms | M | L–M |
| 5 | Server | `checkDayChange()` calls Intl-based `seoulDate()` 12×/s | 77 µs vs 0.7 µs; in the profile `seoulDate` = 50 % of `broadcastSnapshot` cost; `Room.ts:135-138`, `protocol.ts:681` | removes about 1 ms/s of CPU and half the idle tick cost; 1-line fix (use `kstDateOf(Date.now())`, or check once a minute) | S | L |
| 6 | Render | Draw calls: chunk decor is instanced per chunk per kind (up to 6 calls × 37 chunks), avatars are about 5 calls each, landmarks are about 60 separate meshes, and the library uses 158 calls for 3k triangles | measured above; `ChunkManager.ts:275-310`, `Landmarks.ts:62×this.add`, `Library.ts:49×this.mesh` | −40 to −60 % draw calls on phones (merge static landmark/library geometry per material; one InstancedMesh per decor kind; merged avatar body) | M–L | M |
| 7 | Render | 4 world point lights (7 in the library) are evaluated per fragment all day, even at intensity 0 | `Landmarks.ts:94-100,443`, `Library.ts:218,256,272` | noticeable fragment-cost cut on phones (fixed pool of 1–2 nearest lights, or emissive only on touch) | S–M | M (look) |
| 8 | Render | DPR cap 1.5 on phones and full-rate rendering while a full-screen sheet covers the world | `Game.ts:1183-1184`, `Game.ts:1240-1247` (only 꾸미기 throttles to every 4th frame) | −30 % fill at DPR 1.25; −75 % GPU and battery while sheets are open | S | L |
| 9 | Client | `publishDebug()` builds a large object every 5 frames in production | ≈9 % of `tick()`; `Game.ts:1284-1290, 1377-1448` | gate it behind `?test=1` like `installTestHooks` (`Game.ts:425`); `scripts/screenshots.mjs` must then add `test=1` | S | L |
| 10 | Transfer | The origin serves gzip only; brotli would be 19 % smaller | JS 263 → 213 kB, CSS 17.6 → 15.3 kB; `http.ts:294-360` | −52 kB per cold load (precompress `.br` once at startup, like gzip today) | S | L |
| 11 | SQL | Missing indexes / scans: `lanterns WHERE user_id … created_at` → **SCAN lanterns**; inbox scans every top-level letter via `parent_id IS NULL`; `sessions` sweep is a SCAN; `synchronous` is left at FULL under WAL | EXPLAIN output in §5 | future-proofing; `synchronous=NORMAL` halves fsyncs per write | S | L |
| 12 | Server | `db.prepare()` runs inline on every call (288 sites); reaction counts are N+1 per lantern | prepare+run 3.2 ms vs reused 1.4 ms vs one GROUP BY 1.2 ms for 120 lanterns | about 2× on hot reads; small absolute numbers | S–M | L |
| 13 | CSS | Override wars: `#worship{width}` is defined in **29** blocks, `top` 25, `right` 24, `left` 22; `.sheet{height}` in 17; 26 distinct `#worship…` state selectors × 15 body-class combos; specificity up to (1,8) | §2 | −20 to −30 % CSS lines in the worship and sheet areas; far fewer layout regressions | M | M |
| 14 | Docker | Node 20 is EOL; the image ships the sqlite C sources (9.6 MB); no npm cache mount | §7 | security; −10 MB per layer; faster rebuilds | S | L |
| 15 | Code health | God files: `Game.ts` 1,464 lines, 40 imports, 71 fields; `api.ts` 956 lines, 87 routes in one class; `styles.css` 6,025 lines; KST math copied 26× in 16 files | §6, §8 | agent-safety and change cost (see §8) | M–L | L–M |

---

## 2. Bundle

### 2.1 What is in the 932 kB

Attribution by sourcemap (minified bytes; about 148 kB of glue and whitespace is unattributed):

| Group | Raw | Notes |
|---|---|---|
| `three/build/three.core.js` | 221 kB | math, core, geometries, materials, textures |
| `three/build/three.module.js` | 196 kB | WebGLRenderer + ShaderLib/ShaderChunk (all material programs, including physical, toon, transmission and so on) |
| `three/examples/.../BufferGeometryUtils.js` | 3.7 kB | `mergeGeometries` (`entities/Props.ts:2`) |
| `ui/*` | 161 kB | LibraryView 34.8k, WorshipPlayer 17.8k, SettingsView 10.0k, WordBookView 9.7k, AdminView 9.6k, GroupsView 9.3k, CustomizeView 8.1k, OutfitPainter 6.0k, NotifySettings 5.7k, ShopView 4.7k, Guide 4.5k, Legal 4.3k, … |
| `world/*` | 56 kB | Landmarks 10.3k, Library 9.2k, ChunkManager 5.4k, DayNight 5.3k, ShopStall 4.9k … |
| `game/*` | 50 kB | Game.ts 33.0k, Social 6.6k, Shop 3.9k |
| `entities/*` | 22 kB | Avatar 12.5k, Props 6.7k |
| others | about 50 kB | net 12.8k, voice 8.7k, audio 6.7k, systems 6.3k, shared/protocol 5.6k, pwa 3.6k |

**three.js import surface.** All 23 files use `import * as THREE from 'three'`, and only about 60 distinct
`THREE.*` symbols are used. Rolldown already tree-shakes the namespace: no `AnimationMixer`, `ObjectLoader`,
`FileLoader` or `Skeleton`. The remaining weight is the WebGLRenderer, which statically references every
ShaderLib program (`clearcoat` 158×, `iridescence` 135×, `transmission` 82× in the output). That cannot be
removed without forking three. **Switching to named imports gives no real gain.** The realistic three-side
lever is to keep it in its own long-cached chunk (see 2.2), so app releases don't force phones to
re-download 115 kB gz.

### 2.2 Code-splitting plan (dynamic `import()`)

These are measured from the real minified output, per group (gzip of each group separately):

| Lazy chunk | Modules | Raw | gzip | Trigger |
|---|---|---|---|---|
| `library` | ui/LibraryView, world/Library, world/Letter | 46.6 kB | 16.9 kB | walking to the library door / `?book=` link |
| `settings` | ui/SettingsView, NotifySettings, InstallGuide, ui/Legal | 21.7 kB | 9.2 kB | ⚙ |
| `customize` | ui/CustomizeView, OutfitPainter, AvatarPreview | 16.3 kB | 6.1 kB | 꾸미기 |
| `voice` | voice/VoiceClient, ui/VoicePanel, ui/MicHelp | 15.0 kB | 5.7 kB | joining a voice room (signed-in only) |
| `admin` | ui/AdminView, ui/ReportView | 12.3 kB | 4.7 kB | admin only / 🚩 |
| `groups` | ui/GroupsView | 9.3 kB | 3.8 kB | 모임 |
| `shop` | ui/ShopView, ui/PropIcons | 6.7 kB | 3.4 kB | the shop stall |
| `guide` | ui/Guide | 4.5 kB | 3.0 kB | first visit only |
| **Total** | | **132 kB (−15 %)** | **≈53 kB (−20 % gz)** | |
| optional `wordbook` | WordBookView, MeditationView, LanternCard | 16.3 kB | 6.2 kB | HUD 말씀 (used often, so prefetch) |

In addition, a `manualChunks`/`codeSplitting` rule should put `three` in its own vendor chunk so it stays
cached across releases.

Today all of these are constructed eagerly as fields of `Game` (for example
`private readonly adminView = new AdminView()` and `customize = new CustomizeView(...)` at `Game.ts:143-144`).
The refactor is a small `lazy(() => import('../ui/AdminView'))` holder that is awaited in the existing
`open…()` methods. Vite emits the CSS for those modules alongside the chunk once each feature's CSS moves
into its own file (§2/§8).

**First-load estimate:** about 880 → 750 kB raw JS. Parse and compile on a mid-range Android drops by about
60–100 ms. The service worker still precaches every chunk in the background (`vite.config.ts` lists every
`/assets/*`). Consider leaving the `admin` chunk out of `PRECACHE`.

**Entry screen.** `main.ts` imports `Game` (and therefore three plus the world) before the login card works.
Moving `Game` behind `import()` started at module load (in parallel, via modulepreload) makes the entry card
interactive after about 60 kB instead of about 265 kB gz. This is a perceived-speed win on slow 4G, with no
change to total bytes.

### 2.3 Transfer

- `http.ts:294-360` caches gzip (level 6) once per file; `/assets/*` is `immutable` and HTML is `no-cache`.
  This is good. Adding a brotli variant (quality 11, computed once at startup, about 1 s for the bundle on
  the N100) gives JS 263 → 213 kB and CSS 17.6 → 15.3 kB. Cloudflare passes the origin encoding through
  (the live JS is served `content-encoding: gzip`, `cf-cache-status: MISS`).
- `privacy.html` (38.9 kB) and `terms.html` (18.5 kB) are precached by the SW for every user. They are
  small, but could be runtime-cached on first view instead.

---

## 3. CSS (`client/src/styles.css`)

**Size:** 6,025 lines, 117 kB source (11.8 kB of comments), 84.5 kB minified, 17.4 kB gzip. 936 rule
blocks, 99 section banners, one per milestone appended at the end (M3, M3.1, M4, M4.1, M4.2, M5, M5.1, M5.2,
M5.3, M6, M8, M9, M10, B1, L-A, L-B, P1-3 …).

**Dead selectors:** low. Of 524 classes and 28 ids, only **7 classes** are never referenced from TS/HTML,
even allowing for template prefixes (`worship-caption`, `worship-controls`, `worship-count`, `group-info`,
`shop-chip`, `shop-chip-main`, `shop-chip-sub`; the shop chip was removed in 77cec34). That is 13 fully
dead blocks, about 0.9 kB. Dead code is not the problem; overrides are.

**Override chains (the real cost).** Each count is the number of rule blocks that set the property on that
element:

| Element { property } | Blocks | Lines (first 12) |
|---|---|---|
| `#worship { width }` | 29 | 1403, 1422, 1429, 1442, 1470, 2245, 2279, 2302, 2497, 2507, 2535, 2614 … |
| `#worship { top }` | 25 | 1422 … 3109, 3118 … |
| `#worship { right }` | 24 | |
| `#worship { left }` | 22 | … 4501 |
| `.worship-frame { width }` | 17 | 741 … 4535, 5737 |
| `.sheet { height }` / `{ border-radius }` | 17 / 17 | 1326 … 5861 |
| `#worship { bottom }` | 15 | … 5714, 5723 |
| `#chat-log { max-height }` | 14 | 463 … 5790 |
| `#worship { transform }` | 13 | |

The worship player is styled by **173 rule blocks (19.9 kB)**. It uses 26 distinct `#worship.<state>`
selectors combined with 15+ body classes (`touch` 38×, `touch.tablet` 16×, `phone-land` 16×,
`overlay-open.worship-on` 14×, `phone-land.overlay-open` 13×, `land-typing` 11×, `closet` 8× …).
The highest specificity is `(1,8)`: `body.phone-land.in-world.touch:not(.overlay-open) #worship.dock:not(.mini):not(.folded) .worship-frame`.
Body classes are toggled from 7 different TS files (`main.ts:50,77`, `Hud.ts:54`, `ChatPanel.ts`, `Game.ts`,
`dom.ts`, `VoicePanel.ts`), and `WorshipPlayer.ts:82` derives `phone|tablet|desktop` again independently.
Breakpoints are inconsistent: 15 distinct media queries (999/1000, 760, 700, 600, 520, 480, 420 px, plus
two `max-height` and one orientation query).

**Consolidation plan**

1. **One state attribute for the worship player.** `WorshipPlayer` already computes `effective`, `mode`,
   `size`, `fold` and `device` (see `describe()`). It should write a single
   `data-layout="<device>-<space>-<fold>-<size>[-sheet][-typing]"` (or 3–4 `data-*` attributes) on
   `#worship` and stop relying on body-class combinations. Then rewrite the 173 blocks as one table-like
   file with one block per layout (the brief's portrait / tablet / landscape / room / sheet states). The
   expected result is about 60–80 blocks, every selector at specificity (1,1), and no `:not()` chains.
2. **Split by feature:** `styles/base.css` (tokens, reset, cards, buttons), `hud.css`, `sheet.css`
   (one `.sheet` with size modifiers instead of 17 height overrides), `chat.css`, `worship.css`, and
   `features/{library,shop,customize,admin,groups,settings,voice,pwa}.css`, each imported by its TS
   module. The library section alone (lines 4568–5700, 22.5 kB) and customize/admin (≈3463–3888) then ship
   with their lazy chunks: about −30 kB raw / −6 kB gz from the first-load CSS.
3. **Named breakpoints** (`--bp-phone 600px`, `--bp-tablet 1000px`) via `@custom-media`, or a small
   PostCSS step. Fold the 999/1000 and 480/520 variants together.
4. **Move the P1-3 phone-landscape block** (lines 5685–6025, 10.4 kB, written last and winning by source
   order) into the per-feature files under `@media (orientation: landscape) and (max-height: 500px)`,
   instead of `body.phone-land` overrides.
5. Delete the 7 dead classes.
6. Add a visual-regression guard first: the b1/m42/m53/p13 suites already shoot the worship states.
   Freeze those PNGs as baselines before the rewrite.

**Estimated savings:** −20 to −30 % of CSS lines (mostly worship, sheet and chat overrides), −6 kB gz on
first load via lazy feature CSS, and much lower regression risk per layout change.

---

## 4. Rendering (client runtime)

### 4.1 Measurements (SwiftShader, 12 remote bots online)

| Scene | Phone calls / tris | Desktop calls / tris |
|---|---|---|
| Plaza | 173 / 11,794 | 264 / 18,538 |
| Campfire | 177 / 11,855 | 264 / 18,538 |
| Lantern hill | 182 / 13,055 | 283 / 21,131 |
| Library (interior) | 158 / 3,050 | 228 / 4,750 |
| Plaza, 0 remotes | 111 / 9,731 | — |

SwiftShader frame rates (2–7 fps) are meaningless for phones; the CPU profile is the useful part. The main
thread was **89 % idle**, so the GPU or rasteriser is the limit, which matches mid-range Android behaviour.
Triangle counts are tiny. Phones are bound by draw calls (driver overhead) and fragment cost: DPR, point
lights, fill. Desktop shadows add about 90 calls (the shadow pass).

### 4.2 Draw-call reduction (instancing / merging)

- **Chunk decor** (`ChunkManager.ts:275-310`): each chunk creates its own InstancedMesh for trunks,
  pine tops, round tops, rocks and bushes. With `VIEW_RADIUS = 3` (`world/config.ts:15`) there are 37–49
  chunks, so up to about 6 × 37 calls before culling. Options:
  1. one global InstancedMesh per decor kind, with slot ranges per chunk (5 calls total);
  2. on touch devices, `VIEW_RADIUS = 2` (21 chunks) with the fog pulled in.
- **Landmarks** (`Landmarks.ts`, 62 `this.add(...)` calls; materials are already cached per colour by
  `lambert()`): the static meshes are never moved. Merge them per material at build time with
  `mergeGeometries` (already in the bundle), keeping only animated parts (candles, glows, flame) separate.
  Likely −40 to −50 calls. The same applies to `ShopStall.ts` (36 mesh helpers).
- **Library** (`Library.ts`, 49 `this.mesh(...)`, 36 `lam()` materials; books are already instanced at
  `Library.ts:191`): 158 calls for 3k triangles. Merge static furniture per material and share materials
  per colour (like `Landmarks.matCache`). Expected 158 → about 40.
- **Avatars** (`Avatar.ts`, 10 mesh constructors, about 5 draw calls each in practice): merge the static
  body parts (robe, head, hair) into one geometry with vertex colours, keeping the outfit-texture part and
  props separate. 50 players × 5 = 250 calls → about 100. Name tags are individual sprites with their own
  canvas texture (`NameTag.ts`); acceptable at ≤50 players.
- **Lantern hill**: already instanced (`LanternField.ts:61-72`). Fine.
- **Footprint trail** (`Props.ts:292`): already a single InstancedMesh. Fine.

### 4.3 Fragment cost

- **Point lights:** 4 in the world (`Landmarks.ts:151` plaza, `:281` campfire, `:311`, `:423` library
  door) are always in the scene. During the day only their intensity is set to 0 (`Landmarks.ts:443`).
  three.js still compiles and evaluates every point light per fragment for every Lambert material. The
  library adds 7 (2 reading tables `:218`, writing desk `:256`, 5 pendants `:272`, …).
  - Fix: on touch devices keep a **fixed pool of 1–2 PointLights** and move them to the nearest night
    sources. The count stays constant, so there are no shader recompiles. Use emissive glow meshes for the
    rest; the scene already has them.
  - Alternative: set `light.visible = false` while intensity ≈ 0, accepting one recompile at dusk and
    dawn; `renderer.compile()` it ahead of time.
- **Pixel ratio:** `Game.ts:1183-1184` caps touch devices at 1.5 and desktop at 1.75. A 1080p phone is
  then 585×1266 ≈ 0.74 MP per frame. Recommendation: start at 1.25 on touch and add a simple adaptive loop
  (if the median frame time stays above 20 ms for 2 s, step DPR down by 0.125 to a floor of 1.0; step it
  back up when there is headroom). At 1.25 the fill is −30 %.
- **Shadows** are already off on touch devices (`Game.ts:164`). Good. Antialiasing is off on touch. Good.

### 4.4 Render on demand

`Game.ts:1240-1247` only throttles to every 4th frame while 꾸미기 is open. On phones, the book, library,
settings, groups, shop and letters sheets cover most or all of the canvas, yet the world renders at
60 fps behind them. Extend the same rule: when `Modal.anyOpen` and the sheet covers ≥80 % of the viewport
(phone portrait, phone-land sheet-left), render every 4th frame, or render once and stop until the sheet
closes. The worship iframe keeps playing. Expect −75 % GPU and battery while reading, which is a large
share of session time for a QT/devotion app.

### 4.5 Per-frame JS

- `publishDebug()` (`Game.ts:1284-1290, 1377-1448`) runs in production every 5 frames. It builds an object
  of about 60 fields, calls ~15 `describe()` methods, runs two `remotes.describe().filter(...)` passes and
  allocates arrays (`shop.rentals.map`). In the CPU profile it is **≈9 % of `tick()`**. Gate it like
  `installTestHooks` (`Game.ts:425`, `?test=1`). Every e2e suite already passes `test=1`;
  only `scripts/screenshots.mjs` doesn't and would need it.
- `tagView()` (`Game.ts:464-470`) allocates an object and a closure per call and reads
  `canvas.clientHeight` (a forced layout read) every frame. Cache `viewportHeight` in `resize()` and reuse
  one TagView object.
- Allocations inside per-frame methods are few: `Devotion.ts:96` (`new Vector3` in `update`) and
  `Interior.ts:129` (two `new Vector3` per frame in the 골방). Hoist both to module-level temporaries.
- HUD DOM writes are already diffed (`Hud.ts:46-75, 189-200`: setters early-return when nothing changed).
  The joystick writes `style.transform` only while dragging. Good.
- Chunk building uses a budget of 2 chunks per frame (`ChunkManager.ts:87,116`) on the main thread. On
  phones, consider budget 1 or `requestIdleCallback`, since a 16×16 chunk with decor scatter can cost
  several ms on an A55 core.
- Extra WebGL contexts: `PropIcons.ts` and `AvatarPreview.ts` both `dispose()` and `forceContextLoss()`.
  Good.

---

## 5. Network

### 5.1 Snapshots (biggest network item)

`Room.broadcastSnapshot()` (`Room.ts:773-803`) builds one JSON frame per space (cached per space; this is
good, not per viewer) and sends it to everybody at `SNAPSHOT_HZ = 12` (`protocol.ts:19`):

- **every** joined player is in every frame, including seated and idle players, and players in other
  spaces, who are sent as `{x:0,y:0,z:0,…,inside:true}` 12 times a second;
- about 77 B per player: `{"id":"Ab3_x9Qz","x":12.34,"y":0.5,"z":-3.21,"yaw":1.23,"speed":3,"seat":-1}`;
- no permessage-deflate (`index.ts:143`). On the N100, per-socket deflate of a shared frame would cost N
  compressions, so it is better not to enable it.

| Change | Est. saving | Notes |
|---|---|---|
| a) Only players whose state changed since the last frame (send a full keyframe every 2 s) | −50 to −80 % in typical sessions (people sit, read, idle) | the client keeps the last state; needs `seq` handling |
| b) Hidden players (other space) sent once per change, not 12×/s | −10 to −30 % when people are in the library or 골방 | |
| c) Compact array encoding `["id",x100,y100,z100,yaw100,speed10,seat]` | about −50 % per player (≈36 B) | still JSON; protocol `v` bump |
| d) Interest management: players beyond about 60 m at 3 Hz | −30 % at full world spread | the client already interpolates |
| e) Pause snapshots to a client whose tab is hidden (the client sends `visibility`) | battery and data | |

Together these give about −70 to −85 % downlink. At N=50 that is 45 → about 8 KB/s per phone.

Client uplink is already good: `Social.ts:350-363` sends at most 12 Hz and only when something changed,
with a 1 s keep-alive.

### 5.2 Other messages and pulls

- `welcome` is 1.0 kB. Join also sends the `lanterns` list (19 kB JSON with 120 lanterns; built with N+1,
  see §6) and `shop`. That is fine.
- **Unread letters on sign-in:** `Game.ts:781` (`refreshLetters`) downloads the full inbox (up to 100
  items, about 22 kB, 43 ms on the server) just to read `unread`. Add `GET /api/library/letters/unread`, or
  put `lettersUnread` in `welcome`.
- `membershipChanged` (`Room.ts`) resends the full lantern list and library counts. Acceptable because it
  is rare.
- Client polling is minimal (only the PWA update check every 30 min, `pwa.ts:115`, and a 30 s solo retry).
  Lists are fetched on open. Fine.

### 5.3 Caching and the service worker

- Hashed assets: `immutable`, 1 year. HTML and sw.js: `no-cache`. Other public files: 1 h. Correct.
- Precache: 13 entries, about 1.2 MB raw (index, JS, CSS, privacy, terms, manifest and icons). After code
  splitting, precache the lazy chunks but leave out `admin` (and arguably the legal pages).
- **YouTube** (finding #2) is the dominant first-session download: 1.23 MB of player JS/CSS from
  youtube-nocookie plus 1.42 MB of video within 6 s, against 286 kB for the whole app. `main.ts:36`
  constructs the player at boot; `preloadYouTubeApi()` (`WorshipPlayer.ts:50-70`) loads the API on the
  entry screen; `new YT.Player` (`:823`) is created as soon as the dock is shown. Recommendations:
  - on phones, show a static thumbnail facade (`i.ytimg.com/vi/<id>/mqdefault.jpg`, about 10 kB) with a
    ▶ button, and create the iframe on the first tap or unfold;
  - keep `preloadYouTubeApi()` but drop the iframe preload;
  - if autoplay-after-entry is a product requirement, at least defer it until `hud.ready()` plus
    `requestIdleCallback`, so the world and the player don't compete for the first 3 seconds.

---

## 6. Server

### 6.1 CPU baseline (production mode, raw WebSocket bots walking at 12 Hz)

| Players | CPU (% of one core) | CPU per 1/12 s tick | RSS | Downlink per client |
|---|---|---|---|---|
| 0 | 1.7 % | — | 77 MB | — |
| 10 | 5.7 % | 4.8 ms (includes warm-up) | 79 MB | 9.2 KB/s |
| 30 | 4.5 % | 3.8 ms | 83 MB | 27 KB/s |
| 50 | 7.5 % | 6.3 ms | 83 MB | 45 KB/s |
| 100 | 13.7 % | 11.4 ms | 89 MB | 90 KB/s |

The CPU profile at N=50 (30 s) breaks down as follows:

- `writev` (kernel socket writes) is the largest self cost;
- `broadcastSnapshot` is 1.2 % inclusive;
- `seoulDate` is 0.6 %, half of the snapshot cost, entirely from `checkDayChange()` running 12×/s
  (`Room.ts:135-138`, `protocol.ts:681`, which creates a new `Intl.DateTimeFormat` on every call);
- `parseClientMessage` is 0.2 %.

**The server is not CPU-bound up to 100 players.** Bandwidth (§5) and event-loop stalls from synchronous
SQL (6.2) are the real risks on a shared N100.

Quick wins:

- `checkDayChange()`: call it once a minute, or compare `Date.now()` against a precomputed `nextMidnightKst`.
- Cache one `Intl.DateTimeFormat` at module level if Intl is kept.
- The shop tick every second (`index.ts:201`, `shop.ts:318-335`) runs 2 indexed queries
  (`rentals_active_ends`), so it is cheap. It does re-`prepare` both statements every second; hoist them.
- The footprint sample (every 20 s, `Room.ts:139,148-161`) does up to 5 upserts per signed-in player, plus
  an `enabled()` SELECT per call (`footprints.ts:44,84-91`). Wrap the sweep in one transaction and cache
  `enabled` per user for the sample. That is fine up to 50 players either way.

### 6.2 N+1 and synchronous SQL (seeded DB timings)

| Path | Cost | Why | Fix |
|---|---|---|---|
| `LetterService.unreadCount(u)` = `inbox(u).unread` (`letters.ts:232-271`) | **43 ms**, 522 prepares (260 threads) | for each of up to 300 letters: `library.book()` (a full visibility query), replies query, `readPointer()` (×2: in `thread()` and `unreadIn`) | one SQL: `SELECT COUNT(*) FROM story_letters l JOIN … LEFT JOIN letter_reads r … WHERE party(viewer) AND l.id > COALESCE(r.read_id,0) AND l.user_id<>viewer AND deleted/hidden IS NULL`, plus the index in 6.3 |
| …called from | `api.ts:687` (each new letter, for the recipient), `:691` (loop over userIds), `:708` (after reading a book's letters), `:736`, plus `markRead` (`letters.ts:274-282`) calls `inbox()` **twice** and then `unreadCount()` (≈130 ms) | | |
| `LanternService.listFor()` (`services.ts:368-374`) on every join and membership change | 4.2 ms, 122 prepares | `info()` → `counts(id)` per lantern (`services.ts:342-348`) | one `GROUP BY lantern_id, type` over active lanterns (1.2 ms), or keep counts in memory (only 120 lanterns) |
| Library shelf `SELECT` (`library.ts:72-84`) | 5 correlated subqueries per row | readers, photos, 3× reaction type counts | fine at current size (all indexed: see EXPLAIN). Later: merge the 3 reaction subqueries into one `SUM(CASE…)` join |
| Inline `db.prepare()` everywhere | 288 call sites (services 51, library 48, looks 30, shop 32, letters 28, account 26, push 25 …) | better-sqlite3 does not cache statements | a tiny `stmt(sql)` memo (a `Map<string, Statement>` per DB) gives about 2× on hot reads with no logic change |

### 6.3 Indexes (`EXPLAIN QUERY PLAN`)

| Query | Plan | Action |
|---|---|---|
| `SELECT COUNT(*) FROM lanterns WHERE user_id=? AND created_at>=?` (`services.ts:425`, daily limit) | **SCAN lanterns** | `CREATE INDEX lanterns_user ON lanterns(user_id, created_at)` |
| Inbox: `… WHERE l.parent_id IS NULL AND ((s.user_id=@v …) OR (l.user_id=@v …))` | `SEARCH l USING INDEX story_letters_parent (parent_id=?)`, which walks **every** top-level letter of every user | rewrite as `UNION ALL` of (my stories → `story_letters_story`) and (my letters → `story_letters_user`) |
| `sessions` hourly sweep (`expires_at < ?`) | **SCAN sessions** | `CREATE INDEX sessions_expires ON sessions(expires_at)` |
| push daily due (`push_prefs p WHERE daily=1 AND daily_time …`), every minute | SCAN push_prefs + correlated EXISTS | fine below about 10k users; later a partial index `WHERE daily=1` |
| lantern list, reaction counts, rentals due/expire, group-message purge, footprint sweep, story push | indexed | — |

**Pragmas** (`db.ts:428-432`): WAL, foreign keys, busy_timeout and `secure_delete=ON` (keep it, privacy).
Add `synchronous = NORMAL`, which is crash-safe under WAL and avoids an fsync per commit, and
`temp_store = MEMORY`. Optionally add an hourly `wal_checkpoint(TRUNCATE)` in `sweep()`.

### 6.4 Memory

- RSS is 77 MB idle and 89 MB at 100 players. The Bible JSON (5.8 MB) is parsed once at startup
  (`dailyWord.ts:202`). Fine.
- `RateLimiter` (`http.ts:245-275`) sweeps finished windows every window and at 10k keys. Bounded.
  18 instances in `api.ts:151-168`.
- `TokenBucket` lives per client and is freed with the client. `connectionsPerIp` is decremented on close
  (`index.ts:144-165`). `Room.voiceBlocks`, `push.prayerSeen` and `push.mockStatus` are maps without a
  visible TTL: check that `prayerSeen` is pruned. It is keyed per lantern and day, so it grows slowly.
- **No leaks were observed** over the load runs.

---

## 7. Docker image and build

The Dockerfile is already a good two-stage build: `npm ci` per package before the sources are copied, then
`npm prune --omit=dev`, and dev dependencies do **not** leak into the runtime. Measured from `docker history`:

| Layer | Size |
|---|---|
| base `node:20-bookworm-slim` | about 295 MB |
| server/node_modules | 17.1 MB (better-sqlite3 12 MB, of which `deps/` sqlite amalgamation 9.6 MB and `src/` 0.2 MB are build-only) |
| data (Bible + curated) | 5.8 MB |
| client/dist | 1.3 MB |
| server/dist | 0.4 MB |

Quick wins:

1. **Move to `node:22-bookworm-slim` (or 24)**: Node 20 has been EOL since 2026-04-30. better-sqlite3 11
   has prebuilds for both.
2. `RUN rm -rf server/node_modules/better-sqlite3/{deps,src}` after the prune: −9.8 MB.
3. BuildKit cache mounts: `RUN --mount=type=cache,target=/root/.npm npm ci`. Rebuilds then skip
   downloads, which matters on the N100.
4. The build stage installs the full client toolchain, including `@playwright/test` (browsers are skipped
   by env, good). Consider moving Playwright to a separate `client/scripts/package.json`, or using
   `npm ci --omit=optional`. That is a minor build-time saving.
5. Optional: `node:22-alpine` brings the image to about 160–180 MB (better-sqlite3 has musl prebuilds).
   Test the `HEALTHCHECK` `fetch` and the `web-push` crypto first.
6. Copy order is already optimal: package files → `npm ci` → sources.

---

## 8. Modularity, abstraction and AI-friendliness

### 8.1 Scores

| Dimension | Score | One-line justification |
|---|---|---|
| Module boundaries | **2 / 5** | Folders exist (world, entities, ui, net, game, voice), but `Game.ts` (1,464 lines, 40 imports, 71 fields, 43 methods) and `api.ts` (87 routes in one class) are god objects, and `styles.css` is a 6k-line append log. |
| Abstraction reuse | **3 / 5** | `Modal`, `el/button`, `TokenBucket`/`RateLimiter` and `seatSpot` are shared. KST dates, report/auto-hide, anonymous masking, push prefs, `excerptOf` and the seat tables are copied. |
| Shared contracts | **4 / 5** | `shared/protocol.ts` is the real single source for messages, validation (`parseClientMessage`) and constants, used by both sides. But it is 1,035 lines mixing wire types, world coordinates, the shop catalogue, KST maths and PII detection. |
| State management | **2 / 5** | Client state is spread across 71 `Game` fields, statics (`Modal.current`, `Avatar.liveTextures`, `outfitCache`), module globals (`pwa.ts`), body classes toggled from 7 files and 12 callback bags. There is no store or event bus; there are 2 custom DOM events. |
| AI-readability | **3 / 5** | Excellent "why" comments and consistent naming, with Korean UI terms glossed in English. Against that: 4 TS files above 950 lines, a 6k-line CSS file, no ARCHITECTURE.md or code map, and no CLAUDE.md/AGENTS.md. |
| Test reuse | **3 / 5** | All 21 e2e suites import `scripts/lib/harness.mjs`, but helpers are re-copied (`box`/`overlaps` 6×, `sleep`/`start`/`stop`/`waitHttp` re-implemented in 3 older suites, `seoulToday`/`kst` 3×+3×). About 230 s of fixed sleeps. No smoke tier or `npm test` entry. Only 2 server unit tests (126 lines), so services are tested only through browsers. |

### 8.2 Module boundaries

**God files** (lines / concerns mixed / imports out / imported by):

| File | Lines | Concerns | Fan-out | Fan-in |
|---|---|---|---|---|
| `client/src/styles.css` | 6,025 | every feature, 99 milestone sections, 15 breakpoints | — | 1 |
| `client/src/game/Game.ts` | 1,464 | renderer and loop, input, camera, 3 spaces (world/골방/library) and their transitions, the HUD action/prompt state machine, the 17 `Modal`-based views wired, shop, voice, letters badge, deep links, onboarding, test hooks (~90 lines), debug publishing (~70 lines) | **40** | 1 |
| `client/src/ui/LibraryView.ts` | 1,486 | shelves, the book reader, writer, diary/photos, letters, inbox, reports | 9 | 1 |
| `shared/protocol.ts` | 1,035 | wire messages, validation, world coordinates and seats, lantern hill, appearance, dates, shop catalogue and windows, library books and letters, PII detection | 0 | **50** |
| `client/src/ui/WorshipPlayer.ts` | 966 | YouTube API loading, playlist, fold/size/mode state machine, dock/room layout, background pause, volume | 3 | 3 |
| `server/src/api.ts` | 956 | 87 routes in one class across 13 domains, 18 rate limiters, Room notifications | 13 | 2 |
| `server/src/Room.ts` | 832 | sockets and join, snapshots, 4 seat tables, campfire chat, voice signalling and blocks, footprints sampling, lanterns/shop/library/looks fan-out, day change | 10 | 1 |
| `server/src/services.ts` | 631 | 4 unrelated services: WordBook, Group, Lantern, GroupChat | 4 | many |

**Layering.**

- Client edges:
  - `game → ui` (24 imports) and `game → world` (11) are the expected direction.
  - Violations:
    - `net → game` and `net → entities`: `RemotePlayers.ts:3-4` imports `Avatar` and `game/looks`.
      `RemotePlayers` is really an entity manager that lives in `net/`.
    - `entities → game`: `PlayerController.ts:5` imports types.
    - `ui → game`: `CustomizeView.ts:12`, `ReportView.ts:2` and `ShopView.ts:2` reach into
      `game/looks` and `game/Shop`.
    - `ui → net`: 13 imports. The UI calls `api()` directly, which is acceptable but means views own
      data fetching.
- Server is `index → api → services → db`, mostly respected. Exceptions:
  - `Room.ts:33` imports the `RoomEvents` type from `api.ts`, so the realtime layer depends on the HTTP
    layer;
  - every service imports `HttpError` from `http.ts`, so the domain depends on the transport;
  - `library.ts` imports `services`, `footprints`, `shots`, `diary` and `dailyWord`, making it a second hub.

### 8.3 Abstractions: status per recurring pattern

| Pattern | Status | Evidence |
|---|---|---|
| Sheets / modals (open, close, Esc, focus) | **Abstracted** | `ui/dom.ts:33-104` `Modal`, used by 17 views. Back navigation is not: 6 files implement their own back stacks (`CustomizeView`, `GroupsView`, `LibraryView`, `SettingsView`, `WordBookView`, `Game`). Worship docking against sheets is done by CSS body classes (`overlay-open.worship-on`, 14 selectors) rather than an API. |
| Seats (mats, logs, benches, desks) | **Partial** | Shared: `SeatKind`, `SEAT_COUNTS`, `seatSpot()` (`protocol.ts:105,246-251`). Duplicated: 4 arrays and 4 message types in `Room.ts:121-127, 741-746` and again in `Social.ts`. Adding benches touched **10 source files** (b4f1a6a). |
| Reports with auto-hide and admin review | **Duplicated ×3** | `looks.ts:213-225` (`OUTFIT_HIDE_REPORTS`), `library.ts:509-513` (`STORY_HIDE_REPORTS`), `letters.ts:~410-420` (reuses `STORY_HIDE_REPORTS`). Three report tables, three reason lists (`REPORT_REASONS`, `STORY_REPORT_REASONS`, letters reuse the story list), three admin review paths. |
| Anonymous masking | **Partial** | `ANONYMOUS_NAME` is shared (`protocol.ts:360`), but the rule `anonymous && !mine (&& !admin)` is written separately in `services.ts:357`, `services.ts:474`, `library.ts:172` and `letters.ts:103`. |
| Idempotent requestId writes | **Duplicated ×2, different formats** | Shop: UUID v4 with a `rental_requests` table that stores the outcome (`shop.ts:175-191`). Letters: `/^[A-Za-z0-9_-]{8,64}$/` with `UNIQUE(user_id, request_id)` (`letters.ts:64,303`). |
| Rate limiters | **Abstracted** | `rateLimit.ts` `TokenBucket` (WebSocket), `http.ts:245` `RateLimiter` (HTTP; 18 instances in `api.ts:151-168`). Only the env-override pattern repeats. |
| Push kinds and prefs | **Duplicated** | Kinds union in `push.ts:43`. The prefs column list is repeated in `push.ts:236`, `push.ts:281` and `account.ts:133`, plus single-column reads in `shop.ts:301` and `push.ts:363,465`. A new kind means a migration, 4–5 SQL edits, `NotifySettings.ts`, export and protocol. |
| KST date/time helpers | **Duplicated ×26 in 16 files** | Shared: `seoulDate` (Intl, slow), `kstDateOf`, `kstTimeOf`, `KST_MS` (`protocol.ts:681-790`). Re-derived as `+ 9 * 3600_000` in `looks.ts:58`, `api.ts:283`, `shop.ts:343,381`, `library.ts:293`, `push.ts:99`, `footprints.ts:5,26`, `CustomizeView.ts:49`, `LibraryView.ts:123`, `Photo.ts:32`, `AdminView.ts:23`; Intl `toLocaleString` in `GroupsView.ts:31-32` and `WordBookView.ts:282`; plus 10 copies in the e2e scripts. |
| Footprint events | **Mostly centralised** | `FootprintService.event/minute` (`footprints.ts:70-91`) is called from `Room.ts` (7 sites) and `library.ts` (2). The event-type list is implicit (string literals), not an enum in protocol. |
| Text excerpts | **Duplicated** | `excerptOf` in `library.ts:86` (80 chars) and `letters.ts:65` (60 chars). |

### 8.4 Shared contracts

`shared/protocol.ts` is coherent as a contract. `ClientMessage` and `ServerMessage` are discriminated
unions, `parseClientMessage` validates on the server, and client and server import the same types, so no
types are re-declared.

It is drifting into a dumping ground:

- 136 exported consts/functions and 47 types;
- 9 sections, of which only "messages" and "validation" are protocol;
- the shop catalogue (`PROPS`), world geometry (`LIBRARY_DOOR` computed from `PLAZA`), KST maths and the
  Korean PII detector (`personalInfoKinds`) all live here.

HTTP request and response shapes are partly here (for example `InboxItem` and `LettersOfBook`) and partly
inline generics at call sites (`api<{ unread: number; items: InboxItem[] }>` in `LibraryView.ts:626,975`
and `Game.ts:781`).

Recommendation: split it into `shared/` modules and keep `protocol.ts` as a barrel re-export, so no
import changes are needed. Add an `ApiRoutes` type map (path → request/response) used by `net/api.ts`
and the server router.

### 8.5 State management (client)

- **Session and world state:** `Game` fields (71), such as `account`, `isAdmin`, `localLook`, `inLibrary`,
  `inCloset`, `transitioning`, `nearLantern`, `nearShop`, `nearSpot` and `lettersUnread`.
- **Cross-cutting UI state:** `document.body` classes set from 7 files (`touch`, `tablet`, `phone-land`,
  `in-world`, `overlay-open`, `worship-on`, `worship-mini`, `closet`, `chatting`, `land-typing`, `voice-on`).
  CSS reads them as a hidden state machine.
- **Statics and globals:** `Modal.current`, `Avatar.liveTextures/liveProps`, `outfitCache`, the
  `pwa.ts` module lets, `PropIcons` cache.
- **Communication:** constructor option bags of callbacks (`Social` takes 16 options; `Game` passes about
  12 `on…` handlers), 2 custom window events (`worlds-modal`, `worlds-notification-click`), and direct
  method calls into views.
- **Debug mirror:** `__WORLDS_DEBUG__` effectively mirrors all of this state for the tests.

That is workable, but every new feature threads 2–4 new callbacks through `Game`. A tiny typed event bus
(`bus.emit('letters:unread', n)`) plus a `UiState` object that owns body classes (one place computes
`data-*` on `<body>`) would remove most of the threading.

### 8.6 AI-friendliness specifics

- **File size versus a single read:** files above about 800 lines are
  - `styles.css` 6,025;
  - `LibraryView.ts` 1,486;
  - `Game.ts` 1,464;
  - `protocol.ts` 1,035;
  - `WorshipPlayer.ts` 966;
  - `api.ts` 956;
  - `Room.ts` 832;
  - e2e `la-test.mjs` 1,055 and `lb-test.mjs` 853.

  The most-churned files are exactly these: `styles.css` touched in 16 of 23 commits, `Game.ts` 14,
  `protocol.ts` 11, `Room.ts` 10, `db.ts` 10, `NetClient.ts` 10, `api.ts` 9.
- **Discoverability:** folder names are good. `PLAN.md` (107 lines) and `docs/BACKLOG.md` (50) are
  product docs. There is no "where X lives" map, and no conventions doc (DOM via `el()` and never
  `innerHTML`, `requestId` rules, KST rules, test-mode gates, migrations appended to `db.ts`).
- **Comments:** high quality. They explain *why* (for example `Game.ts:1182` "Pixel ratio is a fill-rate
  budget", `Room.ts:769-772` space rules, `db.ts:24` migrations). This is a real strength for agents.
- **Change footprint per feature** (source files under `client/src`, `server/src` and `shared`, from
  `git log --stat`):

  | Commit | Feature | Source files |
  |---|---|---|
  | b4f1a6a | new seat type (benches) | 10 (+1 test) |
  | 65d4a39 | shop | 25 |
  | 18035d4 | looks / report target | 26 |
  | 956811c | library L-A | 32 |
  | 76d0b0f | letters L-B (new push kinds, new report target) | 21 |
  | f48cd87 | phone-landscape layout | 16 |
  | fe20854 | HUD simplification | 13 |

  Almost every feature edits `Game.ts`, `styles.css`, `protocol.ts`, and on the server `api.ts`,
  `Room.ts` and `db.ts`, so parallel agents conflict on the same 6 files.
- **Dead code:** low. `tsc` with `noUnusedLocals` passes on both sides. Only 2 exports are never used
  (`VoiceClient.ts:39 micPermission`, `auth.ts:119 accountOf`), and 120 exports are used only inside their
  own file (harmless noise).
- **CSS safety:** low (see §3). A worship or sheet change must reason about up to 29 competing blocks.

### 8.7 Target structure (incremental, one agent step at a time)

Proposed target layout:

```
client/src/
  app/            main.ts (boot), session.ts, lazy.ts (dynamic-import holder)
  core/           loop.ts (render/update, render-on-demand), debug.ts (publishDebug + test hooks, ?test=1 only),
                  bus.ts (typed events), uiState.ts (body/data-* classes in one place)
  game/           Game.ts (composition only, < 400 lines), spaces.ts (world/closet/library transitions),
                  interactions.ts (near-X, action button, prompts = today's updateHud/updateLibraryHud)
  world/ entities/ net/ audio/ systems/  (as today; move RemotePlayers to entities/)
  ui/kit/         dom.ts, Modal.ts, SheetStack.ts (back navigation), tabs.ts
  features/<name>/   index.ts (lazy entry), View.ts, client.ts (API calls), styles.css
                  library, letters, shop, customize, admin, groups, settings, notify, voice, wordbook, worship, guide, legal
  styles/         base.css, hud.css, sheet.css, chat.css, breakpoints.css
server/src/
  http/           http.ts, router.ts (route table type), errors.ts (HttpError, so domain stops importing http)
  routes/         me.ts auth.ts groups.ts lanterns.ts library.ts letters.ts shop.ts admin.ts push.ts footprints.ts shots.ts
  domain/         wordbook.ts groups.ts lanterns.ts groupChat.ts (split services.ts), library.ts letters.ts shop.ts looks.ts …
  realtime/       Room.ts (sockets + join), snapshot.ts, seats.ts (SeatTable<kind>), voice.ts, presence.ts (footprint sampling)
  lib/            kst.ts, text.ts (excerpt), reports.ts (report + auto-hide + review), anonymity.ts, idempotency.ts, stmt.ts (prepared-statement cache)
  db/             db.ts (open/pragmas), migrations.ts
shared/
  protocol.ts (barrel, unchanged import path), messages.ts, validate.ts, world.ts (coords, seats), time.ts (KST),
  shop.ts, library.ts, appearance.ts, api.ts (route → request/response types)
```

Steps, each one PR, with tests green between them:

| # | Step | Effort | Risk | Guarded by |
|---|---|---|---|---|
| 1 | Add `ARCHITECTURE.md` (8.8) and `CLAUDE.md` pointing to it | S | none | — |
| 2 | `shared/time.ts`: one KST module (`kstDateOf`, `kstTimeOf`, `kstMidnight`, `kstLabel`). Replace the 26 inline copies; make `seoulDate()` an alias of `kstDateOf(Date.now())` | S | L | server tests, m3/m6/m9/lb (dates, shop windows, diary) |
| 3 | Split `shared/protocol.ts` into modules behind the same barrel | S | L | `tsc` both sides; all e2e unchanged |
| 4 | `server/src/lib/stmt.ts` statement cache; `errors.ts` (move `HttpError`) | S | L | full server e2e (m4, la, lb, m9) |
| 5 | Split `api.ts` into `routes/*.ts`, each `register(r, deps)`; `ApiServer` keeps the limiters | M | L | every e2e that hits /api (all) |
| 6 | Split `services.ts` into 4 domain files | S | L | m4, m5, m41 |
| 7 | `lib/reports.ts` (`report(target, …)`, `review(target, …)`) used by looks, library and letters | M | M | m8, la, lb (report and admin paths) |
| 8 | `lib/anonymity.ts` `displayName(row, viewer, admin)`; `lib/idempotency.ts` | S | M (privacy) | m51, la, lb (anonymous checks) |
| 9 | `realtime/seats.ts` `SeatTable` (one array per kind plus a generic `seats` message, keeping old message types for one release) | M | M | m2, m53, m54, la (desks) |
| 10 | `core/debug.ts`: move `publishDebug` and `installTestHooks` out of `Game.ts`, gated by `?test=1` | S | L | all e2e; add `test=1` to `screenshots.mjs` |
| 11 | `game/interactions.ts` and `game/spaces.ts` extracted from `Game.ts` | M | M | m3 (closet), la (library), m9 (shop prompts), m53 |
| 12 | `app/lazy.ts` plus dynamic imports for the library, settings, customize, admin, voice, groups, shop and guide features | M | M | m10, m8, m9, m5v, la/lb; the bundle size printed by the build |
| 13 | CSS: split into `styles/` and `features/*/styles.css` with **no rule changes** (pure move, source order kept) | M | L | b1, m42, m53, p13 screenshots diffed pixel-for-pixel |
| 14 | Worship `data-layout` state attribute and rewrite of `worship.css` | M | M–H | m31, m42, m52, b1, p13 (worship layout suites); visual baselines from step 13 |
| 15 | `ui/kit/SheetStack.ts` (back navigation) used by the 6 views with their own back stacks | M | M | m10, m8, la, lb |

### 8.8 `ARCHITECTURE.md` outline (for future agents)

1. **One-paragraph overview:** client (Vite + three, single page), server (Node: http + ws + SQLite),
   `shared/` contract, Docker plus the Cloudflare tunnel.
2. **Code map:** a table of "concern → file(s)": render loop, spaces, HUD prompts, each feature view, the
   network client, snapshots, seats, voice signalling, migrations, push, the shop clock, KST time, reports,
   anonymity, test hooks, debug state.
3. **Runtime flows:** boot → entry → `welcome` → world. A snapshot's life (12 Hz). An HTTP write (route →
   service → `room.*Changed()` fan-out). Push scheduling (minute tick) and shop tick (1 s).
4. **Conventions:**
   - DOM only via `el()`, never `innerHTML` with data;
   - all KST maths via `shared/time.ts`;
   - `requestId` for retryable writes;
   - migrations are append-only (`db.ts` array, `user_version`);
   - test-only switches (`WORLDS_TEST_MODE`, `?test=1`) and the production guard;
   - Korean UI copy rules;
   - CSS: one file per feature, state via `data-*`, no new body classes.
5. **How to add X** (recipes with the exact files):
   - a seat kind;
   - a sheet/view (lazy feature folder, `Modal`, `SheetStack`, CSS file, a guide entry if any);
   - a report target (`lib/reports.ts` + admin tab);
   - a push kind (migration column + prefs list + `NotifySettings` + export);
   - a WebSocket message (protocol union + `parseClientMessage` + `Room.handle` + `NetClient`);
   - an API route (`routes/<feature>.ts` + `shared/api.ts` type + rate limiter);
   - a landmark (`world/config.ts` + `Landmarks` + `LANDMARKS` for `?at=`);
   - a footprint event.
6. **Testing:** harness API, ports (5182–5189; never 5180, 5181 or 5190), the fresh-DB helper, which suite
   covers which feature, the smoke tier (below), and how to run one suite.
7. **Performance budgets:** first-load JS (gz), draw calls on the phone plaza, snapshot bytes per player,
   server ms per tick. Re-measure with the scripts described at the top of this report.
8. **Deploy:** link to `deploy/README.md`; never touch the `qt-worlds`/`qt-tunnel` containers from agents.

### 8.9 Tests: speed and reuse

The full e2e suite takes hours on the N100. Each suite builds its own server, preview and browsers, and the
suites contain about 230 s of fixed `sleep()`s.

- **Smoke tier (about 5 min):** 1 server + 1 preview shared by the steps, 2 browser contexts, steps:
  - guest join, then 2 players see each other (from m2);
  - sit on a mat (m2/m53);
  - open the book and write a meditation (m3/m10);
  - mock login and light a lantern (m4);
  - shop rent (m9);
  - enter the library, read a book, write a letter (la/lb);
  - worship dock fold (m42).
  
  Run it as `npm run test:smoke` before every commit, and the full suites nightly or per milestone.
- **Shared fixtures:** move `box`/`overlaps` (6 copies), `kst`/`seoulToday` (3+3), `account`, `modalIs`,
  `meditate` and `mat` into `scripts/lib/`. Port the 3 old suites (m2, m3, m31) that still define their
  own `start`/`stop`/`sleep`/`waitHttp`/`online` to the harness.
- **Replace fixed sleeps** with `until(page, () => __WORLDS_DEBUG__…)` predicates. Most suites already
  have the state to wait on.
- **Server unit tests:** `node --test` over the services with an in-memory DB covers letters, unread,
  reports, the shop clock, KST and anonymity in milliseconds instead of minutes of browser time. Today
  there are only 2 server tests (126 lines).
- **Run the browser suites in parallel** with distinct ports (5182–5189 gives 4 pairs). Each suite already
  uses `freshDb(name)`.

---

## 9. Recommended order

### Quick wins this week (each S, low risk; measurable)

1. **Snapshot day-change check:** replace `seoulDate()` in `checkDayChange` (`Room.ts:135-138, 720-730`) with
   a `nextMidnightKst` comparison. Make `seoulDate()` use `kstDateOf` (`protocol.ts:681`).
2. **Unread letters:** add a single-query `unreadCount()` and `GET /api/library/letters/unread`. Make
   `markRead` call `inbox()` once. Use it in `Game.ts:781`. Add the `lanterns_user` and
   `sessions_expires` indexes and `PRAGMA synchronous=NORMAL` (new migration plus `db.ts:428`).
3. **Gate `publishDebug`** behind `?test=1` (`Game.ts:1284`); add `test=1` to `scripts/screenshots.mjs`.
4. **Render-on-demand while sheets cover the canvas** (generalise `Game.ts:1240-1247`). Touch DPR cap
   1.5 → 1.25.
5. **Brotli** variant in the static cache (`http.ts:312`).
6. **Docker:** Node 22 base, drop the better-sqlite3 `deps/` and `src/`, npm cache mount.
7. **Lantern reaction counts** in one `GROUP BY` (`services.ts:342-374`); add the `stmt()` cache helper.
8. Write `ARCHITECTURE.md` and `CLAUDE.md` (8.8), and delete the 7 dead CSS classes.

### Next 2–4 weeks (M)

9. **YouTube facade on phones** (no iframe or video until the first tap/unfold). This saves about 2.6 MB
   per first session.
10. **Code splitting** (`app/lazy.ts`; library, settings, customize, admin, voice, groups, shop and guide;
    three in a vendor chunk): −53 kB gz first load.
11. **Snapshot v2:** changed-only plus hidden-once plus compact arrays, and far players at 3 Hz
    (−70 to −85 % downlink).
12. **Point-light pool** on touch, and merge static landmark and library geometry per material.
13. KST, reports, anonymity and idempotency libs; `api.ts` → `routes/`; `services.ts` split (8.7 steps 2–8).
14. Smoke-test tier and shared test fixtures (8.9).

### Bigger refactors (L, do with visual baselines in place)

15. CSS split (pure move), then the worship `data-layout` rewrite (8.7 steps 13–14).
16. `Game.ts` decomposition (`interactions`, `spaces`, `debug`, `loop`) and the typed event bus /
    `uiState`.
17. Global decor instancing, merged avatar geometry and adaptive DPR.
18. `SeatTable` and `SheetStack` abstractions.
