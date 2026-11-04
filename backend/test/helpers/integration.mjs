import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createApp } from '../../src/index.mjs';

export const NOW = new Date('2026-11-04T04:00:00Z');
export const SAFE_SUMMARY = { good: '穏やかな協力の姿勢が周囲の安心につながっています。', motto: '', needs_review: false };
export function geminiResponse(value) {
  return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] });
}

// 本番と同じ署名検証・D1セッションを通す。Slack/Geminiへの通信は全件ここで止める。
export async function productionApp(db) {
  const key = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(key.publicKey), kid: 'integration', alg: 'RS256', use: 'sig' };
  const env = { DB: db, ENV: 'production', ALLOWED_ORIGIN: 'https://integration.example',
    SLACK_REDIRECT_URI: 'https://integration.example/api/v1/auth/slack/callback',
    SLACK_CLIENT_ID: 'fake-client', SLACK_CLIENT_SECRET: 'fake-secret', ALLOWED_SLACK_TEAM_ID: 'FAKE_TEAM_LOCAL',
    GEMINI_API_KEY: 'fake-key', GEMINI_MODEL: 'fake-model', M5_DEVICE_KEY: 'fake-device-key' };
  let nonce;
  const app = createApp({ now: () => NOW, fetch: async url => {
    if (url === 'https://slack.com/openid/connect/keys') return Response.json({ keys: [jwk] });
    if (url === 'https://slack.com/api/openid.connect.token') return Response.json({ ok: true,
      id_token: await new SignJWT({ nonce, name: '架空ナギ', 'https://slack.com/team_id': env.ALLOWED_SLACK_TEAM_ID,
        'https://slack.com/user_id': 'FAKE_INTEGRATION_USER' }).setProtectedHeader({ alg: 'RS256', kid: 'integration' })
        .setIssuer('https://slack.com').setAudience(env.SLACK_CLIENT_ID).setSubject('FAKE_INTEGRATION_USER')
        .setExpirationTime(NOW.getTime() / 1000 + 300).sign(key.privateKey) });
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'), '想定外の外部通信は禁止');
    return geminiResponse({ sentiment: 'good', target_type: 'person', target_id: 'AI-GUESSED-ID', target_label: '架空の候補' });
  } });
  const request = (path, { method = 'GET', cookie, body } = {}) => app.request(`${env.ALLOWED_ORIGIN}/api/v1${path}`, {
    method, headers: { Origin: env.ALLOWED_ORIGIN, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  const login = async () => {
    const start = await request('/auth/slack/login');
    assert.equal(start.status, 302);
    const url = new URL(start.headers.get('Location'));
    nonce = url.searchParams.get('nonce');
    const callback = await request(`/auth/slack/callback?state=${url.searchParams.get('state')}&code=fake-code`, {
      cookie: start.headers.getSetCookie()[0].split(';')[0],
    });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get('Location'), '/');
    const cookie = callback.headers.getSetCookie().find(value => value.startsWith('__Host-gm_session='));
    assert.match(cookie, /Secure/);
    return cookie.split(';')[0];
  };
  return { app, env, request, login };
}
