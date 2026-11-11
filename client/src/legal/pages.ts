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
import { GROUP_CHAT_DAYS, MIN_AGE, OUTFIT_BAN_DAYS, OUTFIT_HIDE_REPORTS, OUTFIT_SIZE, OUTFIT_STRIKES_BAN, VOICE_KICK_BLOCK_MS, VOICE_MAX } from '../../../shared/protocol';
import { PRIVACY_PATH, TERMS_PATH, type LegalConfig } from '../config/legal';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Lanterns stay on the hill this many days (server/src/services.ts LANTERN_DAYS). */
const LANTERN_DAYS = 7;
/** A replaced or emptied drawing that was reported is kept this long after its last report (server/src/looks.ts). */
const REPORTED_OUTFIT_KEEP_DAYS = 30;
/** Newest backups kept (server/scripts/backup.mjs BACKUP_KEEP default). */
const BACKUP_KEEP = 14;

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
<p>· 모닥불 이야기와 음성 기도방은 저장하거나 녹음하지 않아요.</p>
<p>· 꾸미기로 고른 내 모습과 옷에 그린 그림은 함께 있는 모든 분께 보여요. 불편한 그림은 신고할 수 있고, 탈퇴하면 함께 지워져요.</p>
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
      '로그인한 분이 👕 꾸미기에서 고르거나 그려서 저장할 때, 🚩 옷 신고를 할 때 저장돼요. 그림은 이미지 파일로 올리지 않고 칸마다 색 번호만 저장해요.',
    ],
    [
      '알림 (선택)',
      '웹 푸시 구독 정보(브라우저의 푸시 서비스 주소와 암호화 키), 기기 종류를 알 수 있는 브라우저 정보(User-Agent 앞 80자), 알림 설정(오늘의 말씀 알림과 시각, 기도 알림), 마지막으로 알림이 전달된 시각',
      '⚙ 설정에서 알림을 켤 때만 저장돼요.',
    ],
    [
      '자동으로 생기는 정보',
      '로그인 세션 쿠키(서버에는 토큰의 해시값만 저장), 로그인 과정용 임시 쿠키, 접속 IP 주소, 서버 운영 기록(로그)',
      `IP 주소는 과도한 요청을 막기 위해 서버 메모리에서만 잠시 쓰고 파일로 남기지 않아요. 운영 기록에는 입장·퇴장할 때의 닉네임, 모닥불 이야기의 글자 수(내용은 남기지 않음), 음성 기도방에 들어간 닉네임과 모임 번호, 오류 내용이 남아요.`,
    ],
  ],
)}
<h3>저장하지 않는 것</h3>
<ul>
<li><strong>모닥불 이야기</strong>: 그때 모닥불 가까이에 있는 분들께만 실시간으로 전달되고, 내용은 서버에 저장하거나 기록하지 않아요.</li>
<li><strong>음성 기도방</strong>: 녹음하거나 저장하지 않아요. 목소리는 참여자 기기끼리 직접(P2P) 오가고, 직접 연결이 안 될 때만 Cloudflare의 중계 서버(TURN)를 거쳐요. 이때도 음성은 암호화되어 있어요. 직접 연결 방식이라 같은 방 참여자의 기기에는 서로의 IP 주소가 전달될 수 있어요.</li>
<li><strong>게임 속 위치와 움직임</strong>: 접속한 동안 다른 분 화면에 보여 주기 위해서만 쓰고 저장하지 않아요.</li>
<li><strong>로그인 없이 둘러보기</strong>: 닉네임을 계정으로 저장하지 않아요(위의 입장·퇴장 운영 기록에만 남아요). 이 기기에서 쓴 내용은 이 기기에만 저장돼요(8번 참고).</li>
</ul>
<p class="note">서비스는 종교·신앙에 관한 정보를 따로 묻거나 항목으로 모으지 않아요. 다만 이용자가 직접 쓰는 묵상·기도 내용에 신앙에 관한 내용이 담길 수 있으며, 그 내용은 이용자가 정한 범위(나만 보기, 모임, 공개)에서만 보여요.</p>

<h2 id="p2">2. 처리 목적</h2>
<ul>
<li><strong>계정 확인과 로그인 유지</strong>: Google 식별값으로 같은 분인지 확인하고, 세션 쿠키로 로그인 상태를 유지해요. 이메일은 계정 확인과 문의 응대에만 쓰고 광고·홍보 메일을 보내지 않아요.</li>
<li><strong>서비스 제공</strong>: 묵상과 말씀 책 저장, 등불·반응·모임·모임 채팅 기능, 닉네임 표시, 꾸미기(내 모습과 옷 그림을 다른 분 화면에 보여 주기).</li>
<li><strong>알림</strong>: 이용자가 켠 경우에만 오늘의 말씀 알림과 “누군가 기도하고 있어요” 알림을 보내요.</li>
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
    ['로그인 세션', '“로그인 유지”를 켜면 30일, 끄면 12시간. 로그아웃하거나 만료되면 삭제해요.'],
    ['알림 구독 정보', '알림을 끄거나, 브라우저가 구독을 끊었다고 푸시 서비스가 알려 오거나, 탈퇴하면 바로 삭제해요.'],
    ['가입을 마치지 않은 계정', 'Google 로그인 뒤 닉네임을 정하지 않고(약관 동의 없이) 떠난 경우, 하루 뒤 삭제해요.'],
    ['접속 IP 주소', '서버 메모리에서 요청 제한에 필요한 동안만 쓰고 몇 시간 안에 지워져요(서버를 다시 시작해도 사라져요). 파일이나 데이터베이스에는 남기지 않아요.'],
    ['서버 운영 기록(로그)', '용량 기준(10MB 파일 3개)으로 돌려 쓰며, 오래된 기록부터 자동으로 지워져요.'],
    ['백업', `장애에 대비해 데이터베이스를 하루 한 번 백업하고, 가장 최근 ${BACKUP_KEEP}개만 남겨요. 그래서 지운 정보도 약 ${BACKUP_KEEP}일 안에 백업에서까지 사라져요. 백업은 복구 외의 목적으로 쓰지 않아요.`],
  ],
)}
<p><strong>파기 방법</strong>: 전자 파일 형태로만 보관하며, 데이터베이스에서 삭제할 때 지운 자리를 덮어써서 다시 살릴 수 없게 해요. 종이 문서는 만들지 않아요.</p>
<p><strong>회원 탈퇴 때 지워지는 것</strong>: 계정, 묵상, 나의 말씀 책, 내 등불(모든 분의 화면에서 바로 꺼지고, 다른 분이 기록하기로 담아 둔 사본도 함께 삭제), 내가 남긴 반응(반응 수가 줄어요), 담아 둔 묵상, 알림 구독, 로그인 세션, 음성 기도방 참여, 내 모임 채팅 메시지, 내 모습 설정과 옷 그림(내 그림에 대한 신고 포함), 내가 한 옷 그림 신고, 신고로 숨겨진 횟수와 그림 올리기 제한, 지금 함께하는 모임에서 내 닉네임이 들어간 안내 문구(“○○님이 모임에 함께했어요” 등), 모임 참여. 내가 만든 모임은 가장 오래 함께한 분이 모임장이 되고, 남은 분이 없으면 모임도 삭제돼요. 닉네임은 다른 분이 다시 쓸 수 있게 돼요.</p>

<h2 id="p4">4. 개인정보의 제3자 제공</h2>
<p>운영자는 이용자의 개인정보를 제3자에게 제공하지 않아요. 다만 법률에 특별한 규정이 있거나 수사기관 등이 법령에 정해진 절차에 따라 요구하는 경우에는 그 범위에서만 제공할 수 있어요.</p>
<p class="note">서비스 안에서 이용자가 직접 나누는 것(공개 등불, 모임 등불과 채팅, 닉네임)은 이용자가 정한 범위의 다른 이용자에게 보여요. 내 모습과 옷 그림은 그때 함께 있는 모든 분(로그인하지 않은 분 포함)께 보여요. 옷 그림을 신고해도 신고한 분이 누구인지는 그림 주인에게 알려지지 않아요(운영자는 신고 기록을 볼 수 있어요). 익명 등불은 다른 분께 닉네임이 보이지 않지만, 서버에는 작성자가 기록돼 있어요(본인 확인과 삭제를 위해).</p>

<h2 id="p5">5. 개인정보 처리 위탁과 국외 이전</h2>
<p>서비스 서버와 데이터베이스는 운영자가 직접 관리하는 대한민국 내 서버에 있어요. 다만 서비스를 제공하기 위해 아래 해외 사업자의 서비스를 이용하며, 그 과정에서 아래 정보가 네트워크를 통해 국외로 전송돼요. 이전을 원하지 않으면 해당 기능을 쓰지 않거나(알림 끄기, 찬양 플레이어 닫기, 음성 기도방 쓰지 않기) 회원 탈퇴를 할 수 있어요. 다만 Cloudflare를 거치지 않고는 서비스에 접속할 수 없어요.</p>
${table(
  ['이전받는 자 (국가)', '이전되는 정보', '목적', '시기와 방법', '보유 기간'],
  [
    [
      'Cloudflare, Inc. (미국 및 Cloudflare 데이터센터 소재국)',
      '접속 IP 주소, 브라우저 정보, 주고받는 요청 내용(서비스로 전달하는 동안), 음성 기도방 중계 시 암호화된 음성 데이터',
      '보안 연결(HTTPS) 제공, 서비스 서버로 연결(Cloudflare Tunnel), 음성 기도방 연결을 위한 STUN/TURN 중계',
      '서비스에 접속할 때마다, 음성 기도방 이용 시 네트워크로 전송',
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
      'Google LLC (미국) — YouTube 찬양 플레이어',
      '접속 IP 주소, 브라우저·기기 정보, 재생할 때 YouTube가 쓰는 쿠키와 시청 정보',
      '찬양 영상 재생(YouTube 임베드, 개인정보 보호 강화 모드 youtube-nocookie.com 사용)',
      '앱을 열 때 YouTube 플레이어 프로그램을 불러오고, 찬양 플레이어를 열거나 재생할 때 영상을 불러옴',
      `YouTube·Google의 처리방침에 따름. ${ext('https://policies.google.com/privacy', 'Google 개인정보처리방침')}, ${ext('https://www.youtube.com/t/terms', 'YouTube 서비스 약관')}`,
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
<p class="note">찬양 영상은 YouTube API 서비스를 이용해 보여 드려요. 찬양 플레이어를 쓰면 ${ext('https://www.youtube.com/t/terms', 'YouTube 서비스 약관')}에 동의하는 것으로 보며, ${ext('https://policies.google.com/privacy', 'Google 개인정보처리방침')}이 적용돼요. 서비스는 YouTube에서 이용자에 관한 정보를 받아 오지 않아요. Google 계정의 YouTube 관련 권한은 ${ext('https://security.google.com/settings/security/permissions', 'Google 보안 설정')}에서 확인할 수 있어요(서비스는 YouTube 권한을 요청하지 않아요).</p>

<h2 id="p6">6. 이용자의 권리와 행사 방법</h2>
<p>이용자는 언제든 자신의 개인정보를 열람·정정·삭제하거나 처리 정지를 요구할 수 있어요. 대부분은 앱에서 바로 할 수 있고, 이메일(${mail})로 요청할 수도 있어요. 이메일 요청은 본인 확인(가입한 Google 계정 이메일로 보내 주시면 돼요) 뒤 10일 안에 처리하고 결과를 알려 드려요. 법정대리인이나 위임받은 분도 위임장을 함께 보내 주시면 요청할 수 있어요.</p>
${table(
  ['권리', '앱에서 하는 방법'],
  [
    ['열람', '⚙ 설정 → 계정 → <strong>내 데이터 내려받기</strong>: 계정, 말씀 책과 묵상, 등불, 반응, 담아 둔 묵상, 모임, 내 모임 채팅, 알림 설정, 내 모습과 옷 그림, 내가 한 옷 그림 신고를 JSON 파일로 받아요.'],
    ['정정', '⚙ 설정 → 계정에서 <strong>닉네임 바꾸기</strong>, 말씀 책에서 <strong>묵상 고치기</strong>. 이메일은 Google 계정에서 바꾸면 다음 로그인 때 반영돼요.'],
    ['삭제', '말씀 책에서 <strong>묵상 지우기</strong>·담아 둔 묵상 빼기, 등불 <strong>내리기</strong>, 모임 채팅 메시지 지우기, 모임 나가기, 👕 꾸미기에서 옷 그림 칸 비우기, ⚙ 설정 → 계정 → <strong>회원 탈퇴</strong>'],
    ['처리 정지·동의 철회', '⚙ 설정에서 <strong>알림 끄기</strong>, 모임 나가기, <strong>회원 탈퇴</strong>(동의 철회). 로그인 없이 둘러보기로도 이용할 수 있어요.'],
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
    ['기기 저장소 (localStorage)', '소리·찬양 플레이어·채팅 창 설정, 둘러보기 닉네임, 사용 안내를 봤는지, 쓰던 묵상 임시 저장, 로그인하지 않고 혼자 둘러볼 때 쓴 말씀 책, 오늘 편지를 열었는지, 설치 안내를 봤는지. 이 기기 안에만 있고 서버로 보내지 않아요(로그인 뒤 “옮기기”를 누를 때만 내 계정으로 올라가요).', '직접 지울 때까지'],
    ['세션 저장소 (sessionStorage)', '약관 동의 안내를 이번 방문에 이미 보여 드렸는지', '탭을 닫을 때까지'],
    ['서비스 워커 캐시', '앱 화면 파일(프로그램, 아이콘, 이 방침과 약관 페이지)을 저장해 빨리 열리고 연결이 끊겨도 열리게 해요. 개인정보는 담지 않아요.', '새 버전이 나오면 바뀌어요'],
  ],
)}
<p><strong>거부하는 방법</strong>: 브라우저 설정에서 쿠키를 막거나 이 사이트의 데이터를 지울 수 있어요(예: Chrome은 설정 → 개인정보 보호 및 보안 → 서드 파티 쿠키/사이트 데이터, Safari는 설정 → Safari → 고급 → 웹사이트 데이터). 쿠키를 막으면 로그인할 수 없지만, 로그인 없이 둘러보기는 할 수 있어요. 기기 저장소를 지우면 설정과 임시 저장한 글이 사라져요.</p>
<p class="note">YouTube 찬양 플레이어는 YouTube(Google)의 쿠키를 쓸 수 있어요(5번 참고). 이를 원하지 않으면 찬양 플레이어를 닫아 두세요.</p>

<h2 id="p9">9. 안전성 확보 조치</h2>
<ul>
<li>모든 통신은 HTTPS로 암호화해요.</li>
<li>비밀번호를 받지 않고, Google 접근 토큰도 저장하지 않아요. 로그인 세션 토큰은 해시값으로만 저장해요.</li>
<li>필요한 최소한의 정보만 모으고, 기간이 지나면 자동으로 지워요(3번).</li>
<li>접근 통제: 묵상과 말씀 책은 본인만, 모임 등불과 채팅은 모임 사람만 볼 수 있도록 서버에서 확인해요. 서버와 데이터베이스, 백업에는 운영자만 접근할 수 있어요.</li>
<li>옷 그림은 이미지 파일을 받지 않고, 정해진 크기와 색 번호만 서버에서 확인해 저장해요. 화면에는 그 번호로 다시 그려 보여 줘요.</li>
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
<p>· 서로를 존중해 주세요. 욕설, 혐오, 음란물, 스팸, 개인정보 노출, 저작권 침해, 사칭은 안 돼요. 옷에 그리는 그림도 마찬가지예요.</p>
</div>

<h2 id="t1">제1조 (목적)</h2>
<p>이 약관은 ${op}(이하 “운영자”)가 제공하는 ${svc}(${esc(cfg.SERVICE_URL)}, 이하 “서비스”)를 이용하는 데 필요한 운영자와 이용자의 권리, 의무와 책임을 정해요.</p>

<h2 id="t2">제2조 (서비스 소개)</h2>
<ol>
<li>서비스는 브라우저에서 여러 사람이 함께 쓰는 3D 공간에서 매일의 말씀(QT)을 읽고 묵상하고 나누는 서비스예요. 오늘의 말씀, 나의 말씀 책, 골방과 기도의 뜰, 등불 언덕(묵상 나눔), 모닥불 이야기, 모임과 모임 채팅, 음성 기도방, 찬양 플레이어, 알림, 꾸미기(내 모습과 옷 그림) 등을 제공해요.</li>
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
<p>로그인하지 않고도 닉네임을 정해 둘러보고, 모닥불 이야기에 참여할 수 있어요. 둘러보기에도 이 약관이 적용돼요. 둘러보기로 쓴 내용은 서버에 저장되지 않아요.</p>

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
<li><strong>운영자</strong>는 제7조를 어긴 콘텐츠나 계정에 대해 콘텐츠 가리기·삭제, 일정 기간 이용 정지, 계정 삭제 등 필요한 조치를 할 수 있어요. 신고된 옷 그림은 운영자가 살펴보고 숨김을 유지하거나 되돌리며, 필요하면 일정 기간 그림 올리기를 막을 수 있어요. 가능하면 미리 이유를 알리고, 급한 경우에는 조치 뒤에 알려요.</li>
<li>조치에 이의가 있으면 ${mail}로 알려 주세요. 다시 살펴보고 답변할게요.</li>
<li>권리를 침해받았다고 생각하는 분(예: 저작권자)은 해당 콘텐츠와 근거를 ${mail}로 보내 주시면 확인 후 조치할게요.</li>
</ol>

<h2 id="t9">제9조 (찬양 영상)</h2>
<ol>
<li>찬양 플레이어의 영상은 <strong>YouTube에 올라와 있는 영상을 YouTube 플레이어로 보여 주는 것</strong>(임베드)이며, 서비스가 영상을 복사하거나 저장하지 않아요. 영상의 권리는 각 저작권자에게 있어요.</li>
<li>찬양 플레이어를 쓰면 ${ext('https://www.youtube.com/t/terms', 'YouTube 서비스 약관')}이 함께 적용되고, ${ext('https://policies.google.com/privacy', 'Google 개인정보처리방침')}에 따라 처리돼요.</li>
<li>YouTube 정책에 따라 화면이 보이지 않으면(다른 앱으로 가거나 화면을 끄면, 플레이어를 접으면) 재생을 멈춰요.</li>
<li>저작권자의 요청이나 YouTube 사정으로 영상이 바뀌거나 재생되지 않을 수 있어요.</li>
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
<li>YouTube, Google, Cloudflare 등 외부 서비스의 장애나 정책 변경으로 생기는 문제는 운영자가 책임질 수 없는 경우가 있어요.</li>
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
