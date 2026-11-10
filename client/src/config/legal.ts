/**
 * 운영자 정보 for /privacy (개인정보처리방침) and /terms (이용약관).
 *
 * The one place to fill in before launch. Every field below that still
 * contains "입력 필요" makes `npm run build` print a loud warning (the build
 * still succeeds). The pages are generated from this file at build time
 * (vite.config.ts, plugin "worlds-legal"), so rebuild after editing.
 *
 * When the policy or terms change materially, also bump TERMS_VERSION in
 * shared/protocol.ts (every account is asked to agree again) and set
 * EFFECTIVE_DATE to the new 시행일.
 */
import { TERMS_VERSION } from '../../../shared/protocol';

export const LEGAL = {
  /** 서비스명 */
  SERVICE_NAME: 'QT 월드',
  SERVICE_URL: 'https://qt.log2u.me',
  /** 운영자 (개인 운영이면 실명, 단체면 단체명) */
  OPERATOR_NAME: 'QT 월드 운영팀',
  /** 개인정보 보호책임자 이름 (개인 운영이면 보통 운영자 본인) */
  PRIVACY_OFFICER_NAME: 'QT 월드 운영팀',
  /** 개인정보 보호책임자 연락 이메일 (문의·열람·삭제 요청을 받는 주소) */
  PRIVACY_CONTACT: 'ssp67223@gmail.com',
  /** 시행일 (YYYY-MM-DD). Keep equal to TERMS_VERSION unless you know why not. */
  EFFECTIVE_DATE: TERMS_VERSION,
} as const;

export type LegalConfig = typeof LEGAL;

/** Fields that still hold a placeholder ("… 입력 필요"). */
export function legalPlaceholders(cfg: LegalConfig = LEGAL): string[] {
  return Object.entries(cfg)
    .filter(([, v]) => typeof v === 'string' && v.includes('입력 필요'))
    .map(([k]) => k);
}

export const PRIVACY_PATH = '/privacy';
export const TERMS_PATH = '/terms';
