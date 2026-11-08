/** Small JSON client for /api (same origin, session cookie). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined || method !== 'GET' ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', '서버에 연결할 수 없어요.');
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, d.error ?? 'error', d.message ?? '잠시 문제가 생겼어요.');
  }
  return data as T;
}

export interface Me {
  user: { id: number; nickname: string | null; onboarded?: boolean } | null;
  needsNickname: boolean;
}

export interface AuthConfig {
  ready: boolean;
  provider: 'google' | 'mock' | null;
}

export const getMe = () => api<Me>('GET', '/api/me').catch(() => ({ user: null, needsNickname: false }) as Me);
export const getAuthConfig = () => api<AuthConfig>('GET', '/api/auth/config').catch(() => ({ ready: false, provider: null }) as AuthConfig);

/** Full-page navigation to the provider (OIDC code flow runs on the server). */
export function startGoogleLogin(remember: boolean, hint?: string) {
  const q = new URLSearchParams();
  if (remember) q.set('remember', '1');
  if (hint) q.set('hint', hint);
  // Come back to the same page (keeps ?query options).
  q.set('return', `${location.pathname}${location.search}`);
  location.assign(`/api/auth/google/start?${q.toString()}`);
}

export const logout = () => api('POST', '/api/auth/logout');
