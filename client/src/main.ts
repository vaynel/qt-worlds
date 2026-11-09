import './styles.css';
import { Game } from './game/Game';
import { JoinRefused, NetClient, resolveServerUrl, type Welcome } from './net/NetClient';
import { AudioEngine } from './audio/AudioEngine';
import { WORSHIP_VIDEOS } from './config/worship';
import { getAuthConfig, getMe } from './net/api';
import { GuestWordBookStore, LocalWordBookStore, ServerWordBookStore, type WordBookStore } from './storage/WordBook';
import { EntryScreen } from './ui/EntryScreen';
import { preloadYouTubeApi, WorshipPlayer } from './ui/WorshipPlayer';
import { initPwa } from './pwa/pwa';

// Service worker (production builds only), install prompt capture.
initPwa();

const canvas = document.querySelector<HTMLCanvasElement>('#world-canvas');
if (!canvas) throw new Error('#world-canvas 를 찾을 수 없어요');

const entry = new EntryScreen();
// Created now so the first tap (e.g. the 입장하기 button) can unlock audio.
const audio = new AudioEngine();

// One worship player for the whole session. The API loads while the nickname
// screen is up so the player can start right after the 입장 tap.
// ?test=1&noworship=1 simulates an empty video list.
const qs = new URLSearchParams(location.search);
const testing = qs.get('test') === '1';
// Test-only: ?noworship=1 empties the list; ?worshipbad=1 puts an unplayable video first.
const worshipVideos =
  testing && qs.get('noworship') === '1'
    ? []
    : testing && qs.get('worshipbad') === '1'
      ? [{ id: 'xxxxxxxxxxx', title: '없는 영상 (테스트)' }, ...WORSHIP_VIDEOS]
      : WORSHIP_VIDEOS;
const worship = new WorshipPlayer(worshipVideos);
const applyWorshipVolume = () => worship.setVolume(audio.settings.worship, audio.settings.worshipMuted, audio.settings.muted);
applyWorshipVolume();
audio.onSettingsChange(applyWorshipVolume);
// The player's own slider and mute button write the same settings as ⚙ 설정.
worship.onVolumeInput((v) => audio.update({ worship: v }));
worship.onMuteToggle((m) => audio.update({ worshipMuted: m }));
if (worshipVideos.length) void preloadYouTubeApi().catch(() => undefined);

// Track the visible viewport so sheets sit above the on-screen keyboard.
// Tablets: touch devices whose *screen* (not the current viewport, which the
// keyboard shrinks) is at least 600 px on its short side.
const touchCapable = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
const isTablet = touchCapable && Math.min(screen.width, screen.height) >= 600;
document.body.classList.toggle('tablet', isTablet);

function syncViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  root.setProperty('--vvh', `${vv ? vv.height : window.innerHeight}px`);
  root.setProperty('--vvtop', `${vv ? vv.offsetTop : 0}px`);
  // How much of the layout viewport the on-screen keyboard covers (iOS keeps the
  // layout viewport and shrinks only the visual one; Android usually resizes both).
  const kb = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
  root.setProperty('--kb', `${Math.round(kb)}px`);
}
syncViewport();
window.visualViewport?.addEventListener('resize', syncViewport);
window.visualViewport?.addEventListener('scroll', syncViewport);
window.addEventListener('resize', syncViewport);

const params = new URLSearchParams(location.search);
// Results of the OAuth redirect (?login=ok|nickname, ?login_error=code): read, then tidy the URL.
const loginError = params.get('login_error');
if (params.has('login') || params.has('login_error')) {
  params.delete('login');
  params.delete('login_error');
  const q = params.toString();
  history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}${location.hash}`);
}
// Test-only: ask the server for another day's word (ignored unless the server allows it).
const testDate = params.get('test') === '1' && /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date') : null;
let game: Game | null = null;

/** Ask for a nickname, connect, and only then build the world (seed comes from the server). */
async function enter(): Promise<void> {
  const [me, authConfig] = await Promise.all([getMe(), getAuthConfig()]);
  entry.setup(me, authConfig, loginError);
  for (;;) {
    const choice = await entry.ask();
    // Start worship inside the 입장 tap (same task, before any network wait) so
    // the browser still counts it as user-initiated. Skipped if the user closed
    // the player before; the HUD 찬양 button brings it back.
    if (worshipVideos.length && !worship.userClosed && !worship.isOpen) worship.open();
    let net: NetClient | null = null;
    let welcome: Welcome | null = null;
    if (choice.mode !== 'solo') {
      // Signed-in sockets are identified by the session cookie; the nickname here only matters for guests.
      net = new NetClient(resolveServerUrl(), choice.nickname, testDate, params.get('test') === '1');
      try {
        welcome = await net.connect();
      } catch (err) {
        net.close();
        const refused = err instanceof JoinRefused ? err : new JoinRefused('unreachable', '서버에 연결할 수 없어요.');
        const offerSolo = refused.code === 'unreachable' || refused.code === 'full';
        entry.showError(refused.message, offerSolo);
        continue;
      }
    }
    entry.hide();
    document.getElementById('loading')!.hidden = false;
    // Let the loading card paint before the synchronous world build.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    const store: WordBookStore =
      choice.mode === 'account' ? new ServerWordBookStore() : choice.mode === 'guest' ? new GuestWordBookStore() : new LocalWordBookStore();
    // First-time guide: once per account (server flag) or once per device for guests.
    // ?test=1&noguide=1 suppresses it for automated tests.
    let guideSeenHere = false;
    try {
      guideSeenHere = localStorage.getItem('worlds.guide.seen') === '1';
    } catch {
      /* ignore */
    }
    const suppressGuide = params.get('test') === '1' && params.get('noguide') === '1';
    const meNow = choice.mode === 'account' ? await getMe() : null;
    const guideDue = !suppressGuide && (choice.mode === 'account' ? !meNow?.user?.onboarded : !guideSeenHere);
    game = new Game(canvas!, {
      net,
      welcome,
      audio,
      worship,
      store,
      account: choice.mode === 'account' ? { id: choice.userId, nickname: choice.nickname } : null,
      guideDue,
      pushEnabled: authConfig.push === true,
    });
    game.start();
    return;
  }
}

void enter();

if (import.meta.hot) {
  import.meta.hot.dispose(() => game?.dispose());
}
