# QT 월드: first-time user QA (2026-11-13, HEAD 76d0b0f)

**Tester:** Claude, playing "새가족", a brand-new user on an Android-size phone. A second account, "바나바", played the other side on desktop.
**Build:** local production-mode server (`SERVE_CLIENT=1`, `WORLDS_AUTH_MOCK=1`, fresh throwaway DB, port 5182). It served the freshly built client `index-Dv4_f5D-.js`. **The live site serves the same bundle hash**, so every finding below applies to https://qt.log2u.me as it is today.
**Devices:**
- phone: 412×915, `isMobile`, `hasTouch`, ko-KR, Asia/Seoul, with real touch events through CDP for the joystick, the painter and taps;
- desktop: 1280×800.

**Real clock:** about 01:00–01:50 KST, so it was night and the shop was closed. I opened the shop with the m9 test clock.

**Screenshots:** `docs/qa/shots/` (192 files). Each finding names the most relevant ones.

## Environment notes (not counted as bugs)
- This machine has no emoji font, so every emoji shows as a ☒ box. I only mention it here.
- SwiftShader rendered at about 2–8 fps with two or three browsers open. Walking was slow, and the "debug" state lagged a few frames. I didn't count slowness.
- YouTube really played in headless Chromium. Its telemetry calls (`youtube-nocookie.com/api/stats/*`, `ptracking`) end in `ERR_ABORTED`. That is noise from the embed, not from the app.
- 🔔 알림 was not in the local ⚙ menu because no VAPID keys are set locally. On live it shows; I only looked at the guest version.
- After I found P1-1, I swapped YouTube for the test stub from `lb-test.mjs` so that the rest of the session would not freeze. The worship-player findings below were all seen with real YouTube, before the swap or on live.

## Summary

| Priority | Count |
|---|---|
| P1 (broken, blocks a task, privacy or policy) | 3 |
| P2 (confusing or ugly, noticeable) | 12 |
| P3 (polish or wording) | 18 |

### Console and network, per page
**Local, phone "새가족":**
- `pageerror: Cannot read properties of undefined (reading 'video_id')` once (see P1-1).
- `Unrecognized feature: 'web-share'` and `No available adapters.` on every load.
- 400 on `POST /api/me/nickname` (expected validation).

**Local, desktop "바나바":**
- The same `video_id` pageerror, which froze it too.
- 409 on the nickname (expected).
- **400 on `POST /api/library/stories/2/letters` with no message in the UI** (see P2-12).

**Desktop "새가족" (second device):** none.

**Live, guest:** only the two warnings. Every app request returned 2xx.

---

## P1

### P1-1 The whole world freezes for good when the worship playlist moves to the next song
**Steps:**
1. Log in, enter and leave the worship player running.
2. Wait for the first song to end (about 5 minutes).

**Expected:** the next song starts and the world keeps running.

**Actual:** at the song change, `TypeError: Cannot read properties of undefined (reading 'video_id')` is thrown inside the render loop. The three.js animation loop stops and never restarts:
- the clock stays at "오전 1:08" while the real time is 01:10;
- the avatar stays seated after "일어나기";
- the joystick, the action buttons and teleports do nothing;
- `__WORLDS_DEBUG__.frame` stops increasing;
- only DOM sheets still open.

It happened on the phone (01:08:38) and, independently, on the desktop account (01:21:20). Only a reload recovers.

**Shots:**
- `23-worship-ended.png`: the YouTube end screen at the moment of the crash.
- `22-bench-sit.png` and `25-standing-check.png`: the frozen frame, clock stuck, "일어나기" does nothing.

**Likely cause:** `client/src/ui/WorshipPlayer.ts:910`:
```ts
videoId: (this.ready && this.player?.getVideoData?.().video_id) || null,
```
- `getVideoData()` returns `undefined` while the next video is loading, and the code then reads `.video_id` from it.
- `describe()` is called from `Game.publishDebug()` (`Game.ts:1286` and `1374`). That runs every 5 frames **in production** and is not gated by `?test=1`.
- An exception in a `setAnimationLoop` callback kills the loop, because three's `WebGLAnimation` never schedules the next frame.

**Fix:** use `getVideoData?.()?.video_id`. Also consider wrapping `publishDebug` in try/catch, or only publishing under `?test=1`.

### P1-2 The worship player can play while the app thinks it is stopped, so it is not paused in the background (YouTube policy risk)
**Steps:**
1. Open https://qt.log2u.me on a phone as a guest (or reload a logged-in session).
2. Enter. The video visibly plays: the subtitles change between screenshots.
3. Send the page to the background.

**Expected:** the player state is "playing" and backgrounding pauses the video. That is what happened in my very first local session.

**Actual:**
- The player shows "▶ 찬양 듣기" on top of a video that is clearly playing. Debug says `state: "none"` and `promptVisible: true`.
- When `visibilitychange → hidden` fires, the pause is skipped: `backgroundPauses: 0`, and the frames keep changing while hidden.
- So the video (and its sound) keeps playing in the background.
- I saw this on live and twice locally after a reload, on both phone and desktop. Folding still pauses, because that calls `pauseVideo()` unconditionally.

**Shots:**
- `live-10-guest-look.png` and `live-09-guest-notify.png`: "찬양 듣기" over a playing video.
- `live-12a-player.png` and `live-12b-player.png`: two different frames, 4 s apart, while the state is "none".
- `live-13a-hidden.png` and `live-13b-hidden.png`: still advancing while hidden.
- `30-mat-meditate.png` and `36-B-chat.png`: the same chip locally.

**Likely cause:**
- `WorshipPlayer.create()` passes `playerVars.autoplay = 1`, so the iframe starts playing on its own. The first `onStateChange(PLAYING)` seems to be lost before the API channel is ready, and `onReady → playVideo()` then makes no state change.
- `pauseForBackground()` (`WorshipPlayer.ts:317`) only pauses when `this.state` is PLAYING or BUFFERING.

**Fix:** in `pauseForBackground`, pause whenever a player exists. On `onReady`, read `player.getPlayerState()` to resync.

**Caveat:** I simulated visibility in headless Chromium. Please confirm on a real Android phone (lock the screen and listen).

### P1-3 Landscape on a phone: every sheet becomes unusable
**Steps:**
1. Rotate the phone to landscape (915×412).
2. Open 말씀, ⚙ → 꾸미기 or any other sheet.

**Expected:** a readable sheet.

**Actual:**
- The worship player docks above the sheet and takes about 270 px. That leaves about 110 px for the sheet, which is only its title and tabs.
- The word, the meditation steps and the painter can't be reached. The player itself is fine at 354×200.

**Shots:** `139-landscape-book.png`, `140-landscape-look.png`. `138-landscape-world.png` (the world alone) looks fine.

**Likely cause:** the sheet and player dock layout in `styles.css` has no `(orientation: landscape) and (max-height: ~500px)` rule. The player could sit beside the sheet, or shrink to its 200×200 minimum.

---

## P2

### P2-1 The Android back button leaves the world instead of closing the open sheet
**Steps:**
1. Open 말씀, ⚙ → 소리, or anything else.
2. Press back (`history.back()`).

**Expected:** the sheet closes and I stay in the world.

**Actual:**
- The whole page goes back to the entry screen ("새가족 님, 반가워요 / 입장하기"), and loading the world again takes about 30 s.
- A second back goes to the previous page in history. In production, right after logging in, that is Google's OAuth page.
- A third back left the site (`about:blank`).

**Shots:** `143-after-back-1.png`, `145-after-back-4.png`.

**Likely cause:** sheets don't push a history entry or handle `popstate` (`ui/dom.ts` Modal).

I would treat this as nearly P1 on Android.

### P2-2 Toasts are hidden behind the worship player, the voice pill and the HUD buttons
The toast sits at the top centre, overlapping 말씀/모임, and the docked player covers its right half. These messages could not be read:
- "골방에서의 묵상을 말씀 책에 담았어요" (`12-meditate-saved.png`);
- "기도의 뜰에서의 묵상을…" (`31-mat-meditate-saved.png`);
- "오늘 앨범에 담았어요 (2/10)…" (`69-photo-2.png`);
- **"마이크를 찾지 못했어요. …을 확인해 주세요"**, which also has the voice pill on top of it (`128-voice-mic-tap.png`);
- "손등불을(를) 빌렸어요" (`137-rental-timer.png`).

**Expected:** toasts sit in a free area (above the joystick, or below the player) and above the other floating UI.

### P2-3 "🏮 등불로 나누기" seems to do nothing on a phone
Steps:
1. Open 말씀 → 오늘.
2. Tap 🏮 등불로 나누기.

The share form opens **below the fold**: `#share-submit` is at y=1142 on a 915-px screen, and the sheet doesn't scroll to it. From the user's side nothing changed.

**Shots:** `42-lantern-share-sheet.png`, and `43-lantern-share-form.png` after scrolling by hand.

**Fix:** `scrollIntoView` the form.

### P2-4 Sharing a lantern publishes the whole private meditation, with no preview and 공개 preselected
**Guide page 4 says:** "내 묵상은 나만 볼 수 있어요".

**What sharing does:** it publishes everything to anyone who walks up: 묵상, **느낀 점** ("요즘 지쳐 있었는데…") and 적용.
- The share form doesn't show what will become public.
- 공개 is selected by default.
- Others can tap 기록하기 and keep a permanent copy in their own book (`50-B-saved-tab.png`).

For a first-time user this is a privacy surprise.

**Shots:** `43-lantern-share-form.png`, `47-B-lantern-card.png`.

**Suggestion:** show a preview, let people pick which parts to share, and consider 모임 or 익명 as the first-time default.

### P2-5 Meditation place is wrong: "골방에서 묵상" when I was at the plaza, and the false fact spreads
**Steps:**
1. Open the letter on the plaza.
2. Tap ✍️ 묵상하기.

**What happens:**
- The sheet title says "골방에서 묵상" and the toast says "골방에서의 묵상을 담았어요".
- The book says "✓ 오늘 골방에서 묵상했어요".
- The auto diary writes "골방에서 말씀을 묵상하며…", and that diary can be published.
- Re-saving the meditation on a 기도의 뜰 mat ("기도의 뜰에서의 묵상을 담았어요") **doesn't update** the ✓ line. It still says 골방 (`44-lantern-shared.png`, `54-closet-meditate.png`).

**Shots:** `10-meditate-1.png`, `13-book-today.png`, `70-diary-open.png`.

**Cause:** `game/Devotion.ts:178`, `this.o.meditationPlace() ?? '골방'`.

**Fix:** use the real place (광장, or "어디서나"), or leave the place out.

### P2-6 After leaving the library, the camera sits behind the building and hides the avatar
- **Steps:** tap 문으로 나가기.
- **Actual:** half the screen is the library roof or wall, dark navy, and the avatar is cut off behind it. Walking forward doesn't fix it until you turn the camera.
- **Shots:** `95-worship-folded.png`, `96-after-library-walk.png`, `98-library-outside-back.png`. The side view, `97-library-outside-side.png`, shows the building right behind the camera.
- **Likely cause:** `leaveLibrary` sets the yaw facing away from the door but places the camera toward the house, and there is no camera collision with buildings.

### P2-7 Floating place labels grow huge when you are near them
- The "중앙 광장" sign fills the right third of the screen next to the fountain (`22a-near-bench.png`).
- The "이야기 도서관 / 함께 읽는 이야기" sign fills the top of the screen right after leaving the library (`93-worship-after-handle.png`, `96-after-library-walk.png`).
- On desktop the "모닥불 모임터" label overlaps the 말씀 button (`36-B-chat.png`).

**Suggestion:** clamp the label's screen size, or fade it out at close range (`world/labels.ts`).

### P2-8 The outfit painter is cramped on a phone, and strokes under the sticky header are lost
- With the player docked, only the top of the 16×16 grid is visible (`109-painter.png`).
- The palette and tools are below the fold.
- When you scroll, the sticky preview and tabs cover the top rows. A stroke that starts there doesn't paint, which happened to my first attempt (`110-painter-drawn.png`).
- Drawing itself works by touch, and the saved outfit shows on the other user right away.

**Suggestion:** a compact painter layout on phones (a smaller preview, the palette beside the grid), and fold the player while the painter is open.

### P2-9 The campfire chat panel covers your own avatar and the fire
- Sitting on a log, the chat card sits exactly over the seated avatar and the fire. Your own speech bubble shows dimly through it.
- **Shots:** `32-campfire-sit.png`, `35-A-chat-sent.png`.
- **Suggestion:** move the camera or the panel so you can see who you are talking with. The "작게" and "접기" modes work well (`37-chat-small.png`, `39-chat-folded-unread.png`, with an unread badge).

### P2-10 Tapping another person opens an almost empty sheet with a strange line
- **Steps:** tap 바나바's avatar.
- **Actual:** a full-height sheet titled "바나바" that says only "그림 없는 옷을 입고 있어요." and "함께 있는 사람 모두 보기" (`146-tap-remote.png`). This is really the report sheet.
- **Expected:** something social: 인사, 편지, 모임에 초대, their lantern or story today. Reporting would go under a "⋯" menu.

### P2-11 Floating chips overlap each other and the location card
- **Phone:** the voice-room pill shrinks the group name to "새··" (`128-voice-mic-tap.png`, `131-A-voice-sees-B.png`).
- **Desktop library:** the rental chip ("1095분 반납") sits on top of "↩ 문으로 나가기" (`156-desktop-inbox.png`).
- **Phone landscape:** the voice pill and the rental chip stack on the location card (`138-landscape-world.png`).

### P2-12 A letter over 300 characters fails silently
- **Steps:** type 350 characters in "✉️ 이 이야기에 편지 쓰기" and tap 편지 보내기.
- **Actual:**
  - the counter turns red ("350 / 300자"), but the button stays enabled;
  - the request returns **HTTP 400**;
  - nothing in the UI changes.

  The textarea's `maxLength` is 600, while the counter says 300.
- **Shot:** `78-B-letter-over.png`.
- **Expected:** a disabled button or a message, and `maxLength=300`.

---

## P3

1. **Page title is English and doesn't match the brand.**
   - The tab title is "worlds · 말씀 나눔 월드" (`client/index.html:12`). The entry card says "말씀 나눔 월드".
   - The manifest, the guide and the photo stamps say "QT 월드".
   - Suggestion: "QT 월드 · 말씀 나눔 월드".
2. **Particle placeholder "을(를)".** "🏮 손등불을(를) 빌렸어요" (`136-shop-rented.png`). The same pattern appears in:
   - `ShopView.ts:126` and `ShopView.ts:205`;
   - `server/src/shop.ts:199`;
   - `Legal.ts:230`.

   A josa helper already exists in `server/src/diary.ts:44`.
3. **Auto-diary line has nested quotes and is clipped.**
   - The text reads `“"나의 구속자가 살아 계시니"라는 …”라고 적었어요`.
   - Its textarea doesn't grow (scrollHeight 101, clientHeight 58), so the text is cut off (`71-diary-line-clipped.png`).
4. **The auto diary leaves out the most social moments.** It skips "등불을 밝혔어요", "이야기를 꽂았어요" and "편지를 받았어요/답장했어요", though it logs "광장 벤치에 앉아…" (`70-diary-open.png`). The footprint types have no `lantern_share`, `story_publish` or `letter` (`server/src/footprints.ts:8`).
5. **Your own reply appears in 받은 편지.** It is listed as a received item from "새가족" (`156-desktop-inbox.png`).
6. **Testimony shelf isn't preselected.** I opened "✍️ 이야기 쓰기" from the 🌧️ 광야에서 shelf, but the last step asks again which shelf (`66-write-final.png`).
7. **Back-link wording is inconsistent:** "← 설정" (꾸미기), "← 뒤로" (other settings pages) and "‹ 모임 목록" (groups).
8. **The guide is incomplete.**
   - Page 6 lists the ⚙ items without 📔 발자취 (`07-guide-6.png`).
   - No page mentions 편지 / 받은 편지, 나눔 소품 가게, the 음성 기도방 or the 📸 camera button.
   - While the guide is open, the worship player covers the very HUD buttons that page 6 explains.
9. **Map and list labels differ:** the map says "모닥불 모임터" and the list says "모닥불" (`07-guide-3.png`).
10. **The group creator's member count is stale.** After 바나바 joined, the creator's group sheet still said "1명" until it was reopened (`121-group-chat-open.png`).
11. **Everyone spawns on the exact same point.** Two avatars and name tags overlap, so on the phone the label over "me" read "바나바" (`131-A-voice-sees-B.png`). A small random offset at spawn would fix it.
12. **Guest dead ends on live.**
    - ⚙ → 🔔 알림 is a single line with no login button (`live-09-guest-notify.png`).
    - The 모임 login prompt says "지금 적던 묵상은 이 기기에 임시로 남아 있어요" when the guest wasn't writing anything (`live-08b-groups-login.png`).
13. **Reload starts over.** After a reload you are back at spawn and the playlist restarts at song 1 (`27-after-reload.png`).
14. **골방 camera is too close.** The avatar's head fills half the screen (`52-closet-inside.png`).
15. **Player behaves differently in the 골방.**
    - With a sheet open in the world, the player expands with controls (`13-book-today.png`).
    - In the 골방 it drops to a bare 200×200 mini (`54-closet-meditate.png`).
    - On the phone, any open sheet costs about 30% of the screen to the player. That is acceptable in portrait, but see P1-3.
16. **Console warnings on every load, live included.**
    - "Unrecognized feature: 'web-share'": the iframe `allow` list.
    - "No available adapters.": a WebGPU probe.
17. **"지난 말씀" naming.** The tab also holds today's entry, and the pager "1 / 1장" sits below the fold (`14-book-mine.png`).
18. **Smaller oddities.**
    - The desktop guide card isn't centred: x 188–708 on a 1280-wide screen (`18-desktop-guide.png`).
    - The nickname-consent error appears under "다른 계정으로 로그인", far from the checkbox it refers to (`04-nick-noagree.png`).
    - After a nickname change, others see the new name only when you re-enter. The UI says so, but it is surprising.

---

## Checked and working
- **Entry:** Google login, then the mock form, nickname, then consent. The empty, duplicate ("이미 다른 분이 쓰고 있는…") and over-12-character cases all give clear messages.
- **Letter and meditation:** the letter flies in and opens, and the 4-step meditation saves and can be edited.
- **말씀 책:** all three tabs work, and the "담아 둔 묵상" empty state explains what to do.
- **Seats and closet:**
  - plaza bench, mat with pray pose and 묵상하기, campfire log;
  - the 골방 enters and exits, and its 작게/보통/크게 player sizes work (200×200, 366×206, 366×300).
- **Campfire chat:** works both ways with emoji; 작게, 접기 with an unread badge, and 펼치기 all work.
- **Lantern:** shared; the other user saw it, reacted 아멘/기도하기 and recorded it into 담아 둔 묵상.
- **Library:**
  - entering and shelves;
  - a 3-step testimony with a 1,200-character body;
  - 2 in-world photos;
  - a diary with photos that 바나바 could read (photos load);
  - a letter, a reply, and the inbox badge, which appeared live on the 말씀 button (`91-A-hud-new-letter.png`).
- **Worship:**
  - next/previous, mute, list and close/reopen work;
  - folding pauses the video;
  - backgrounding pauses it when the state is in sync;
  - no sheet ever covered the video (I checked with elementFromPoint), and every size was at least 200×200.
- **Settings and groups:**
  - 꾸미기: colours, hair, drawing, and the outfit appears live on the other user;
  - sound sliders; footprints text; account (nickname change, emoji allowed);
  - re-opening the guide;
  - groups: create, join with a lowercase code, group chat with long text and emoji, the 가리기 and 삭제 actions;
  - voice room: join, see the peer, unmute with a fake mic, and "마이크를 찾지 못했어요" without one.
- **Shop:** opened with the test clock, rented a 손등불, the HUD timer showed, and 반납 worked.
- **Edge cases:**
  - reload mid-flow;
  - the second user leaving (the count dropped to 1) and returning;
  - the same account on phone and desktop at once;
  - a 1,117-character text, emoji in every field.
- **Live guest pass:** the same bundle as local, the same look and flow, no app errors.

## Things that felt good
- The tone is warm and unhurried throughout ("천천히 둘러보세요. 서두르지 않아도 괜찮아요.", "아직 조용해요. 먼저 인사해 보세요."). It never feels like an app nagging you.
- The letter that flies to you is a lovely daily hook. Showing the key verse with its context (23–27, verse 25 highlighted) is thoughtful.
- The 말씀 → 묵상 → 느낀 점 → 적용 steps with gentle prompts make it easy for a first-timer to write something real.
- The auto diary ("새벽에 오늘의 말씀 편지를 열었어요…") is delightful and makes a day feel remembered. Photos land in it naturally.
- Letters on stories, with replies and the "글쓴이의 답장을 기다리고 있어요" state, feel personal and safe.
- The privacy explanations are honest and specific: footprints, the voice room ("녹음하거나 저장하지 않아요") and story visibility.
- Joining a group with a 6-character code, even typed in lowercase, just works. The system lines ("바나바님이 모임에 함께했어요") are nice.

## Top 5 improvements for communication
1. **Let people feel each other.** When someone says 아멘, 함께 기도해요 or 기록하기 on my lantern or story, tell me gently, for example "바나바님이 내 등불에 함께 기도했어요 🙏" as a small toast or a 받은 편지 entry. Today the author gets nothing (`49-A-sees-reactions.png`).
2. **Make sharing feel safe.**
   - Show a preview of exactly what becomes public, and let people pick which parts to share (just 묵상, or all three).
   - Default first-timers to 모임 or 익명.
   - Say clearly that sharing a lantern makes the 느낀 점 public.
3. **Turn "tap a person" into a doorway:** 인사하기 👋, 오늘의 등불·이야기 보기, ✉️ 편지 쓰기, 모임에 초대. Put 신고 under "⋯".
4. **Guide the next step after each act.**
   - After saving a meditation: "등불로 나누어 볼까요? / 모닥불에 누가 있는지 볼까요?".
   - After lighting a lantern: "등불 언덕에서 다른 분들의 등불도 읽어 보세요".
   - A first-timer often doesn't know where to go next.
5. **Put the sharing moments in the diary and on the HUD.** Write "등불을 밝혔어요", "이야기를 꽂았어요" and "편지 2통을 주고받았어요" in the auto diary. Keep the 받은 편지 badge visible outside the 말씀 book, for example on its own HUD chip, so conversations don't go unnoticed.
