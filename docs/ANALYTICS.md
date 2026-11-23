# 데이터 분석 세션 안내 (운영자 전용)

이 문서는 **데이터 분석용 Claude 세션**이 처음 읽는 안내서다.

## 원칙
- **숫자만** 조회한다. 묵상·등불·이야기·편지·채팅의 **내용, 제목, 닉네임, 이메일은 조회하거나 출력하지 않는다**
- **읽기 전용**: 라이브 DB에 쓰지 않는다 (`{readonly:true}`로 연다)
- 라이브 컨테이너를 재시작하거나 수정하지 않는다
- 시크릿 파일(`deploy/.env.*`, `~/.config/qt-worlds`)은 읽지 않는다

## 조회 방법 (라이브 DB, 읽기 전용)
```bash
docker exec -w /app/server qt-worlds node -e '
const D=require("better-sqlite3");const db=new D("/data/worlds.db",{readonly:true});
const today=new Date(Date.now()+9*3600e3).toISOString().slice(0,10);
console.log(db.prepare("SELECT COUNT(DISTINCT user_id) n FROM meditations WHERE date = ?").get(today).n);'
```
- 한국 날짜: `new Date(Date.now()+9*3600e3).toISOString().slice(0,10)`
- 여러 쿼리를 돌릴 때는 백업 사본을 쓰는 것이 더 안전하다: `docker exec qt-worlds node server/scripts/backup.mjs`로 백업한 뒤 `docker cp`로 꺼내서 로컬에서 연다

## 자주 쓰는 숫자
| 질문 | 테이블과 조건 |
|---|---|
| 오늘 묵상한 사람 수 | `meditations` · `COUNT(DISTINCT user_id)` · `date = 오늘` |
| 오늘 묵상 수 | `meditations` · `COUNT(*)` · `date = 오늘` |
| 오늘 접속한 로그인 사용자 | `active_days` · `kst_date = 오늘` |
| 날짜별 접속 | `active_days` 그룹 `kst_date` |
| 가입자 수 | `users` · `COUNT(*)` (닉네임을 정한 사람: `nickname IS NOT NULL`) |
| 등불 (지금 언덕에 있는 것) | `lanterns` · `removed_at IS NULL AND created_at >= 지금-5일` |
| 공개·모임·익명 등불 | `lanterns.group_id`, `lanterns.anonymous` |
| 하나님 이야기·일기 | `stories.kind` |
| 편지 | `story_letters` |
| 반응 | `reactions.type` (pray, amen, record) |
| 날짜별 집계 카운터 | `daily_counts(kst_date, key, n)` |
| 시간대별 동시 접속 | `concurrency(kst_date, hour, samples, total, peak)` |

운영 대시보드: https://qt.log2u.me/admin (관리자 계정으로 로그인)
