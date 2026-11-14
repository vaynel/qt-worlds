/**
 * 개인정보처리방침 (/privacy) and 이용약관 (/terms) as static HTML.
 *
 * Rendered at build time by vite.config.ts (plugin "worlds-legal") into
 * dist/privacy.html and dist/terms.html, and on the fly by the dev/preview
 * servers. No scripts: the pages work offline (precached by the service
 * worker) and under the strict CSP. Operator details come from
 * src/config/legal.ts.
 *
 * Every statement here describes what the code actually does. When the code
 * changes (new data, new third party, new retention), change this text too.
 */
import { FOOTPRINT_KEEP_DAYS, SHOTS_PER_DAY, STORIES_PER_DAY, STORY_HIDE_REPORTS, GROUP_CHAT_DAYS, MIN_AGE, OUTFIT_BAN_DAYS, OUTFIT_HIDE_REPORTS, OUTFIT_SIZE, OUTFIT_STRIKES_BAN, PROP_IDS, PROPS, SHOP_DAILY_LIMIT, SHOP_MAX_ACTIVE, SHOP_WINDOWS, VOICE_KICK_BLOCK_MS, VOICE_MAX, VOICE_MUTE_MS, VOICE_MUTE_REPEAT_MS, VOICE_REPORT_WINDOW_MS, VOICE_REPORTS_TO_MUTE, CAMPFIRE } from '../../../shared/protocol';
import { PRIVACY_PATH, TERMS_PATH, type LegalConfig } from '../config/legal';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Lanterns stay on the hill this many days (server/src/services.ts LANTERN_DAYS). */
const LANTERN_DAYS = 3;
/** A replaced or emptied drawing that was reported is kept this long after its last report (server/src/looks.ts). */
const REPORTED_OUTFIT_KEEP_DAYS = 30;
/** Same as RENTAL_KEEP_DAYS in server/src/shop.ts. */
const RENTAL_KEEP_DAYS = 30;
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const SHOP_HOURS = SHOP_WINDOWS.map((w) => `${hm(w.start)}–${hm(w.end)}`).join(', ');
/** Newest backups kept (server/scripts/backup.mjs BACKUP_KEEP default). */
const BACKUP_KEEP = 14;
/** Same as VOICE_REPORT_KEEP_DAYS / VOICE_SANCTION_KEEP_DAYS in server/src/campfireVoice.ts. */
const VOICE_REPORT_KEEP_DAYS = 90;
const VOICE_SANCTION_KEEP_DAYS = 365;
const VOICE_MUTE_H = VOICE_MUTE_MS / 3_600_000;
const VOICE_MUTE_REPEAT_D = VOICE_MUTE_REPEAT_MS / 86_400_000;
const VOICE_WINDOW_MIN = VOICE_REPORT_WINDOW_MS / 60_000;

function koreanDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[1])}년 ${Number(m[2])}월 ${Number(m[3])}일` : iso;
}

/** A table that turns into stacked cards on narrow screens (labels from data-label). */
function table(head: string[], rows: string[][]): string {
  const th = head.map((h) => `<th scope="col">${h}</th>`).join('');
  const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td data-label="${esc(head[i].replace(/<[^>]+>/g, ''))}">${c}</td>`).join('')}</tr>`).join('\n');
  return `<div class="table"><table><thead><tr>${th}</tr></thead><tbody>\n${tr}\n</tbody></table></div>`;
}

const ext = (href: string, label: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;

const STYLE = `
:root{--ink:#4a3426;--ink-soft:#7a5c44;--paper:#fff8ea;--line:rgba(176,120,72,.28);--accent:#c8644a;--bg:#f2e6cf;color-scheme:light}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:linear-gradient(#f8eedb,#ecd9b8) fixed;background-color:var(--bg);color:var(--ink);
 font-family:'Pretendard','Noto Sans KR','Noto Sans CJK KR','Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif;
 line-height:1.7;font-size:16px;word-break:keep-all;overflow-wrap:anywhere}
.wrap{max-width:760px;margin:0 auto;padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) 40px max(16px,env(safe-area-inset-left))}
.top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:4px 0 14px}
.back{display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border-radius:999px;background:var(--accent);color:#fff8ea;font-weight:700;text-decoration:none;font-size:15px}
.back:focus-visible,a:focus-visible{outline:3px solid #f5c26b;outline-offset:2px}
.other{color:var(--ink-soft);font-size:14px}
.card{background:var(--paper);border:1px solid var(--line);border-radius:18px;box-shadow:0 6px 22px rgba(74,52,38,.12);padding:22px 18px}
h1{font-size:1.5rem;margin:0 0 4px;line-height:1.35}
.meta{margin:0 0 16px;color:var(--ink-soft);font-size:14px}
h2{font-size:1.12rem;margin:30px 0 8px;padding-top:12px;border-top:1px dashed var(--line);line-height:1.4}
h3{font-size:1rem;margin:18px 0 6px}
p{margin:8px 0}
ul,ol{margin:8px 0;padding-left:1.3em}
li{margin:4px 0}
a{color:#a2412f}
.summary{background:#fdf1d8;border:1px solid var(--line);border-radius:14px;padding:12px 16px;margin:14px 0}
.summary p{margin:4px 0}
.note{color:var(--ink-soft);font-size:14px}
.toc{font-size:15px;columns:2;column-gap:24px;padding-left:1.4em}
.toc li{break-inside:avoid}
.table{margin:10px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14.5px;line-height:1.6}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:#f6e6c8;font-weight:700}
.contact{background:#fdf1d8;border-radius:14px;padding:12px 16px}
footer{margin-top:22px;text-align:center;color:var(--ink-soft);font-size:14px}
@media (max-width:560px){
 .card{padding:18px 14px}
 .toc{columns:1}
 table,thead,tbody,tr,td{display:block;width:100%}
 thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
 tr{border:1px solid var(--line);border-radius:12px;margin:0 0 10px;background:#fffdf6;overflow:hidden}
 td{border:0;border-top:1px solid var(--line);padding:7px 12px}
 td:first-child{border-top:0;background:#f6e6c8;font-weight:700}
 td:not(:first-child)::before{content:attr(data-label);display:block;font-size:12.5px;font-weight:700;color:var(--ink-soft)}
}
@media print{body{background:#fff}.top{display:none}.card{box-shadow:none;border:0}}
`;

function page(cfg: LegalConfig, kind: 'privacy' | 'terms', title: string, body: string): string {
  const other = kind === 'privacy' ? `<a href="${TERMS_PATH}">이용약관 보기</a>` : `<a href="${PRIVACY_PATH}">개인정보처리방침 보기</a>`;
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f2e6cf">
<meta name="description" content="${esc(cfg.SERVICE_NAME)} ${title}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>${title} · ${esc(cfg.SERVICE_NAME)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<nav class="top" aria-label="이동">
<a class="back" href="/" id="legal-back">← ${esc(cfg.SERVICE_NAME)}로 돌아가기</a>
<span class="other">${other}</span>
</nav>
<main class="card" id="legal-${kind}">
<h1>${esc(cfg.SERVICE_NAME)} ${title}</h1>
<p class="meta">시행일 ${koreanDate(cfg.EFFECTIVE_DATE)} · 운영자 ${esc(cfg.OPERATOR_NAME)}</p>
${body}
</main>
<footer>${esc(cfg.SERVICE_NAME)} · ${esc(cfg.SERVICE_URL.replace(/^https?:\/\//, ''))} · 문의 ${esc(cfg.PRIVACY_CONTACT)}</footer>
</div>
</body>
</html>
`;
}

// =============================================================================
// 개인정보처리방침
// =============================================================================

export function renderPrivacy(cfg: LegalConfig): string {
  const op = esc(cfg.OPERATOR_NAME);
  const svc = esc(cfg.SERVICE_NAME);
  const mail = esc(cfg.PRIVACY_CONTACT);
  const officer = esc(cfg.PRIVACY_OFFICER_NAME);

  const body = `
<p>${op}(이하 “운영자”)는 ${svc}(${esc(cfg.SERVICE_URL)}, 이하 “서비스”)를 개인이 비영리로 운영합니다. 운영자는 「개인정보 보호법」에 따라 이용자의 개인정보를 보호하고, 관련 고충을 빠르게 처리하기 위해 다음과 같이 개인정보처리방침을 둡니다.</p>

<div class="summary" id="privacy-summary">
<p><strong>한눈에 보기</strong></p>
<p>· 로그인은 Google 계정으로 하며, Google 계정 식별값·이메일과 닉네임만 계정 정보로 저장해요. 비밀번호나 Google 프로필 사진·이름은 받지 않아요.</p>
<p>· 내가 쓴 묵상은 나만 볼 수 있어요. 등불·모임에 나눈 것만 정한 범위의 사람에게 보여요.</p>
<p>· 광고, 분석 도구, 추적 쿠키를 쓰지 않아요. 개인정보를 팔거나 다른 곳에 제공하지 않아요.</p>
<p>· 모닥불 이야기, 음성 기도방, 🔥 모닥불 공개 음성, 표현(🙏 같은 이모티콘)은 저장하거나 녹음하지 않아요. 모닥불 공개 음성은 Cloudflare 중계 서버만 거쳐서, 함께 듣는 분들끼리 서로의 IP 주소가 보이지 않아요.</p>
<p>· 꾸미기로 고른 내 모습과 옷에 그린 그림은 함께 있는 모든 분께 보여요. 불편한 그림은 신고할 수 있고, 탈퇴하면 함께 지워져요.</p>
<p>· 이야기 도서관에 꽂은 이야기와 일기는 내가 고른 범위(공개, 모임, 익명 공개, 나만)에만 보여요. 일기를 쓰기 위한 <strong>발자취</strong>(내 활동 기록)와 <strong>월드 안 사진</strong>은 나만 볼 수 있고, 발자취는 끌 수 있어요. 일기에 쓰이지 않은 발자취와 사진은 ${FOOTPRINT_KEEP_DAYS}일 뒤 지워져요. 일기는 정해진 문장 틀로 우리 서버에서만 만들고, 외부(AI 등)로 보내지 않아요. 책 아래에 남기는 <strong>답장 편지</strong>는 그 책을 볼 수 있는 분께 보이고(나만 보는 책에는 편지를 받을 수 없어요), 쓴 분이 언제든 지울 수 있어요.</p>
<p>· ⚙ 설정 → 계정에서 내 데이터를 내려받거나 회원 탈퇴를 할 수 있어요. 탈퇴하면 바로 지워지고, 백업에서도 약 ${BACKUP_KEEP}일 안에 사라져요.</p>
</div>

<ol class="toc">
<li><a href="#p1">처리하는 개인정보 항목</a></li>
<li><a href="#p2">처리 목적</a></li>
<li><a href="#p3">보유 기간과 파기</a></li>
<li><a href="#p4">제3자 제공</a></li>
<li><a href="#p5">처리 위탁과 국외 이전</a></li>
<li><a href="#p6">이용자의 권리와 행사 방법</a></li>
<li><a href="#p7">만 14세 미만 아동</a></li>
<li><a href="#p8">쿠키와 기기 저장소</a></li>
<li><a href="#p9">안전성 확보 조치</a></li>
<li><a href="#p10">개인정보 보호책임자</a></li>
<li><a href="#p11">권익 침해 구제 방법</a></li>
<li><a href="#p12">방침의 변경</a></li>
</ol>

<h2 id="p1">1. 처리하는 개인정보 항목과 수집 방법</h2>
${table(
  ['구분', '항목', '수집 방법'],
  [
    [
      '회원가입·로그인 (필수)',
      'Google 계정 고유 식별값(sub), 이메일 주소, 이메일 인증 여부',
      'Google 로그인 때 Google로부터 받아요. 이메일은 로그인할 때마다 최신 값으로 바뀌어요. Google 이름·프로필 사진, 비밀번호, Google 접근 토큰은 저장하지 않아요.',
    ],
    ['계정 (필수)', '닉네임, 약관 동의 일시와 동의한 버전, 사용 안내를 본 시각, 가입 일시', '가입할 때 이용자가 입력하거나 서비스가 기록해요.'],
    [
      '내가 쓴 것 (이용할 때)',
      `묵상(묵상·느낀 점·적용, 장소, 날짜), 나의 말씀 책(날짜별로 받은 말씀), 등불(나눈 묵상의 사본, 공개 범위, 익명 여부), 반응(아멘·기도하기·기록하기), 담아 둔 묵상(기록하기로 담은 다른 분 등불의 사본), 모임(이름, 참여 코드, 참여 일시, 모임장 여부), 모임 채팅 메시지와 읽은 위치`,
      '이용자가 직접 작성하거나 누를 때 저장돼요.',
    ],
    [
      '꾸미기 (선택)',
      `내 모습 설정(겉옷·목도리·피부·머리색과 머리 모양: 정해진 목록의 번호), 옷 그림(${OUTFIT_SIZE}×${OUTFIT_SIZE}칸 그림, 최대 3개, 정해진 16색의 번호로 저장)과 지금 입은 그림, 내가 한 옷 그림 신고(어떤 그림인지, 이유, 일시), 내 그림이 신고로 숨겨진 횟수와 그림 올리기 제한 기간`,
      '로그인한 분이 ⚙ 설정 → 👕 꾸미기에서 고르거나 그려서 저장할 때, 🚩 옷 신고를 할 때 저장돼요. 그림은 이미지 파일로 올리지 않고 칸마다 색 번호만 저장해요.',
    ],
    [
      '나눔 소품 가게 대여 기록 (선택)',
      '빌린 소품, 빌린 날짜와 시간대, 시작·끝나는 시각, 반납·만료 여부, 만료 알림을 보낸 시각, 날짜별 대여 횟수, 대여 요청 번호(같은 요청이 두 번 처리되지 않게 하는 임의의 번호)와 그 결과(빌림, 품절 등)',
      '로그인한 분이 가게에서 [빌리기]나 [반납]을 누를 때 저장돼요.',
    ],
    [
      '이야기 도서관 (선택)',
      `나의 하나님 이야기(제목, 세 가지 질문에 쓴 답, 관련 성경 구절, 공개 범위와 모임, 쓴 날짜, 주제별 서가가 있던 때 쓴 이야기는 그때 고른 서가), 오늘의 일기(일기 문장, ✏️ 오늘 한 줄, 넣기로 고른 사진, 그날의 말씀, 공개 범위), 쓰던 이야기의 임시 저장 1개, 공감(은혜받았어요·저도 그랬어요·함께 기도해요), 책갈피, 읽은 책(읽은 사람 수를 한 번만 세기 위해), 내가 한 책 신고(어떤 책인지, 이유, 일시), 내 책이 받은 신고 수와 숨김 여부, 글쓰기 제한 기간, 답장 편지(어느 책에 쓴 편지인지, 편지와 답장 내용, 익명으로 보냈는지, 쓴 시각, 지운 시각, 신고나 글쓴이의 숨김 여부, 같은 편지가 두 번 보내지지 않게 하는 임의의 요청 번호), 내가 한 편지 신고, 받은 편지를 어디까지 읽었는지(여러 기기에서 읽음 표시를 맞추기 위해)`,
      '로그인한 분이 도서관에서 쓰거나 누를 때 저장돼요.',
    ],
    [
      '발자취 (선택, 끌 수 있음)',
      '날짜별 활동 기록: 접속해 머문 시간(분 단위), 오늘의 편지를 연 시각, 묵상을 담은 곳과 그 묵상의 앞부분(약 40자), 기도의 뜰 자리·모닥불 곁·음성 기도방·도서관에 있던 시간(분 단위, 모닥불은 그때 곁에 있던 사람 수만), 읽은 등불과 남긴 반응(등불 번호와 반응 종류만), 앉은 자리 종류(벤치·통나무·책상), 빌린 소품, 도서관에서 읽은 책(번호), 찍은 사진(번호), 표현을 보낸 횟수(어떤 표현인지, 누가 봤는지는 남기지 않음). 다른 분의 이름, 모닥불에서 나눈 말, 음성은 기록하지 않아요. 모닥불 공개 음성에 있던 시간은 모닥불 곁에 있던 시간으로만 남아요.',
      '로그인한 분이 QT 월드를 쓰는 동안 서버가 자동으로 기록해요(같은 일은 한 번만). ⚙ 설정 → 📔 발자취에서 끄거나 오늘 기록을 지울 수 있어요.',
    ],
    [
      '월드 안 사진 (선택)',
      `카메라 버튼으로 찍은 게임 화면 이미지(WebP 또는 JPEG, 최대 1280px, 날짜·시각·장소·닉네임 도장이 찍힘), 찍은 곳, 크기, 찍은 시각, 날짜별 찍은 수(하루 ${SHOTS_PER_DAY}장까지)`,
      '카메라 버튼(PC는 P 키)을 누를 때 저장돼요. 게임 화면만 담기며 실제 카메라, 얼굴, 위치 정보는 쓰지 않아요. 화면의 버튼은 사진에 들어가지 않아요.',
    ],
    [
      '모닥불 음성 신고와 말하기 제한',
      '신고한 분과 신고받은 분의 계정, 신고 이유(욕설·혐오, 음란, 괴롭힘, 기타), 신고 시각, 말하기 제한(몇 번째인지, 시작·끝 시각, 운영자가 푼 시각). 목소리는 녹음하지 않으므로 신고에 음성은 담기지 않아요.',
      '로그인한 분이 🔥 모닥불 공개 음성에서 🚩 음성 신고를 할 때 저장되고, 정해진 기준에 따라 말하기 제한이 기록돼요. 신고한 분이 누구인지는 신고받은 분에게 알리지 않아요.',
    ],
    [
      '알림 (선택)',
      '웹 푸시 구독 정보(브라우저의 푸시 서비스 주소와 암호화 키), 기기 종류를 알 수 있는 브라우저 정보(User-Agent 앞 80자), 알림 설정(오늘의 말씀 알림과 시각, 기도 알림, 소품 만료 알림, 내 이야기 소식·새 편지·답장 알림, 밤 일기 알림과 시각, 밤 일기 알림을 보낸 날짜), 책별 공감 알림을 마지막으로 보낸 시각(30분에 한 번만 보내기 위해), 마지막으로 알림이 전달된 시각',
      '⚙ 설정 → 🔔 알림에서 알림을 켤 때만 저장돼요.',
    ],
    [
      '자동으로 생기는 정보',
      '로그인 세션 쿠키(서버에는 토큰의 해시값만 저장), 로그인 과정용 임시 쿠키, 접속 IP 주소, 서버 운영 기록(로그)',
      `IP 주소는 과도한 요청을 막기 위해 서버 메모리에서만 잠시 쓰고 파일로 남기지 않아요. 운영 기록에는 입장·퇴장할 때의 닉네임, 모닥불 이야기의 글자 수(내용은 남기지 않음), 음성 기도방에 들어간 닉네임과 모임 번호, 모닥불 음성에 들어간 닉네임, 오류 내용이 남아요.`,
    ],
  ],
)}
<h3>저장하지 않는 것</h3>
<ul>
<li><strong>모닥불 이야기</strong>: 그때 모닥불 가까이에 있는 분들께만 실시간으로 전달되고, 내용은 서버에 저장하거나 기록하지 않아요.</li>
<li><strong>음성 기도방</strong>: 녹음하거나 저장하지 않아요. 목소리는 참여자 기기끼리 직접(P2P) 오가고, 직접 연결이 안 될 때만 Cloudflare의 중계 서버(TURN)를 거쳐요. 이때도 음성은 암호화되어 있어요. 직접 연결 방식이라 같은 방 참여자의 기기에는 서로의 IP 주소가 전달될 수 있어요.</li>
<li><strong>🔥 모닥불 공개 음성</strong>: 모닥불 가까이(반경 ${CAMPFIRE.chatRadius}m 안이나 통나무 자리)에 있는, 로그인하고 약관에 동의한 분들이 함께 듣는 공개 대화예요. 녹음하거나 저장하지 않고, 서버는 음성을 전혀 다루지 않아요(연결 신호만 전달해요). 모르는 분끼리 IP 주소를 알 수 없도록 목소리는 언제나 Cloudflare의 중계 서버(TURN)만 거쳐 암호화된 채로 오가며, 직접(P2P) 연결로 바뀌지 않아요. 중계 서버를 쓸 수 없을 때는 모닥불 음성을 열지 않아요.</li>
<li><strong>표현(이모티콘)</strong>: 🙏 기도해요 같은 정해진 표현은 그때 같은 공간(월드 또는 도서관)에 있는 분들께만 실시간으로 보이고, 저장하지 않아요(발자취를 켠 경우 보낸 횟수만 남아요). 골방에서는 보내지 않아요.</li>
<li><strong>게임 속 위치와 움직임</strong>: 접속한 동안 다른 분 화면에 보여 주기 위해서만 쓰고 저장하지 않아요. 발자취에는 어디에 몇 분 있었는지만 남고 좌표는 남지 않아요.</li>
<li><strong>오늘의 일기 만들기</strong>: 발자취로 일기 문장을 만들 때 정해진 한국어 문장 틀만 쓰며, 이 서버 밖(AI 서비스 등)으로 보내지 않아요.</li>
<li><strong>로그인 없이 둘러보기</strong>: 닉네임을 계정으로 저장하지 않아요(위의 입장·퇴장 운영 기록에만 남아요). 이 기기에서 쓴 내용은 이 기기에만 저장돼요(8번 참고).</li>
</ul>
<p class="note">서비스는 종교·신앙에 관한 정보를 따로 묻거나 항목으로 모으지 않아요. 다만 이용자가 직접 쓰는 묵상·기도 내용에 신앙에 관한 내용이 담길 수 있으며, 그 내용은 이용자가 정한 범위(나만 보기, 모임, 공개)에서만 보여요.</p>

<h2 id="p2">2. 처리 목적</h2>
<ul>
<li><strong>계정 확인과 로그인 유지</strong>: Google 식별값으로 같은 분인지 확인하고, 세션 쿠키로 로그인 상태를 유지해요. 이메일은 계정 확인과 문의 응대에만 쓰고 광고·홍보 메일을 보내지 않아요.</li>
<li><strong>서비스 제공</strong>: 묵상과 말씀 책 저장, 등불·반응·모임·모임 채팅 기능, 닉네임 표시, 꾸미기(내 모습과 옷 그림을 다른 분 화면에 보여 주기).</li>
<li><strong>나눔 소품 가게</strong>: 시간대마다 정해진 수량을 공평하게 나누고(하루 대여 횟수와 동시에 쓰는 소품 수 확인), 빌린 소품을 사용 시간 동안 내 모습에 보여 주고, 같은 요청이 두 번 처리되지 않게 하기 위해서예요.</li>
<li><strong>이야기 도서관</strong>: 이야기와 일기를 정한 범위의 사람에게 보여 주기, 공감·책갈피·읽은 사람 수 보여 주기, 발자취로 오늘의 일기 초안 만들기, 고른 사진을 일기와 함께 보여 주기, 답장 편지 주고받기와 받은 편지 읽음 표시, 신고 처리.</li>
<li><strong>알림</strong>: 이용자가 켠 경우에만 오늘의 말씀 알림, “누군가 기도하고 있어요” 알림, 빌린 소품이 끝나기 10분 전 알림, 내 이야기에 공감이 모였다는 알림(누가 했는지는 알리지 않아요), 새 편지·답장 알림(편지 내용과 보낸 분의 이름은 담지 않아요), 밤 일기 알림(기본은 꺼짐)을 보내요.</li>
<li><strong>안전한 운영</strong>: 과도한 요청·부정 이용 방지, 옷 그림 신고 처리(숨기기, 운영자 검토, 그림 올리기 제한), 오류 확인, 장애 복구(백업).</li>
</ul>

<h2 id="p3">3. 보유 기간과 파기</h2>
<p>개인정보는 아래 기간이 지나거나 목적을 이루면 지체 없이 파기해요. 법령에 따라 따로 보관해야 하는 정보는 없어요(결제·광고가 없는 무료 서비스).</p>
${table(
  ['정보', '보유 기간'],
  [
    ['계정 정보, 묵상, 나의 말씀 책, 담아 둔 묵상, 모임 참여', '회원 탈퇴 때까지. 탈퇴하면 바로 삭제해요. 각각은 언제든 앱에서 직접 지울 수 있어요.'],
    [
      '내 모습 설정, 옷 그림',
      `회원 탈퇴 때까지. 그림 칸을 비우거나 다른 그림으로 바꾸면 이전 그림은 바로 삭제해요. 다만 신고를 받은 그림은 검토를 위해 마지막 신고 뒤 ${REPORTED_OUTFIT_KEEP_DAYS}일 동안 보관했다가 삭제해요(다른 분께는 보이지 않음).`,
    ],
    ['옷 그림 신고, 숨겨진 횟수, 그림 올리기 제한', '신고한 분이나 그림 주인이 탈퇴할 때, 또는 그 그림이 삭제될 때 함께 삭제해요. 숨겨진 횟수와 제한 기간은 탈퇴 때까지 보관해요.'],
    ['등불과 등불에 남긴 반응', `${LANTERN_DAYS}일 동안 등불 언덕에 보이고, 그 뒤 약 하루 안에 삭제해요. 직접 내린 등불(묵상을 지워서 함께 내려간 등불 포함)은 하루 동안 남았다가(하루 10개 제한 확인용, 다른 분께는 보이지 않음) 삭제해요.`],
    ['모임 채팅', `${GROUP_CHAT_DAYS}일이 지나면 자동으로 삭제해요. 내가 지운 메시지는 내용을 바로 지워요. 모임장이 가린 메시지도 ${GROUP_CHAT_DAYS}일 뒤 삭제돼요.`],
    ['나눔 소품 가게 대여 기록', `대여가 끝난 날(반납 또는 만료)로부터 ${RENTAL_KEEP_DAYS}일 뒤 자동으로 삭제해요. 회원 탈퇴하면 바로 삭제해요.`],
    ['이야기 도서관의 이야기와 일기, 공감, 책갈피, 임시 저장', '작성자가 빼거나(삭제) 회원 탈퇴할 때까지. 신고로 숨겨진 책은 운영자가 살펴볼 때까지 작성자에게만 보이며, 운영자가 삭제할 수 있어요. 책 신고와 읽은 기록은 그 책이나 신고한 분의 계정이 지워질 때 함께 삭제해요.'],
    ['답장 편지', '쓴 분이 지우면 내용을 바로 지우고 “삭제된 편지예요”만 남겨요. 책이 빠지거나(삭제), 편지를 쓴 분이나 책을 쓴 분이 탈퇴하면 그 편지와 아래 답장(상대방의 답장 포함)을 모두 삭제해요. 신고로 숨겨진 편지는 운영자가 살펴본 뒤 복구하거나 삭제해요. 편지 신고와 읽음 표시는 그 편지나 해당 계정이 지워질 때 함께 삭제해요.'],
    ['발자취', `날짜마다 ${FOOTPRINT_KEEP_DAYS}일 뒤 자동으로 삭제해요. 그날의 일기를 꽂았다면 그 일기가 있는 동안 함께 보관하고, 일기를 빼면 ${FOOTPRINT_KEEP_DAYS}일 기준에 따라 삭제해요. 끄면 그때부터 기록하지 않고, “오늘 기록 지우기”로 바로 지울 수 있어요.`],
    ['월드 안 사진', `찍은 지 ${FOOTPRINT_KEEP_DAYS}일이 지나면 자동으로 삭제해요(파일과 기록 모두). 일기에 넣은 사진은 그 일기가 있는 동안 보관해요. 나의 서재 → 오늘 앨범에서 언제든 지울 수 있어요. 사진 파일도 백업에 보관하며, 지운 사진은 그 사진을 담은 마지막 백업이 지워질 때(약 ${BACKUP_KEEP}일 안에) 백업에서도 사라져요.`],
    ['로그인 세션', '“로그인 유지”를 켜면 30일, 끄면 12시간. 로그아웃하거나 만료되면 삭제해요.'],
    ['알림 구독 정보', '알림을 끄거나, 브라우저가 구독을 끊었다고 푸시 서비스가 알려 오거나, 탈퇴하면 바로 삭제해요.'],
    ['가입을 마치지 않은 계정', 'Google 로그인 뒤 닉네임을 정하지 않고(약관 동의 없이) 떠난 경우, 하루 뒤 삭제해요.'],
    ['모닥불 음성 신고와 말하기 제한', `신고는 ${VOICE_REPORT_KEEP_DAYS}일 뒤, 말하기 제한 기록은 끝나거나 풀린 지 ${VOICE_SANCTION_KEEP_DAYS}일 뒤 자동으로 삭제해요(다시 신고가 쌓였을 때 기간을 정하기 위해). 신고한 분이나 신고받은 분이 탈퇴하면 바로 삭제해요.`],
    ['접속 IP 주소', '서버 메모리에서 요청 제한에 필요한 동안만 쓰고 몇 시간 안에 지워져요(서버를 다시 시작해도 사라져요). 파일이나 데이터베이스에는 남기지 않아요.'],
    ['서버 운영 기록(로그)', '용량 기준(10MB 파일 3개)으로 돌려 쓰며, 오래된 기록부터 자동으로 지워져요.'],
    ['백업', `장애에 대비해 데이터베이스와 월드 안 사진 파일을 하루 한 번 백업하고, 데이터베이스는 가장 최근 ${BACKUP_KEEP}개만 남겨요. 사진은 남아 있는 백업 중 하나라도 그 사진을 담고 있을 때만 보관해요. 그래서 지운 정보와 사진도 약 ${BACKUP_KEEP}일 안에 백업에서까지 사라져요. 백업은 복구 외의 목적으로 쓰지 않아요.`],
  ],
)}
<p><strong>파기 방법</strong>: 전자 파일 형태로만 보관하며, 데이터베이스에서 삭제할 때 지운 자리를 덮어써서 다시 살릴 수 없게 해요. 종이 문서는 만들지 않아요.</p>
<p><strong>회원 탈퇴 때 지워지는 것</strong>: 계정, 묵상, 나의 말씀 책, 내 등불(모든 분의 화면에서 바로 꺼지고, 다른 분이 기록하기로 담아 둔 사본도 함께 삭제), 내가 남긴 반응(반응 수가 줄어요), 담아 둔 묵상, 알림 구독, 로그인 세션, 음성 기도방 참여, 내 모임 채팅 메시지, 내 모습 설정과 옷 그림(내 그림에 대한 신고 포함), 내가 한 옷 그림 신고, 신고로 숨겨진 횟수와 그림 올리기 제한, 나눔 소품 가게 대여 기록(빌려 쓰던 소품은 바로 사라지고 수량은 돌아오지 않아요), 이야기 도서관의 내 이야기와 일기(다른 분이 남긴 공감·책갈피·편지와 답장 포함), 내가 남긴 공감·책갈피·책 신고·읽은 기록, 내가 쓴 답장 편지(그 편지 아래 이어진 상대방의 답장까지 대화 전체), 내가 한 편지 신고와 읽음 표시, 모닥불 음성 신고(내가 한 신고와 나에 대한 신고)와 말하기 제한, 임시 저장, 발자취, 월드 안 사진(서버의 사진 파일까지), 지금 함께하는 모임에서 내 닉네임이 들어간 안내 문구(“○○님이 모임에 함께했어요” 등), 모임 참여. 내가 만든 모임은 가장 오래 함께한 분이 모임장이 되고, 남은 분이 없으면 모임도 삭제돼요. 닉네임은 다른 분이 다시 쓸 수 있게 돼요.</p>

<h2 id="p4">4. 개인정보의 제3자 제공</h2>
<p>운영자는 이용자의 개인정보를 제3자에게 제공하지 않아요. 다만 법률에 특별한 규정이 있거나 수사기관 등이 법령에 정해진 절차에 따라 요구하는 경우에는 그 범위에서만 제공할 수 있어요.</p>
<p class="note">서비스 안에서 이용자가 직접 나누는 것(공개 등불, 모임 등불과 채팅, 닉네임)은 이용자가 정한 범위의 다른 이용자에게 보여요. 내 모습과 옷 그림은 그때 함께 있는 모든 분(로그인하지 않은 분 포함)께 보여요. 옷 그림을 신고해도 신고한 분이 누구인지는 그림 주인에게 알려지지 않아요(운영자는 신고 기록을 볼 수 있어요). 익명 등불은 다른 분께 닉네임이 보이지 않지만, 서버에는 작성자가 기록돼 있어요(본인 확인과 삭제를 위해). 이야기 도서관의 책은 공개(누구나), 모임(그 모임 사람만), 익명 공개(누구나, 닉네임 대신 “익명의 성도”), 나만(나만) 중 고른 범위에만 보여요. 익명 책의 작성자는 신고 처리를 위해 운영자만 볼 수 있어요. 발자취와 사진은 나만 볼 수 있고, 일기에 넣기로 고른 사진만 그 일기의 공개 범위에 따라 보여요. 답장 편지는 그 책을 볼 수 있는 분께 보여요. 익명 책의 글쓴이는 편지 대화에서도 “글쓴이”로만, 익명으로 보낸 편지는 “익명의 성도”로만 보이고, 서버에는 쓴 분이 기록돼 있어요(본인 확인, 삭제, 신고 처리를 위해 운영자만 볼 수 있어요).</p>

<h2 id="p5">5. 개인정보 처리 위탁과 국외 이전</h2>
<p>서비스 서버와 데이터베이스는 운영자가 직접 관리하는 대한민국 내 서버에 있어요. 다만 서비스를 제공하기 위해 아래 해외 사업자의 서비스를 이용하며, 그 과정에서 아래 정보가 네트워크를 통해 국외로 전송돼요. 이전을 원하지 않으면 해당 기능을 쓰지 않거나(알림 끄기, 음성 기도방·모닥불 음성 쓰지 않기) 회원 탈퇴를 할 수 있어요. 다만 Cloudflare를 거치지 않고는 서비스에 접속할 수 없어요.</p>
${table(
  ['이전받는 자 (국가)', '이전되는 정보', '목적', '시기와 방법', '보유 기간'],
  [
    [
      'Cloudflare, Inc. (미국 및 Cloudflare 데이터센터 소재국)',
      '접속 IP 주소, 브라우저 정보, 주고받는 요청 내용(서비스로 전달하는 동안), 음성 기도방 중계 시와 모닥불 공개 음성(항상 중계)의 암호화된 음성 데이터',
      '보안 연결(HTTPS) 제공, 서비스 서버로 연결(Cloudflare Tunnel), 음성 기도방 연결을 위한 STUN/TURN 중계, 모닥불 공개 음성의 TURN 중계(참여자끼리 IP 주소가 보이지 않게)',
      '서비스에 접속할 때마다, 음성 기도방·모닥불 음성 이용 시 네트워크로 전송',
      `Cloudflare의 처리방침에 따름. 운영자는 별도 보관을 요청하지 않아요. ${ext('https://www.cloudflare.com/privacypolicy/', 'Cloudflare 개인정보처리방침')}`,
    ],
    [
      'Google LLC (미국) — Google 로그인',
      'Google 로그인 화면에서 이용자가 Google에 직접 입력하는 정보, 로그인 요청 정보',
      '본인 확인(로그인)',
      '로그인할 때 이용자의 브라우저가 Google로 이동',
      `Google의 처리방침에 따름. ${ext('https://policies.google.com/privacy', 'Google 개인정보처리방침')}`,
    ],
    [
      '웹 푸시 서비스: Google(Firebase Cloud Messaging), Apple(Apple Push Notification service), Mozilla(Mozilla Push Service), Microsoft(Windows Push Notification Services) (모두 미국) — 이용자의 브라우저가 쓰는 곳 하나',
      '브라우저가 만든 푸시 구독 주소, 알림 내용(암호화되어 있어 푸시 서비스는 내용을 볼 수 없음), 전송 시각',
      '알림 전달',
      '알림을 켠 분께 알림을 보낼 때 네트워크로 전송',
      '각 푸시 서비스의 처리방침에 따름(알림이 전달되거나 만료되면 삭제)',
    ],
  ],
)}
<p class="note">월드의 날씨는 서비스 서버가 ${ext('https://api.met.no/', '노르웨이 기상청(MET Norway)')}에서 서울(고정된 좌표)의 날씨를 15분 이상의 간격으로 받아 와서 보여 드려요. 이때 이용자에 관한 정보는 어떤 것도 보내지 않으며, 이용자의 기기는 날씨 서비스에 직접 접속하지 않아요.</p>

<h2 id="p6">6. 이용자의 권리와 행사 방법</h2>
<p>이용자는 언제든 자신의 개인정보를 열람·정정·삭제하거나 처리 정지를 요구할 수 있어요. 대부분은 앱에서 바로 할 수 있고, 이메일(${mail})로 요청할 수도 있어요. 이메일 요청은 본인 확인(가입한 Google 계정 이메일로 보내 주시면 돼요) 뒤 10일 안에 처리하고 결과를 알려 드려요. 법정대리인이나 위임받은 분도 위임장을 함께 보내 주시면 요청할 수 있어요.</p>
${table(
  ['권리', '앱에서 하는 방법'],
  [
    ['열람', '⚙ 설정 → 계정 → <strong>내 데이터 내려받기</strong>: 계정, 말씀 책과 묵상, 등불, 반응, 담아 둔 묵상, 모임, 내 모임 채팅, 알림 설정, 내 모습과 옷 그림, 내가 한 옷 그림 신고, 이야기 도서관의 내 책·공감·책갈피·읽은 책·책 신고·임시 저장, 내가 쓴 답장 편지와 편지 신고, 발자취, 월드 안 사진(이미지 포함)을 JSON 파일로 받아요. 나의 서재에서도 내 책과 사진을 볼 수 있어요.'],
    ['정정', '⚙ 설정 → 계정에서 <strong>닉네임 바꾸기</strong>, 말씀 → 📖 나의 말씀 책의 지난 말씀에서 <strong>묵상 고치기</strong>. 이메일은 Google 계정에서 바꾸면 다음 로그인 때 반영돼요.'],
    ['삭제', '말씀 → 📖 나의 말씀 책에서 <strong>묵상 지우기</strong>·담아 둔 묵상 빼기, 등불 <strong>내리기</strong>, 이야기 도서관에서 내 책 <strong>빼기</strong>, 내가 쓴 답장 편지 <strong>지우기</strong>, 나의 서재 → 오늘 앨범에서 사진 지우기, ⚙ 설정 → 📔 발자취 → <strong>오늘 기록 지우기</strong>, 모임 채팅 메시지 지우기, 모임 나가기, ⚙ 설정 → 👕 꾸미기에서 옷 그림 칸 비우기, ⚙ 설정 → 계정 → <strong>회원 탈퇴</strong>'],
    ['처리 정지·동의 철회', '⚙ 설정 → 📔 발자취에서 <strong>발자취 기록 끄기</strong>, ⚙ 설정 → 🔔 알림에서 <strong>알림 끄기</strong>(종류별로 끌 수 있어요), 모임 나가기, <strong>회원 탈퇴</strong>(동의 철회). 로그인 없이 둘러보기로도 이용할 수 있어요.'],
  ],
)}
<p class="note">다른 법령에서 보관하도록 정한 정보는 삭제를 요구할 수 없지만, 서비스에는 그런 정보가 없어요. 요청을 거절하거나 일부만 처리할 때는 이유와 이의 제기 방법을 알려 드려요.</p>

<h2 id="p7">7. 만 14세 미만 아동의 개인정보</h2>
<p>회원가입은 만 ${MIN_AGE}세 이상만 할 수 있어요. 가입할 때 만 ${MIN_AGE}세 이상임을 확인받으며, 만 ${MIN_AGE}세 미만 아동의 개인정보를 알면서 수집하지 않아요(법정대리인 동의 절차를 두지 않아요). 만 ${MIN_AGE}세 미만 아동이 가입한 사실을 알게 되면 해당 계정과 정보를 지체 없이 삭제해요. 보호자께서 알게 되시면 ${mail}로 알려 주세요.</p>

<h2 id="p8">8. 쿠키와 기기 저장소</h2>
<p>서비스는 광고·분석·추적 쿠키를 쓰지 않아요. 로그인과 앱 동작에 꼭 필요한 것만 써요.</p>
${table(
  ['이름', '무엇을, 왜', '기간'],
  [
    ['worlds_session (쿠키)', '로그인 상태 유지. 무작위 토큰이며 서버에는 그 해시값만 저장해요.', '로그인 유지: 30일 / 아니면 브라우저를 닫을 때까지(서버에서는 12시간)'],
    ['worlds_oauth (쿠키)', 'Google 로그인 요청을 이 브라우저와 묶어 위조를 막아요.', '10분'],
    ['기기 저장소 (localStorage)', '소리·채팅 창 설정, 둘러보기 닉네임, 사용 안내를 봤는지, 쓰던 묵상 임시 저장, 로그인하지 않고 혼자 둘러볼 때 쓴 말씀 책, 오늘 편지를 열었는지, 설치 안내를 봤는지. 이 기기 안에만 있고 서버로 보내지 않아요(로그인 뒤 “옮기기”를 누를 때만 내 계정으로 올라가요).', '직접 지울 때까지'],
    ['세션 저장소 (sessionStorage)', '약관 동의 안내를 이번 방문에 이미 보여 드렸는지', '탭을 닫을 때까지'],
    ['서비스 워커 캐시', '앱 화면 파일(프로그램, 아이콘, 이 방침과 약관 페이지)을 저장해 빨리 열리고 연결이 끊겨도 열리게 해요. 개인정보는 담지 않아요.', '새 버전이 나오면 바뀌어요'],
  ],
)}
<p><strong>거부하는 방법</strong>: 브라우저 설정에서 쿠키를 막거나 이 사이트의 데이터를 지울 수 있어요(예: Chrome은 설정 → 개인정보 보호 및 보안 → 서드 파티 쿠키/사이트 데이터, Safari는 설정 → Safari → 고급 → 웹사이트 데이터). 쿠키를 막으면 로그인할 수 없지만, 로그인 없이 둘러보기는 할 수 있어요. 기기 저장소를 지우면 설정과 임시 저장한 글이 사라져요.</p>

<h2 id="p9">9. 안전성 확보 조치</h2>
<ul>
<li>모든 통신은 HTTPS로 암호화해요.</li>
<li>비밀번호를 받지 않고, Google 접근 토큰도 저장하지 않아요. 로그인 세션 토큰은 해시값으로만 저장해요.</li>
<li>필요한 최소한의 정보만 모으고, 기간이 지나면 자동으로 지워요(3번).</li>
<li>접근 통제: 묵상과 말씀 책은 본인만, 모임 등불과 채팅은 모임 사람만 볼 수 있도록 서버에서 확인해요. 서버와 데이터베이스, 백업에는 운영자만 접근할 수 있어요.</li>
<li>옷 그림은 이미지 파일을 받지 않고, 정해진 크기와 색 번호만 서버에서 확인해 저장해요. 화면에는 그 번호로 다시 그려 보여 줘요.</li>
<li>월드 안 사진은 파일의 형식(WebP·JPEG), 크기, 가로·세로 길이를 서버에서 확인하고, 추측할 수 없는 임의의 이름으로 저장해요. 사진과 도서관 책은 볼 수 있는 사람인지 서버가 요청마다 확인해요.</li>
<li>다른 사이트에서 보낸 요청 차단(Origin 확인), 과도한 요청 제한, 보안 헤더(CSP 등)를 적용해요.</li>
</ul>

<h2 id="p10">10. 개인정보 보호책임자</h2>
<div class="contact" id="privacy-officer">
<p>개인정보 보호책임자: <strong>${officer}</strong></p>
<p>연락처: <strong>${mail}</strong></p>
</div>
<p>개인정보와 관련한 문의, 불만, 피해 구제 요청은 위 연락처로 보내 주세요. 지체 없이 답변하고 처리할게요.</p>

<h2 id="p11">11. 권익 침해 구제 방법</h2>
<p>개인정보 침해에 대한 신고나 상담이 필요하면 아래 기관에 문의할 수 있어요.</p>
<ul>
<li>개인정보침해신고센터 (한국인터넷진흥원): ${ext('https://privacy.kisa.or.kr', 'privacy.kisa.or.kr')}, 국번 없이 118</li>
<li>개인정보 분쟁조정위원회: ${ext('https://www.kopico.go.kr', 'www.kopico.go.kr')}, 1833-6972</li>
<li>대검찰청 사이버수사과: ${ext('https://www.spo.go.kr', 'www.spo.go.kr')}, 국번 없이 1301</li>
<li>경찰청 사이버범죄 신고시스템: ${ext('https://ecrm.police.go.kr', 'ecrm.police.go.kr')}, 국번 없이 182</li>
</ul>

<h2 id="p12">12. 개인정보처리방침의 변경</h2>
<p>이 방침을 바꿀 때는 시행 7일 전부터 이 페이지와 서비스 화면에서 알려 드려요. 수집 항목이나 목적이 바뀌는 등 중요한 변경은 30일 전에 알리고, 다음 접속 때 다시 동의를 받아요.</p>
<p>이 방침은 <strong>${koreanDate(cfg.EFFECTIVE_DATE)}</strong>부터 시행해요.</p>
`;
  return page(cfg, 'privacy', '개인정보처리방침', body);
}

// =============================================================================
// 이용약관
// =============================================================================

export function renderTerms(cfg: LegalConfig): string {
  const op = esc(cfg.OPERATOR_NAME);
  const svc = esc(cfg.SERVICE_NAME);
  const mail = esc(cfg.PRIVACY_CONTACT);
  const kickMin = Math.round(VOICE_KICK_BLOCK_MS / 60000);

  const body = `
<div class="summary">
<p><strong>한눈에 보기</strong></p>
<p>· ${svc}는 함께 말씀을 묵상하는 무료·비영리 서비스예요. 광고와 결제가 없어요.</p>
<p>· 만 ${MIN_AGE}세 이상이면 Google 계정으로 가입할 수 있어요. 로그인 없이 둘러볼 수도 있어요.</p>
<p>· 내가 쓴 글의 권리는 나에게 있어요. 서비스는 그 글을 내가 정한 범위에 보여 주는 데만 써요.</p>
<p>· 서로를 존중해 주세요. 욕설, 혐오, 음란물, 스팸, 개인정보 노출, 저작권 침해, 사칭은 안 돼요. 옷에 그리는 그림도, 🔥 모닥불 공개 음성에서 하는 말도 마찬가지예요.</p>
<p>· 모닥불 공개 음성은 처음 만나는 분과도 함께 듣는 공간이에요. 누구든 나만 음소거할 수 있고, 여러 분이 신고하면 일정 기간 말할 수 없게 돼요.</p>
</div>

<h2 id="t1">제1조 (목적)</h2>
<p>이 약관은 ${op}(이하 “운영자”)가 제공하는 ${svc}(${esc(cfg.SERVICE_URL)}, 이하 “서비스”)를 이용하는 데 필요한 운영자와 이용자의 권리, 의무와 책임을 정해요.</p>

<h2 id="t2">제2조 (서비스 소개)</h2>
<ol>
<li>서비스는 브라우저에서 여러 사람이 함께 쓰는 3D 공간에서 매일의 말씀(QT)을 읽고 묵상하고 나누는 서비스예요. 오늘의 말씀, 나의 말씀 책, 골방과 기도의 뜰, 등불 언덕(묵상 나눔), 모닥불 이야기와 🔥 모닥불 공개 음성, 표현(이모티콘), 모임과 모임 채팅, 음성 기도방, 알림, 꾸미기(내 모습과 옷 그림), 나눔 소품 가게(무료 소품 대여), 이야기 도서관(나의 하나님 이야기, 발자취로 쓰는 오늘의 일기, 월드 안 사진) 등을 제공해요.</li>
<li>서비스는 개인이 운영하는 <strong>비영리 서비스</strong>로 무료이며, 광고와 유료 기능이 없어요.</li>
</ol>

<h2 id="t3">제3조 (약관의 효력과 변경)</h2>
<ol>
<li>이 약관은 서비스 화면(${esc(cfg.SERVICE_URL)}${TERMS_PATH})에 게시해 효력이 생겨요.</li>
<li>운영자는 관련 법령을 어기지 않는 범위에서 약관을 바꿀 수 있어요. 바꿀 때는 시행 7일 전(이용자에게 불리한 변경은 30일 전)부터 서비스 화면에 알리고, 중요한 변경은 다음 접속 때 다시 동의를 받아요.</li>
<li>바뀐 약관에 동의하지 않으면 회원 탈퇴를 할 수 있어요.</li>
</ol>

<h2 id="t4">제4조 (회원가입과 계정)</h2>
<ol>
<li>회원가입은 <strong>만 ${MIN_AGE}세 이상</strong>만 할 수 있어요. 가입할 때 Google 계정으로 로그인하고, 닉네임을 정하고, 만 ${MIN_AGE}세 이상임을 확인하며 이 약관과 개인정보처리방침에 동의해요.</li>
<li>닉네임은 1~12자로, 다른 분과 겹칠 수 없어요. 다른 사람이나 단체로 오해될 닉네임, 욕설이나 혐오 표현이 담긴 닉네임은 쓸 수 없어요.</li>
<li>계정은 본인만 써야 하며, 로그인한 기기를 다른 사람이 쓰지 않도록 관리해 주세요. 계정이 도용된 것 같으면 바로 운영자에게 알려 주세요.</li>
<li>만 ${MIN_AGE}세 미만이 가입한 사실이 확인되면 운영자는 계정을 삭제할 수 있어요.</li>
</ol>

<h2 id="t5">제5조 (로그인 없이 둘러보기)</h2>
<p>로그인하지 않고도 닉네임을 정해 둘러보고, 모닥불 이야기에 참여하고, 정해진 표현(이모티콘)을 보낼 수 있어요. 🔥 모닥불 공개 음성은 로그인하고 이 약관에 동의한 분만 듣고 말할 수 있어요. 둘러보기에도 이 약관이 적용돼요. 둘러보기로 쓴 내용은 서버에 저장되지 않아요.</p>

<h2 id="t6">제6조 (이용자가 쓴 콘텐츠)</h2>
<ol>
<li>이용자가 쓴 묵상, 등불, 모임 채팅 등(이하 “콘텐츠”)의 권리는 <strong>쓴 사람에게</strong> 있어요.</li>
<li>이용자는 운영자에게, 서비스 안에서 콘텐츠를 저장하고 이용자가 정한 범위(나만 보기, 모임, 공개)의 사람에게 보여 주는 데 필요한 만큼 콘텐츠를 저장·복제·표시할 수 있는 <strong>무상의 비독점적 권한</strong>을 줘요. 이 권한은 서비스를 제공하는 목적으로만 쓰이며, 콘텐츠를 지우거나 탈퇴하면 끝나요(백업은 개인정보처리방침에 정한 기간 안에 지워져요).</li>
<li>공개 등불은 로그인하지 않은 분을 포함해 누구나, 모임 등불과 모임 채팅은 그 모임 사람만 볼 수 있어요. 등불은 ${LANTERN_DAYS}일 동안 보여요.</li>
<li><strong>익명 등불</strong>은 다른 이용자에게 닉네임 대신 “익명의 성도”로 보여요. 다만 서버에는 작성자가 기록되며, 운영자는 이 약관 위반에 대응하거나 법령에 따른 요청이 있을 때 작성자를 확인할 수 있어요.</li>
<li>다른 분이 <strong>기록하기</strong>로 내 등불을 담으면 그분의 말씀 책에 사본이 남아요. 내 등불을 내려도 그 사본은 남지만, 회원 탈퇴를 하면 사본도 함께 지워져요.</li>
<li><strong>옷 그림</strong>(꾸미기에서 옷에 그린 그림)과 내 모습은 그때 함께 있는 모든 분께 보여요. 다른 이용자는 불편한 옷 그림을 신고할 수 있고, 서로 다른 ${OUTFIT_HIDE_REPORTS}명이 신고하면 그 그림은 자동으로 숨겨져 다른 분께는 그림 없는 옷으로 보여요(그림 주인에게는 안내가 보여요). 그림을 고쳐서 저장하면 새 그림으로 다시 보이지만, 숨겨진 그림이 ${OUTFIT_STRIKES_BAN}개 쌓이면 ${OUTFIT_BAN_DAYS}일 동안 새 그림을 올릴 수 없어요.</li>
<li>이용자는 자신이 쓴 콘텐츠에 대해 책임을 지며, 다른 사람의 권리를 침해하지 않아야 해요.</li>
</ol>

<h2 id="t6-2">제6조의2 (이야기 도서관)</h2>
<ol>
<li><strong>나의 하나님 이야기</strong>(간증)와 <strong>오늘의 일기</strong>는 쓴 사람이 고른 범위에만 보여요: 공개(로그인하지 않은 분 포함 누구나), 모임(고른 모임 사람만), 익명 공개(누구나, 닉네임 대신 “익명의 성도”), 나만. 쓴 사람은 언제든 고치거나 뺄 수 있어요.</li>
<li>이야기는 하루에 ${STORIES_PER_DAY}권까지, 일기는 하루에 한 편(고치기는 자유) 꽂을 수 있어요.</li>
<li><strong>오늘의 일기</strong>는 그날의 <strong>발자취</strong>(내 활동 기록)로 정해진 문장 틀에 따라 서버가 초안을 만들고, 쓴 사람이 고치고 덧붙여 꽂아요. 초안에는 다른 분의 이름이나 모닥불에서 다른 분이 한 말이 들어가지 않아요. 꽂은 일기의 내용은 쓴 사람의 콘텐츠예요.</li>
<li><strong>월드 안 사진</strong>은 하루 ${SHOTS_PER_DAY}장까지 찍을 수 있고, 일기에 넣기 전에는 찍은 사람만 볼 수 있어요. 일기에 넣으면 그 일기의 공개 범위에 따라 보여요.</li>
<li>다른 분의 이야기와 일기를 허락 없이 밖으로 옮기거나, 익명으로 쓴 분이 누구인지 알아내려 하면 안 돼요.</li>
<li>올리기 전에 전화번호·이메일·주민등록번호처럼 보이는 내용이 있으면 한 번 더 확인해요. 다른 분의 개인정보는 쓰지 말아 주세요.</li>
<li>책은 신고할 수 있어요(부적절함, 개인정보 노출, 광고·도배, 기타). 서로 다른 ${STORY_HIDE_REPORTS}명이 신고하면 운영자가 살펴볼 때까지 자동으로 숨겨지고, 쓴 분에게는 안내가 보여요.</li>
<li><strong>답장 편지</strong>: 책을 볼 수 있는 분은 그 책 아래에 짧은 편지(300자까지)를 남길 수 있고(“익명으로 보내기” 가능), 책을 쓴 분과 편지를 쓴 분이 번갈아 답장하며 대화를 이어 갈 수 있어요(한 편지에 답장 20번까지). 나만 보는 책에는 편지를 쓸 수 없어요. 편지는 쓴 분이 지울 수 있고, 책을 쓴 분은 자기 책에 온 편지를 숨길 수 있어요. 편지도 책처럼 신고할 수 있고 같은 기준으로 숨겨져요. 너무 많은 편지는 잠시 제한될 수 있어요.</li>
</ol>

<h2 id="t7">제7조 (금지 행위)</h2>
<p>다음 행위를 하면 안 돼요.</p>
<ol>
<li>욕설, 비방, 괴롭힘, 위협</li>
<li>인종·민족·성별·종교·장애·출신 등을 이유로 한 혐오 표현과 차별</li>
<li>음란하거나 폭력적인 내용, 청소년에게 해로운 내용</li>
<li>스팸, 광고·홍보, 같은 내용 반복 게시, 다단계·금전 요구</li>
<li>다른 사람의 개인정보(연락처, 주소, 실명 등) 노출</li>
<li>저작권 등 다른 사람의 권리 침해(예: 허락받지 않은 글·가사·영상의 무단 게시)</li>
<li>운영자나 다른 사람·단체를 사칭하는 행위</li>
<li>부적절한 그림(음란하거나 폭력적인 그림, 혐오 표현이나 욕설을 담은 그림, 다른 사람을 괴롭히는 그림)을 옷에 그려 입는 행위</li>
<li>서비스나 다른 이용자의 기기를 방해하는 행위(자동화된 대량 접속, 보안 우회, 취약점 악용 등)</li>
<li>그 밖에 법령에 어긋나는 행위</li>
</ol>

<h2 id="t8">제8조 (게시물 관리와 이용 제한)</h2>
<ol>
<li><strong>모임장</strong>(모임을 만든 분)은 자기 모임의 채팅 메시지를 가릴 수 있고, 음성 기도방에서 다른 참여자를 내보낼 수 있어요(내보내진 분은 ${kickMin}분 동안 다시 들어올 수 없어요). 음성 기도방은 한 번에 ${VOICE_MAX}명까지 함께할 수 있어요.</li>
<li><strong>운영자</strong>는 제7조를 어긴 콘텐츠나 계정에 대해 콘텐츠 가리기·삭제, 일정 기간 이용 정지, 계정 삭제 등 필요한 조치를 할 수 있어요. 신고된 옷 그림은 운영자가 살펴보고 숨김을 유지하거나 되돌리며, 필요하면 일정 기간 그림 올리기를 막을 수 있어요. 신고된 도서관 책과 답장 편지는 운영자가 살펴보고 복구, 숨김 유지 또는 삭제하며, 필요하면 일정 기간 도서관에 글을 쓰지 못하게 할 수 있어요. 가능하면 미리 이유를 알리고, 급한 경우에는 조치 뒤에 알려요.</li>
<li>조치에 이의가 있으면 ${mail}로 알려 주세요. 다시 살펴보고 답변할게요.</li>
<li>권리를 침해받았다고 생각하는 분(예: 저작권자)은 해당 콘텐츠와 근거를 ${mail}로 보내 주시면 확인 후 조치할게요.</li>
</ol>

<h2 id="t8-2">제8조의2 (🔥 모닥불 공개 음성)</h2>
<ol>
<li>모닥불 공개 음성은 모닥불 가까이(반경 ${CAMPFIRE.chatRadius}m 안이나 통나무 자리)에 있는, <strong>로그인하고 이 약관에 동의한 분</strong>만 참여할 수 있는 공개 음성 대화예요. 처음 만나는 분을 포함해 그때 참여한 모든 분이 내 목소리를 들을 수 있어요. 한 번에 ${VOICE_MAX}명까지 함께할 수 있고, 모닥불에서 멀어지면 자동으로 나와요. 음성 기도방과 모닥불 음성은 동시에 쓸 수 없어요.</li>
<li>처음엔 마이크가 꺼진 채로 들어오며, 🎤를 처음 누를 때만 마이크 사용을 물어봐요. 대화는 녹음하거나 저장하지 않아요. 다른 참여자의 목소리를 허락 없이 녹음해 밖으로 옮기면 안 돼요.</li>
<li>참여자끼리 IP 주소가 보이지 않도록 목소리는 언제나 Cloudflare의 중계 서버를 거쳐요(개인정보처리방침 참고).</li>
<li>제7조의 금지 행위는 모닥불 음성에서 하는 말에도 똑같이 적용돼요. 누구든 다른 참여자를 <strong>나만 음소거</strong>할 수 있고, 로그인한 분은 <strong>🚩 음성 신고</strong>(욕설·혐오, 음란, 괴롭힘, 기타)를 할 수 있어요. 신고한 분이 누구인지는 알리지 않아요.</li>
<li>${VOICE_WINDOW_MIN}분 안에 서로 다른 ${VOICE_REPORTS_TO_MUTE}명이 신고하면 그분은 자동으로 <strong>${VOICE_MUTE_H}시간 동안</strong> 모닥불 음성에서 말할 수 없어요(듣기는 할 수 있어요). 그 뒤에 다시 같은 기준으로 신고가 쌓이면 <strong>${VOICE_MUTE_REPEAT_D}일 동안</strong> 말할 수 없어요. 제한을 받으면 화면에서 알려 드려요.</li>
<li>운영자는 신고와 말하기 제한을 살펴보고 제한을 풀거나 늘릴 수 있어요. 이의가 있으면 제8조 3항에 따라 알려 주세요.</li>
</ol>

<h2 id="t9">제9조 (나눔 소품 가게)</h2>
<ol>
<li>나눔 소품 가게는 로그인한 이용자에게 소품(${PROP_IDS.map((id) => PROPS[id].name).join(', ')})을 정해진 시간 동안 <strong>무료로</strong> 빌려 드리는 기능이에요. 결제, 유료 포인트, 확률형 뽑기는 없어요.</li>
<li>가게는 매일 한국 시간 ${SHOP_HOURS}에 중앙 광장에 열려요. 시간대마다 소품별로 정해진 수량을 <strong>먼저 오신 분께</strong> 빌려 드리며, 다 나가면 다음 시간대까지 기다려야 해요.</li>
<li>한 사람은 하루(한국 시간 기준)에 ${SHOP_DAILY_LIMIT}번까지 빌릴 수 있고, 한 번에 ${SHOP_MAX_ACTIVE}개까지(같은 자리, 예: 손에는 1개) 쓸 수 있어요. 같은 소품은 쓰는 동안 다시 빌릴 수 없어요.</li>
<li>빌린 소품은 가게가 닫혀도 사용 시간이 끝날 때까지 쓸 수 있고, 시간이 끝나면 자동으로 돌아가요. 일찍 반납할 수 있지만 그날의 대여 횟수와 가게 수량은 돌아오지 않아요.</li>
<li>소품은 서비스 안에서만 보이는 꾸밈이며 <strong>재산적 가치가 없어요</strong>. 다른 사람에게 넘기거나 팔거나 바꿀 수 없고, 현금이나 다른 것으로 바꿔 드리지 않아요.</li>
<li>운영자는 시간대별 수량을 바꾸거나, 여러 계정을 만들어 소품을 독점하는 등 부정한 이용에 대해 제8조에 따라 조치할 수 있어요.</li>
</ol>

<h2 id="t10">제10조 (성경 본문)</h2>
<p>서비스의 성경 본문은 <strong>개역한글판</strong>을 사용해요. 오늘의 말씀은 서비스가 정한 목록에서 날마다 정해져요.</p>

<h2 id="t11">제11조 (서비스의 변경과 중단)</h2>
<ol>
<li>서비스는 개인이 운영하는 무료 서비스라서, 기능이 바뀌거나 점검·장애·운영 사정으로 일시적으로 또는 완전히 중단될 수 있어요.</li>
<li>서비스를 완전히 끝낼 때는 가능하면 30일 전에 서비스 화면에 알리고, 그동안 내 데이터를 내려받을 수 있게 해요. 서비스가 끝나면 개인정보는 개인정보처리방침에 따라 파기해요.</li>
</ol>

<h2 id="t12">제12조 (책임의 한계)</h2>
<ol>
<li>운영자는 서비스를 안정적으로 제공하려고 노력하지만, 무료로 제공하는 서비스이므로 서비스의 중단, 오류, 데이터 손실에 대해 운영자의 고의나 중대한 과실이 없는 한 책임을 지지 않아요. 소중한 묵상은 가끔 “내 데이터 내려받기”로 보관해 두시길 권해요.</li>
<li>이용자가 쓴 콘텐츠와 이용자 사이의 다툼은 당사자가 해결해야 하며, 운영자는 필요한 범위에서 돕고 이 약관에 따라 조치해요.</li>
<li>Google, Cloudflare 등 외부 서비스의 장애나 정책 변경으로 생기는 문제는 운영자가 책임질 수 없는 경우가 있어요.</li>
<li>월드의 날씨는 서울의 실제 날씨를 따라 보여 주는 분위기 효과이며, 정확한 날씨 예보가 아니에요. 날씨 정보: ${ext('https://api.met.no/', 'MET Norway')} (${ext('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0')}).</li>
</ol>

<h2 id="t13">제13조 (회원 탈퇴)</h2>
<p>이용자는 언제든 ⚙ 설정 → 계정 → <strong>회원 탈퇴</strong>로 탈퇴할 수 있어요. 탈퇴하면 계정과 콘텐츠가 바로 삭제되며 되돌릴 수 없어요. 지워지는 내용은 ${ext(PRIVACY_PATH + '#p3', '개인정보처리방침 3번')}에 적혀 있어요.</p>

<h2 id="t14">제14조 (문의와 분쟁 해결)</h2>
<ol>
<li>서비스에 관한 문의는 ${mail}로 보내 주세요.</li>
<li>이 약관은 대한민국 법에 따르며, 분쟁이 생기면 먼저 대화로 해결하도록 노력해요. 해결되지 않으면 민사소송법에 따른 관할 법원에서 다퉈요.</li>
</ol>

<h2 id="t15">부칙</h2>
<p>이 약관은 <strong>${koreanDate(cfg.EFFECTIVE_DATE)}</strong>부터 시행해요.</p>
`;
  return page(cfg, 'terms', '이용약관', body);
}
