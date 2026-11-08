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

To restore (this stops the service briefly):

```bash
docker compose stop qt-worlds
docker run --rm -v qt-worlds-data:/data -v "$PWD/deploy/backups":/b alpine \
  sh -c 'cp /b/worlds-YYYYMMDD-HHMMSS.db /data/worlds.db && rm -f /data/worlds.db-wal /data/worlds.db-shm && chown 1000:1000 /data/worlds.db'
docker compose start qt-worlds
```

## 5. Logs

```bash
docker compose logs -f qt-worlds     # json-file driver, 3 x 10 MB rotation
```

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

## 7. Without Docker (production mode on the host)

```bash
cd client && npm ci && npm run build
cd ../server && npm ci && npm run build
PUBLIC_BASE_URL=https://qt.log2u.me GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run start:prod   # :5181, serves client/dist
```

## Dev (unchanged)

```bash
cd server && npm run build && npm start      # 5181, DB at server/data/worlds.db
cd client && npm run dev                     # 5180, proxies /api and /ws to 5181
```

For local login testing without Google, start the server with `WORLDS_AUTH_MOCK=1`. This is a test-only fake provider and is refused in production.
