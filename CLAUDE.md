# CLAUDE.md: QT 월드

Start with **`ARCHITECTURE.md`**. It has the code map, data flow, conventions, the "how to add X" recipes, the test
tiers and the deploy flow. Measured performance baselines are in `docs/perf/2026-11-13-optimization-audit.md`.

## Hard rules

- **Live and dev are off limits.** Don't stop, restart, rebuild or exec into the `qt-worlds` / `qt-tunnel`
  containers, and don't touch the `qt-worlds-data` volume. Don't touch the dev processes on ports **5180 / 5181**,
  and keep away from **5190** (the live container). Tests use 5182–5189 and 5194–5199. A throwaway container
  goes on 127.0.0.1:5195 under another name and tag, and you remove it afterwards.
- **No secrets.** Never read `deploy/.env.live`, `deploy/.env.tunnel`, token or key files, or `~/.config/qt-worlds`.
  The repo is public. Templates are `deploy/.env.live.example` and `server/.env.example`.
- **YouTube rules** (ARCHITECTURE.md §3):
  - only the official embed;
  - one player;
  - visible at ≥ 200×200 with nothing over it while it exists and plays;
  - paused when folded or when the page is hidden;
  - phones load nothing from YouTube before the user's first tap (facade);
  - never download or re-host the songs.
- **No monetization** (ads, payments, paid items) and **no AI/LLM APIs** in the product.
- **Owner-decided designs stay as they are** unless the owner asks. For example:
  - a meditation started outside the 골방 is recorded as "골방에서 묵상";
  - the HUD is exactly 말씀 · 모임 · 찬양 · ⚙;
  - the phone worship player starts 작게 (video only).
- **Privacy:** anonymous items never reveal their author to others, and no account id leaves the server. Consent
  (`TERMS_VERSION`) gates writes.
- **Commits:** agents don't commit, push or deploy. The main session does. No `sudo` and no global installs.
- **Migrations** are append-only (`server/src/db.ts`).
- **CSS:** find every existing rule before changing layout. Add at most one clearly labelled block. No new body
  classes.

## Build and test

```bash
cd client && npm run build            # tsc + vite → client/dist
cd ../server && npm run build         # tsc → server/dist (also compiles shared/)
npm test                              # server unit tests (node --test), ~2 s
cd ../client && npm run test:smoke    # fast browser tier, ~1 min (target < 4 min); run before every commit
node scripts/<suite>-test.mjs         # one full suite for the area you touched (see ARCHITECTURE.md §5)
npm run test:all                      # everything, in order (hours)
```

- Load test pages with `?test=1`; `window.__WORLDS_DEBUG__` exists only then.
- Wait on predicates (`until(page, () => window.__WORLDS_DEBUG__…)`), not sleeps.
- Stop every process you start, and drop test DBs (`dropDb`).

## Commit conventions (main session)

Conventional commits, for example `feat(library): …`, `fix(worship): …`, `perf: …`, `docs: …`, `test: …`. Use one
logical change per commit, with the subject in English (Korean UI terms are fine). Each commit message ends with the
attribution lines the session provides.
