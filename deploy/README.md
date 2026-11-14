# worlds 배포 (live: https://qt.log2u.me)

- **Live:** one Docker container (`qt-worlds`) serves the built client, `/api` and `/ws` on a single port.
- **Request path:** Cloudflare (443, proxied) → Origin Rule → host nginx on **:8443** (TLS; reachable only by Cloudflare, LAN and VPN) → `127.0.0.1:5190` → container `:5181`.
- **Public URL:** visitors only ever see `https://qt.log2u.me` (no port), so `PUBLIC_BASE_URL`, the OAuth redirect URI and the Origin allowlist all use `https://qt.log2u.me`.
- **Dev:** stays local: Vite on 5180 and the Node server on 5181 (see the bottom of this file).

## 1. First-time setup

```bash
cd /home/hyun/projects/worlds
cp deploy/.env.live.example deploy/.env.live   # gitignored
# edit deploy/.env.live: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (PUBLIC_BASE_URL=https://qt.log2u.me)
```

### Google Cloud Console

1. **APIs & Services → OAuth consent screen.**
   - User type: **External**.
   - App name, support email, and the authorized domain `log2u.me`.
   - Scopes: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` only.
   - **Publish** the app ("In production"). While it is in "Testing", only listed test users can log in.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID.**
   - Application type: **Web application**.
   - Authorized JavaScript origins: `https://qt.log2u.me`.
   - Authorized redirect URI: **`https://qt.log2u.me/api/auth/google/callback`**.
3. **Copy the credentials.** Put the client ID and client secret into `deploy/.env.live`. Never commit them.

Google rejects private-IP redirect URIs, so real Google login works only through the public HTTPS domain. Without credentials, the button shows "Google 로그인 준비 중" and guest mode keeps working.

### nginx (host)

The nginx config is `deploy/nginx-qt.log2u.me.conf`. It is maintained separately; this README only describes what the app expects from it.

nginx terminates TLS and proxies everything (`/`, `/api`, `/ws`) to `http://127.0.0.1:5190`, with WebSocket upgrade enabled for `/ws`. It must send these headers:

- `X-Real-IP`: the visitor IP, restored from `CF-Connecting-IP` via the realip module.
- `X-Forwarded-For`
- `X-Forwarded-Proto: https`
- `X-Forwarded-Host: qt.log2u.me`

The container trusts these headers only from loopback and the Docker bridge range (`TRUSTED_PROXIES=loopback,docker` in `docker-compose.yml`). It sets Secure cookies when `X-Forwarded-Proto` is `https`. In live, WebSocket and API writes are accepted only from `Origin: https://qt.log2u.me` (`WORLDS_ORIGIN_STRICT=1`).

## 2. Build and start

```bash
docker compose build                 # ~ a few minutes on the N100
docker compose up -d qt-worlds
docker compose ps                    # STATUS should become "healthy"
curl -s http://127.0.0.1:5190/health # {"ok":true} (nginx-proxied callers never see more)
```

- **Fixed settings:** `docker-compose.yml` hard-sets `NODE_ENV=production` and `SERVE_CLIENT=1`, and forces the test-only switches (`WORLDS_AUTH_MOCK`, `WORLDS_TEST_MODE`, `WORLDS_ALLOW_TEST_DATES`) to `0`. The server also refuses to start if any of them is `1` while `NODE_ENV=production`.
- **Bible text:** `data/bible-krv.json` (about 6 MB, read-only) is **baked into the image**. Rebuild the image if it changes.
- **Database:** the SQLite DB lives in the named volume `qt-worlds-data`, at `/data/worlds.db`. Backups go to `/data/backups/`.
- **Screenshots (L-A, 📸):** in-world photos are files next to the database, in **`/data/screenshots/`** (same volume, so they survive `docker compose build`/`up -d`). Names are random (`<32 hex>.webp|jpg`), one DB row each (`screenshots` table). Override the folder with `WORLDS_SHOTS_DIR` (keep it inside the volume). Size: at most 10 photos per account per day, usually < 150 KB each (hard limit 400 KB); photos not used in a published diary are deleted after 30 days by the hourly sweep, and files are removed on 회원 탈퇴. The startup log prints the folder (`screenshots: /data/screenshots`).
- **발자취 / 이야기 도서관 data** is only in the database (tables `footprints`, `footprint_minutes`, `stories`, `story_*`, `diary_photos`, `shot_days`), so the normal DB backup covers it.

## 3. Update

```bash
cd /home/hyun/projects/worlds
docker compose build qt-worlds
docker compose up -d qt-worlds       # recreates the container, keeps the volume
docker compose logs --tail=50 qt-worlds
```

Schema migrations run automatically on start. They are versioned via `PRAGMA user_version`, and applied migrations are never edited.

## 4. Backup and restore

The backup uses SQLite's online backup API, so it is safe while the server is running.

```bash
docker exec qt-worlds node server/scripts/backup.mjs
# -> /data/backups/worlds-YYYYMMDD-HHMMSS.db (inside the volume)

# copy a backup out to the host
docker cp qt-worlds:/data/backups/. ./deploy/backups/

# daily cron example (host): 03:30
# 30 3 * * * docker exec qt-worlds node server/scripts/backup.mjs >/dev/null 2>&1
```

**Retention (개인정보 파기).** After each backup the script deletes all but the newest `BACKUP_KEEP` backups (default **14**) in that folder. It only touches files named `worlds-YYYYMMDD-HHMMSS.db`. With one backup a day, deleted accounts and content are gone from backups within about 14 days. The 개인정보처리방침 (`/privacy`, section 3) promises exactly this, so:

- run the backup **once a day**: more often shortens the window, less often lengthens it;
- if you change `BACKUP_KEEP` (`docker exec -e BACKUP_KEEP=7 qt-worlds node server/scripts/backup.mjs`), update the policy text in `client/src/legal/pages.ts` too;
- copies you take out of the volume (`./deploy/backups/` above) are not pruned. Delete them yourself after 14 days, or don't keep them.

**Photos are backed up too (B3, L-B).** Each run also maintains **one incremental photo mirror**, `/data/backups/screenshots/`, shared by all kept DB backups (photo files never change after upload, so one copy per photo is enough):

- new files in `/data/screenshots/` (and every file the new backup DB lists) are copied in, atomically (temp file + rename), mode 0600;
- a mirrored file is deleted only when it is gone from `/data/screenshots/` **and** none of the kept `worlds-*.db` backups lists it in its `screenshots` table.

So restoring *any* kept backup together with the mirror serves every photo that DB knows about, and a deleted photo (회원 탈퇴, 30-day 파기, 앨범에서 지우기) leaves the mirror once the last backup that still listed it is pruned, i.e. within `BACKUP_KEEP` backups (~14 days), as the 개인정보처리방침 says. Running it repeatedly is safe (idempotent: nothing is copied twice, a second run in the same second gets the next second, after every existing backup). Space: one copy of each live photo plus photos deleted in the last ~14 days (photos are < 150 KB, 10 per account per day at most). The script prints `photos mirrored in …: N copied, M removed, K files (X MB)`. If you copy backups out of the volume, copy `screenshots/` with them and prune those copies yourself too.

To restore (this stops the service briefly). The second step copies back only the photos the restored DB lists (nothing deleted later comes back):

```bash
docker compose stop qt-worlds
docker run --rm -v qt-worlds-data:/data -v "$PWD/deploy/backups":/b alpine \
  sh -c 'cp /b/worlds-YYYYMMDD-HHMMSS.db /data/worlds.db && rm -f /data/worlds.db-wal /data/worlds.db-shm && chown 1000:1000 /data/worlds.db'
docker compose start qt-worlds
# photos for that backup (from the mirror in the volume; safe while running):
docker exec qt-worlds node server/scripts/backup.mjs --restore-photos /data/backups/worlds-YYYYMMDD-HHMMSS.db
```

(If you restore a DB copied in from the host, put it in `/data/backups/` first or pass its path; the photos come from `/data/backups/screenshots/`. Exit code 2 means some listed photos were not in the mirror.)

## 5. Logs

```bash
docker compose logs -f qt-worlds     # json-file driver, 3 x 10 MB rotation
```

The app logs nicknames on join/leave and voice-room join, campfire chat *lengths* (never the text), account deletions (numeric id only) and errors. It does not log IP addresses. The 개인정보처리방침 describes this, so keep it in mind when adding log lines.

## 5a. 개인정보처리방침 / 이용약관 (M7)

- Pages: `/privacy` and `/terms`, static HTML generated at build time from `client/src/legal/pages.ts`.
- **Operator details live in `client/src/config/legal.ts`**: `OPERATOR_NAME`, `PRIVACY_OFFICER_NAME`, `PRIVACY_CONTACT` (email) and `EFFECTIVE_DATE`. Until the placeholders are replaced, every `npm run build` prints a loud `WARNING: LEGAL PLACEHOLDERS` (the build still succeeds). Rebuild the image after editing.
- Consent: sign-up records `users.terms_agreed_at` and `users.terms_version` (migration v6). When the texts change materially, bump `TERMS_VERSION` in `shared/protocol.ts` and `EFFECTIVE_DATE`. Every account then sees the consent sheet once, and saving or sharing waits until they agree.
- Hourly 파기 sweep (server): expired sessions, group chat older than 7 days, lantern copies (taken down: after 1 day; expired: 1 day after leaving the hill), and sign-ups that never chose a nickname (after 1 day). SQLite runs with `secure_delete=ON`.
- 꾸미기 (M8, migration v7): `users.appearance` (palette indices JSON), `users.outfit_slot`, `users.outfit_strikes`, `users.outfit_ban_until`, tables `outfits` (16×16 drawings as 256 palette-index characters, content hash) and `outfit_reports`. A drawing with 3 distinct reporters is hidden for everyone but its owner; every 3 hidden drawings pause uploads for 7 days. Replaced drawings that were reported are kept 30 days after their last report for review, then swept. Account deletion removes all of it (cascades); the export includes appearance, drawings and the user's own reports.
- 내 데이터 내려받기: `GET /api/me/export`; 회원 탈퇴: `POST /api/me/delete` (`{ nickname }`). Both are rate-limited. The export limit can be set with `EXPORT_RATE_LIMIT` (default 10 per hour per user/IP).

## 6. Environment reference

| Variable | Live value | Notes |
|---|---|---|
| `PUBLIC_BASE_URL` | `https://qt.log2u.me` | Used to build the OAuth redirect URI |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | from Console | Login is disabled ("준비 중") if missing |
| `WORLD_SEED` | `worlds-v1` | Changing it changes the world |
| `TRUSTED_PROXIES` | `loopback,docker` | Aliases, IPv4 CIDRs, exact IPv6 |
| `WORLDS_ALLOWED_ORIGINS` / `WORLDS_ORIGIN_STRICT` | `https://qt.log2u.me` / `1` | Origin allowlist |
| `MAX_PLAYERS`, `MAX_CONN_PER_IP` | 50, 12 | |
| `NEW_ACCOUNTS_PER_HOUR` | 60 | Global brake on sign-ups |
| `AUTH_RATE_LIMIT` | 30 | Login starts/callbacks per IP per minute |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | from `npx web-push generate-vapid-keys` | Web Push; notifications are off (UI hidden) if missing. See §8 |
| `VAPID_SUBJECT` | `mailto:you@example.com` | Contact for push services (`mailto:` or `https:` URL). Required with the keys |
| `WORLDS_ADMIN_EMAILS` | your Google email | Comma-separated, matched against the verified Google email. These accounts see ⚙ → 옷 그림 관리 (reported outfits: 숨김 유지 / 복구 / 그림 금지 n일). Everyone else gets 404 from `/api/admin/*`. Empty = no admin |
| `LETTER_RATE_LIMIT` / `LETTER_REPLY_RATE_LIMIT` | `20` / `60` | ✉️ 답장 편지 (L-B): new letters / replies per account per hour (idempotent retries don't count). Optional |

## 7. Without Docker (production mode on the host)

```bash
cd client && npm ci && npm run build
cd ../server && npm ci && npm run build
PUBLIC_BASE_URL=https://qt.log2u.me GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run start:prod   # :5181, serves client/dist
```

## 8. PWA: service worker, install, Web Push

### Web Push keys (one time)

```bash
cd server && npx web-push generate-vapid-keys      # prints a public and a private key
```

Put them in `deploy/.env.live` (gitignored, never commit them):

```
VAPID_PUBLIC_KEY=<public key>
VAPID_PRIVATE_KEY=<private key>
VAPID_SUBJECT=mailto:<an address you read>
```

Then rebuild and recreate the container (§3). The log says
`Web Push not configured …` when any of the three is missing; then ⚙ 설정 has no 🔔 알림 section and
`/api/push/*` answers 404. **Keep the keys stable**: a new key pair makes every existing browser
subscription useless (users have to turn 알림 on again).

What is sent (the server checks every minute, Asia/Seoul time):

- 🕊️ daily word at each user's chosen time (default 06:00, 30-minute steps), at most once per day per
  user (`push_prefs.last_daily_date`). If the server was down at that minute it still sends up to 2 hours late.
- 🤲 "누군가 당신의 묵상을 위해 기도하고 있어요" when someone taps 기도하기 on my lantern. Never who prayed or
  which lantern; at most one per 15 minutes per person, the rest batched into the next one.
- Push services answering 404/410 make the server delete that subscription. Each account keeps at most
  10 devices. Only subscriptions to the real push services (FCM, Mozilla, Apple, WNS) are accepted.

iPhone/iPad: push works only from the home-screen app (iOS 16.4+); the app explains this.

### How service-worker updates reach users

- `npm run build` (client) writes `dist/sw.js`: the hand-written `client/sw/sw.js` plus the precache list
  (index.html, hashed `/assets/*`, small icons, manifest) and `SW_VERSION`, a hash of all of them. Any
  change to the client gives a new `sw.js`.
- The server sends `/sw.js` with `Cache-Control: no-cache`, and the page registers it with
  `updateViaCache: 'none'`, so browsers re-check it on every visit (and every 30 minutes / when the app comes
  back to the foreground). Do **not** add a Cloudflare cache rule for `/sw.js`.
- The new worker installs in the background and **waits**; open pages show "새 버전이 있어요 [새로고침]".
  Tapping it activates the new worker and reloads once. Old `qt-worlds-*` caches are deleted on activate.
  Users who ignore the toast get the new version the next time all tabs are closed.
- Pages are network-first, so a deploy is visible right away even before the toast; the cache is only
  used when the server can't be reached (cached shell, or the "연결이 끊겼어요" page).
- `/api/*`, `/ws`, `/health`, `/sw.js`, Google and anything cross-origin never go through the cache.
- The dev server (`npm run dev`, 5180) never registers a worker. `?nosw=1` skips registration in a build.

### Kill switch (if a broken worker ever ships)

```bash
cd client && WORLDS_SW_KILL=1 npm run build    # dist/sw.js = client/sw/sw-killswitch.js
# (or in Docker: add `ENV WORLDS_SW_KILL=1` before the client build in the Dockerfile, rebuild, deploy)
```

That `sw.js` deletes every `qt-worlds-*` cache, unregisters itself and reloads open tabs from the
network. Browsers pick it up on their next visit (the normal update check). Leave it deployed for a few
weeks, then deploy a normal build again. One user can also clear it by hand: browser site settings →
clear site data (Chrome: DevTools → Application → Service workers → Unregister).

## Dev (unchanged)

```bash
cd server && npm run build && npm start      # 5181, DB at server/data/worlds.db
cd client && npm run dev                     # 5180, proxies /api and /ws to 5181
```

For local login testing without Google, start the server with `WORLDS_AUTH_MOCK=1`. This is a test-only fake provider and is refused in production.
