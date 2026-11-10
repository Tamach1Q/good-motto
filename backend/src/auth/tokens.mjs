export const SESSION_COOKIE = '__Host-gm_session';
export const STATE_COOKIE = '__Host-gm_oauth_state';
export const SESSION_SECONDS = 604800;
export const STATE_SECONDS = 600;
export const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' };

export function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
