# 성경 본문 출처 (Bible text source)

- **번역본 / Translation:** 개역한글판 (Korean Revised Version, 1952/1961)
- **Downloaded from:** https://api.getbible.net/v2/korean.json (getBible API v2, translation `korean`, 2026-11-08)
- **Upstream:** CrossWire Bible Society SWORD module `KorRV` (v2.0.1, 2019-01-07). The text comes from Korean Wikisource (위키문헌), OSIS source, NRSV versification.
- **Raw file:** `raw/getbible-korean.json`. Its sha256 is recorded in `bible-krv.json` → `meta.sourceSha256`. The raw file is treated as untrusted data. It is only parsed as JSON by `scripts/build_bible.py` and never executed.
- **Output:** `bible-krv.json`: 66 books, 31,084 verses, `{book, chapter, verse, text}`.
  - Six verses are placeholders in the source (`(없음)` = omitted in this edition, or `상동` = merged with a neighbouring verse). They are flagged `"placeholder": true` and never chosen as today's word.

## License status

- **Upstream declaration:** both the getBible metadata and the CrossWire distribution declare this text as **Public Domain**. Korean Wikisource treats 개역한글 as public domain because the copyright term ended (commonly cited as expiring at the end of 2011/2012).
- **What remains unconfirmed:** the 대한성서공회 (Korean Bible Society) has historically asserted rights over 개역한글. We have **not** found an official legal ruling or statement settling this, so the status should be confirmed before any commercial or large public deployment. PLAN.md §7 already flags this: low risk for non-commercial or church-internal use; for a public service, check with 한국저작권위원회.
- **Attribution in the app:** the UI shows "개역한글판" wherever a verse is displayed.

## Rebuild

```
python3 -I data/scripts/build_bible.py
```

## 오늘의 말씀 후보 (curated-verses.json)

`curated-verses.json` holds about 485 hand-picked **references only**. The verse text always comes from `bible-krv.json`. The choices favour passages that suit personal meditation: Psalms, Proverbs, the prophets' comfort and promise passages, the Gospels, and the letters.

**Format:** each entry in `"verses"` is a string in one of these forms:

- `"책이름 장:절"`, e.g. `"시편 23:1"`
- `"책이름 장:절-절"` for a short range within one chapter (at most 4 verses), e.g. `"시편 23:2-3"`

`책이름` must match `books[].name` in `bible-krv.json` exactly, for example `시편`, `요한일서`, `예레미야애가`.

**Adding or removing verses:**

1. Edit `data/curated-verses.json`: add or remove lines in `"verses"`. Order doesn't matter.
2. Run the checks:

   ```bash
   cd server && npm run build && npm test
   ```

   `test/curated.test.mjs` fails on any invalid or duplicate reference. At startup, the server also logs every invalid entry as `curated-verses.json: ...` and skips it.
3. Restart (or rebuild the Docker image, since the file is baked into it).

**How a day's verse is picked:**

- Day *d* is counted from 2026-01-01, by the Asia/Seoul date.
- It uses position *d mod N* of a seeded shuffle of the whole list, with one shuffle per cycle of *N* days.
- So nothing repeats until every entry has been used, and everyone gets the same verse on the same day.
- Changing the list changes the order of future days.

**Fallback:** if `curated-verses.json` is missing, the server falls back to the older rule-based picker in `server/src/dailyWord.ts`.

**Placeholder verses:** the source marks some verses as placeholders (`(없음)`, `상동`, `(앞절과 동일)`). They are flagged and never used.
