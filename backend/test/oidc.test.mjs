import assert from 'node:assert/strict';
import { test, before, beforeEach, after } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT, UnsecuredJWT } from 'jose';
import { createApp } from '../src/index.mjs';
import { hashToken, randomToken } from '../src/auth/tokens.mjs';
import { createD1, resetD1 } from './helpers/d1.mjs';

// 架空のSlack、人物、投稿だけを使用。鍵は毎回実行時に生成する。
const TEAM = 'https://slack.com/team_id';
const USER = 'https://slack.com/user_id';
const AT = new Date('2026-11-04T04:00:00Z');
const POST = { text: '架空の共有スペースが使いやすかった', sentiment: 'good', target_type: 'place', target_id: 'kitchen' };
const BASE = { ENV: 'production', SLACK_CLIENT_ID: 'fake-client', SLACK_CLIENT_SECRET: 'fake-client-secret',
  SLACK_REDIRECT_URI: 'https://gm.example/api/v1/auth/slack/callback', ALLOWED_SLACK_TEAM_ID: 'FAKE_TEAM',
  ALLOWED_ORIGIN: 'https://gm.example', M5_DEVICE_KEY: 'fake-device-key' };
const COOKIE_APIS = [['GET', '/me'], ['PATCH', '/me/preferences'], ['POST', '/auth/logout'],
  ['POST', '/posts/analyze'], ['POST', '/posts'], ['GET', '/places'], ['GET', '/people?query=架空']];
const ALL_APIS = [['GET', '/auth/slack/login?mock_user=accepted'], ['GET', '/auth/slack/callback'],
  ...COOKIE_APIS, ['GET', '/places/kitchen/counts']];
let db, disposeD1, key, wrongKey, jwks;
before(async () => {
  db = await createD1({ after: fn => { disposeD1 = fn; } });
  key = await generateKeyPair('RS256');
  wrongKey = await generateKeyPair('RS256');
  jwks = { keys: [{ ...await exportJWK(key.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' }] };
});
after(async () => { await disposeD1?.(); });
beforeEach(async () => {
  await resetD1(db);
  await db.prepare('DELETE FROM people').run();
});

function request(app, env, path, { method = 'GET', cookie, body, origin = env.ALLOWED_ORIGIN, headers = {}, host = 'https://gm.example' } = {}) {
  return app.request(`${host}/api/v1${path}`, { method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: origin, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
}
async function failure(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('Content-Type'), /application\/json/);
  const codes = { 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 503: 'SERVICE_UNAVAILABLE' };
  const body = await response.json();
  assert.equal(body.error.code, codes[status]);
  assert.deepEqual(Object.keys(body), ['error']);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
  assert.equal(response.headers.getSetCookie().some(c => c.startsWith('__Host-gm_session=')), false);
}
function cookieAttributes(value, maxAge) {
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAge}`]) assert.ok(value.includes(attribute));
  assert.doesNotMatch(value, /Domain=/i);
}
async function begin(app, env, query = '') {
  const response = await request(app, env, `/auth/slack/login${query}`);
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get('Location'));
  assert.equal(url.origin + url.pathname, 'https://slack.com/openid/connect/authorize');
  return { response, url, state: url.searchParams.get('state'), nonce: url.searchParams.get('nonce'),
    cookie: response.headers.getSetCookie()[0].split(';')[0] };
}
function callback(app, env, flow, { state = flow.state, cookie = flow.cookie, code = 'fake-code', error, team } = {}) {
  const params = new URLSearchParams();
  if (state !== null) params.set('state', state);
  if (code !== null) params.set('code', code);
  if (error !== undefined) params.set('error', error);
  if (team !== undefined) params.set('team', team);
  return request(app, env, `/auth/slack/callback?${params}`, { cookie });
}
async function signed(payload, signingKey = key.privateKey, alg = 'RS256') {
  return new SignJWT(payload).setProtectedHeader({ alg, kid: 'test-key' }).sign(signingKey);
}
function setup({ mode = 'production', claims = {}, handlers = {}, now = () => AT } = {}) {
  const env = { ...BASE, DB: db, ENV: mode };
  const calls = [];
  let payload;
  const fetch = async (url, options) => {
    calls.push([url, options]);
    if (url === 'https://slack.com/api/openid.connect.token') {
      return handlers.token ? handlers.token(url, options, payload) : Response.json({ ok: true,
        id_token: await signed(payload), access_token: 'fake-access-token' });
    }
    if (url === 'https://slack.com/openid/connect/keys') return handlers.keys ? handlers.keys(url, options) : Response.json(jwks);
    if (url === 'https://slack.com/api/openid.connect.userInfo') return handlers.info ? handlers.info(url, options, payload) : Response.json({ ...payload, ok: true, name: '架空ナギ' });
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      assert.ok(handlers.gemini, 'Geminiのfetchは明示的にモックする');
      return handlers.gemini(url, options);
    }
    assert.fail('外部通信は禁止');
  };
  const app = createApp({ fetch, now });
  const start = async query => {
    const flow = await begin(app, env, query);
    payload = { iss: 'https://slack.com', aud: env.SLACK_CLIENT_ID, sub: 'FAKE_USER', exp: AT.getTime() / 1000 + 300,
      nonce: flow.nonce, [TEAM]: env.ALLOWED_SLACK_TEAM_ID, [USER]: 'FAKE_USER', name: '架空ナギ', ...claims };
    return flow;
  };
  const finish = (flow, options) => callback(app, env, flow, options);
  const login = async () => {
    const flow = await start();
    const response = await finish(flow);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), '/');
    const cookie = response.headers.getSetCookie().find(c => c.startsWith('__Host-gm_session='));
    cookieAttributes(cookie, 604800);
    return cookie.split(';')[0];
  };
  return { app, env, calls, start, finish, login };
}

for (const mode of ['production', 'staging']) {
  test(`${mode}: 各必須設定の欠落・空白とD1未設定で全10 APIが503`, async () => {
    const f = setup({ mode });
    for (const key of ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_REDIRECT_URI', 'ALLOWED_SLACK_TEAM_ID', 'ALLOWED_ORIGIN', 'DB']) {
      for (const value of key === 'DB' ? [undefined] : [undefined, '', '   ']) {
        const env = { ...f.env, [key]: value };
        for (const [method, path] of ALL_APIS) {
          const response = await request(f.app, env, path, { method, body: method === 'GET' ? undefined : POST,
            headers: { Authorization: `Bearer ${BASE.M5_DEVICE_KEY}` } });
          await failure(response, 503);
          assert.equal(response.headers.get('Set-Cookie'), null);
          assert.equal(response.headers.get('Location'), null);
        }
      }
    }
    assert.equal(f.calls.length, 0);
  });

  test(`${mode}: mock_userを無視しOIDC開始、固定データやモックセッションを発行しない`, async () => {
    const f = setup({ mode });
    for (const user of ['accepted', 'pending', 'invalid']) {
      const flow = await f.start(`?mock_user=${user}`);
      assert.equal(flow.response.headers.getSetCookie().some(c => c.startsWith('__Host-gm_session=')), false);
    }
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM people').first()).n, 0);
    assert.equal(f.calls.length, 0);
  });

  test(`${mode}: 許可ワークスペースでログイン、全APIと端末Bearerの認証が動く`, async () => {
    const f = setup({ mode });
    const cookie = await f.login();
    const me = await (await request(f.app, f.env, '/me', { cookie })).json();
    assert.match(me.person_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(me, { person_id: me.person_id, display_name: '架空ナギ', terms_accepted: false, feedback_opt_in: false });
    assert.equal((await request(f.app, f.env, '/places', { cookie })).status, 200);
    await failure(await request(f.app, f.env, '/posts', { method: 'POST', body: POST }), 401);
    await failure(await request(f.app, f.env, '/posts', { method: 'POST', cookie, body: POST }), 403);
    assert.equal((await request(f.app, f.env, '/me/preferences', { method: 'PATCH', cookie,
      body: { terms_accepted: true, feedback_opt_in: false } })).status, 200);
    assert.equal((await request(f.app, f.env, '/posts', { method: 'POST', cookie, body: POST })).status, 201);
    const saved = await db.prepare('SELECT * FROM posts').first();
    assert.equal(saved.author_person_id, me.person_id);
    assert.equal((await request(f.app, f.env, '/posts', { method: 'POST', cookie, body: { ...POST, author_person_id: 'fake-other' } })).status, 400);
    await failure(await request(f.app, f.env, '/places/kitchen/counts', { cookie }), 401);
    assert.equal((await request(f.app, f.env, '/places/kitchen/counts', { headers: { Authorization: `Bearer ${BASE.M5_DEVICE_KEY}` } })).status, 200);
    await failure(await request(f.app, f.env, '/me', { headers: { Authorization: `Bearer ${BASE.M5_DEVICE_KEY}` } }), 401);
    assert.equal((await request(f.app, f.env, '/auth/logout', { method: 'POST', cookie })).status, 204);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n, 0);
    await failure(await request(f.app, f.env, '/me', { cookie }), 401);
  });

  test(`${mode}: analyzeはGemini設定が両方あるときだけ呼び、固定応答を返さない`, async () => {
    const f = setup({ mode, handlers: { gemini: async () => Response.json({ candidates: [{ finishReason: 'STOP',
      content: { parts: [{ text: JSON.stringify({ sentiment: 'good', target_type: 'place', target_id: 'laundry', target_label: '洗濯室' }) }] } }] }) } });
    const cookie = await f.login();
    await request(f.app, f.env, '/me/preferences', { method: 'PATCH', cookie, body: { terms_accepted: true, feedback_opt_in: false } });
    for (const config of [{}, { GEMINI_API_KEY: 'fake-key' }, { GEMINI_MODEL: 'fake-model' },
      { GEMINI_API_KEY: 'fake-key', GEMINI_MODEL: 'fake-model' }]) {
      const both = Boolean(config.GEMINI_API_KEY && config.GEMINI_MODEL);
      const response = await request(f.app, { ...f.env, ...config }, '/posts/analyze', { cookie, method: 'POST', body: { text: POST.text } });
      if (!both) await failure(response, 503);
      else {
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { sentiment: 'good', target_type: 'place', target_id: 'laundry', target_label: '洗濯室' });
      }
    }
    assert.equal(f.calls.filter(([url]) => url.startsWith('https://generativelanguage.googleapis.com/')).length, 1);
  });
}

test('開始URL・ランダムstate/nonce・ハッシュ保存・10分Cookie・期限切れ行の削除', async () => {
  const f = setup();
  const cookie = await f.login();
  const person = await db.prepare('SELECT * FROM people').first();
  await db.prepare('UPDATE sessions SET expires_at = ?').bind(AT.getTime()).run();
  await db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').bind('live-session', person.id, AT.getTime() + 1, AT.getTime()).run();
  await db.prepare('INSERT INTO oauth_states VALUES (?, ?, ?)').bind('expired', 'expired-nonce', AT.getTime()).run();
  const first = await f.start();
  const second = await f.start();
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.state, first.nonce);
  for (const value of [first.state, first.nonce, second.state, second.nonce]) assert.match(value, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.fromEntries(first.url.searchParams), { response_type: 'code', scope: 'openid profile',
    client_id: BASE.SLACK_CLIENT_ID, state: first.state, nonce: first.nonce, redirect_uri: BASE.SLACK_REDIRECT_URI, team: BASE.ALLOWED_SLACK_TEAM_ID });
  cookieAttributes(first.response.headers.get('Set-Cookie'), 600);
  assert.equal(first.cookie, `__Host-gm_oauth_state=${first.state}`);
  const rows = (await db.prepare('SELECT * FROM oauth_states').all()).results;
  assert.equal(rows.length, 2);
  const stored = await db.prepare('SELECT * FROM oauth_states WHERE state_hash = ?').bind(await hashToken(first.state)).first();
  assert.deepEqual(stored, { state_hash: await hashToken(first.state), nonce: first.nonce, expires_at: AT.getTime() + 600000 });
  const allValues = JSON.stringify(rows);
  assert.equal(allValues.includes(first.state), false);
  assert.equal(allValues.includes(second.state), false);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n, 1);
  await failure(await request(f.app, f.env, '/me', { cookie }), 401);
});

for (const [name, options] of [
  ['stateなし', { state: null }], ['Cookieなし', { cookie: '' }], ['Cookie不一致', { cookie: `__Host-gm_oauth_state=${'b'.repeat(64)}` }],
  ['state不一致', { state: 'a'.repeat(64) }],
  ['未知state', { state: 'c'.repeat(64), cookie: `__Host-gm_oauth_state=${'c'.repeat(64)}` }],
  ['codeなし', { code: null }], ['Slackの拒否', { error: 'access_denied' }],
]) {
  test(`${name}はトークン交換せず401`, async () => {
    const f = setup();
    const flow = await f.start();
    await failure(await f.finish(flow, options), 401);
    assert.equal(f.calls.length, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n, 0);
  });
}

test('期限切れstateは401、使用済みstateの同時callbackは一度だけ成功', async () => {
  const f = setup();
  const expired = await f.start();
  await db.prepare('UPDATE oauth_states SET expires_at = ?').bind(AT.getTime()).run();
  await failure(await f.finish(expired), 401);
  const flow = await f.start();
  const responses = await Promise.all([f.finish(flow), f.finish(flow)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [302, 401]);
  await failure(await f.finish(flow), 401);
  assert.equal(f.calls.filter(([url]) => url.endsWith('openid.connect.token')).length, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n, 1);
});

for (const [name, claims] of [
  ['nonce不一致', { nonce: 'wrong' }], ['issuer不一致', { iss: 'https://attacker.example' }],
  ['audience不一致', { aud: 'fake-other-client' }], ['期限切れJWT', { exp: AT.getTime() / 1000 }],
  ['expなし', { exp: undefined }], ['subなし', { sub: undefined }], ['sub空', { sub: '' }],
  ['subとユーザーID不一致', { sub: 'FAKE_OTHER_USER' }], ['ユーザーIDなし', { [USER]: undefined }],
  ['チームIDなし', { [TEAM]: undefined }], ['nonceなし', { nonce: undefined }],
  ['azp不一致', { azp: 'fake-other-client' }], ['複数audでazpなし', { aud: [BASE.SLACK_CLIENT_ID, 'other'] }],
]) {
  test(`${name}は401、人物・セッションを作成しない`, async () => {
    const f = setup({ claims });
    const flow = await f.start();
    await failure(await f.finish(flow), 401);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM people').first()).n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n, 0);
  });
}

for (const [name, sign] of [
  ['alg:none', async p => new UnsecuredJWT(p).encode()],
  ['HS256', async p => signed(p, crypto.getRandomValues(new Uint8Array(32)), 'HS256')],
  ['別の署名鍵', async p => signed(p, wrongKey.privateKey)],
  ['改ざんペイロード', async p => { const jwt = await signed(p); const parts = jwt.split('.');
    parts[1] = Buffer.from(JSON.stringify({ ...p, name: '架空の改ざん' })).toString('base64url'); return parts.join('.'); }],
]) {
  test(`${name}を署名検証で拒否する`, async () => {
    const f = setup({ handlers: { token: async (_url, _options, payload) => Response.json({ ok: true, id_token: await sign(payload) }) } });
    const flow = await f.start();
    await failure(await f.finish(flow), 401);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM people').first()).n, 0);
  });
}

test('teamヒントやcallback引数ではなく署名済みチームIDだけで403を判定する', async () => {
  const f = setup({ claims: { [TEAM]: 'FAKE_OTHER_TEAM' } });
  const flow = await f.start();
  assert.equal(flow.url.searchParams.get('team'), BASE.ALLOWED_SLACK_TEAM_ID);
  await failure(await f.finish(flow, { team: BASE.ALLOWED_SLACK_TEAM_ID }), 403);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM people').first()).n, 0);
  const allowed = setup();
  assert.equal((await allowed.finish(await allowed.start(), { team: 'FAKE_OTHER_TEAM' })).status, 302);
});

for (const [name, info] of [
  ['取得成功', {}], ['sub不一致', { sub: 'FAKE_OTHER_USER' }], ['user不一致', { [USER]: 'FAKE_OTHER_USER' }],
  ['team不一致', { [TEAM]: 'FAKE_OTHER_TEAM' }], ['取得不可', { ok: false }], ['表示名なし', { name: undefined }],
]) {
  test(`nameがない場合のuserInfo: ${name}`, async () => {
    const f = setup({ claims: { name: undefined }, handlers: { info: async (_url, options, payload) => {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Bearer fake-access-token');
      return Response.json({ ...payload, ok: true, name: '架空ハル', ...info });
    } } });
    const flow = await f.start();
    const response = await f.finish(flow);
    if (name === '取得成功') {
      assert.equal(response.status, 302);
      assert.equal((await db.prepare('SELECT display_name FROM people').first()).display_name, '架空ハル');
    } else await failure(response, 401);
  });
}

test('認可コード交換の宛先・パラメータはサーバー内だけで使用、同一人物の同時作成は一行', async () => {
  const first = setup();
  const second = setup();
  const flows = await Promise.all([first.start(), second.start()]);
  const responses = await Promise.all([first.finish(flows[0]), second.finish(flows[1])]);
  assert.deepEqual(responses.map(r => r.status), [302, 302]);
  const people = (await db.prepare('SELECT * FROM people').all()).results;
  assert.equal(people.length, 1);
  assert.equal(people[0].terms_accepted_at, null);
  assert.equal(people[0].feedback_opt_in, 0);
  assert.match(people[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const [, options] = first.calls[0];
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(options.body)), { client_id: BASE.SLACK_CLIENT_ID,
    client_secret: BASE.SLACK_CLIENT_SECRET, code: 'fake-code', redirect_uri: BASE.SLACK_REDIRECT_URI, grant_type: 'authorization_code' });
  await db.prepare('UPDATE people SET terms_accepted_at = 123, feedback_opt_in = 1').run();
  const changed = setup({ claims: { name: '架空の新しい表示名' } });
  await changed.login();
  assert.deepEqual(await db.prepare('SELECT * FROM people').first(), { ...people[0], display_name: '架空の新しい表示名', terms_accepted_at: 123, feedback_opt_in: 1 });
});

for (const [stage, handler] of [['token', 'token'], ['JWKS', 'keys'], ['userInfo', 'info']]) {
  for (const [name, implementation, status] of [
    ['通信失敗', async () => { throw new Error('fake-client-secret fake-code fake-access-token'); }, 503],
    ['5xx', async () => new Response('非公開の詳細', { status: 503 }), 503],
    ['4xx', async () => new Response('非公開の詳細', { status: 401 }), 401],
    ['不正JSON', async () => new Response('{'), 401],
    ['ok:false/不正JWKS', async () => Response.json({ ok: false }), 401],
  ]) {
    test(`${stage}の${name}は${status}、消費済みstateで再試行できない`, async () => {
      const f = setup({ claims: handler === 'info' ? { name: undefined } : {}, handlers: { [handler]: implementation } });
      const flow = await f.start();
      await failure(await f.finish(flow), status);
      await failure(await f.finish(flow), 401);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM sessions').first()).n, 0);
    });
  }
  for (const waitStage of ['fetch', 'body']) {
    test(`${stage}: ${waitStage}待機も10秒でabortして503`, async t => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let signal, ready;
      const started = new Promise(resolve => { ready = resolve; });
      const never = () => { ready(); return new Promise(() => {}); };
      const f = setup({ claims: handler === 'info' ? { name: undefined } : {}, handlers: { [handler]: async (_url, options) => {
        signal = options.signal;
        return waitStage === 'fetch' ? never() : { ok: true, status: 200, json: never };
      } } });
      const flow = await f.start();
      const pending = f.finish(flow);
      await started;
      t.mock.timers.tick(9999);
      assert.equal(signal.aborted, false);
      t.mock.timers.tick(1);
      await failure(await pending, 503);
      assert.equal(signal.aborted, true);
    });
  }
}

test('D1にはセッショントークンのSHA-256だけを保存し、再起動後も有効、7日期限・不在人物は401', async () => {
  const f = setup();
  const cookie = await f.login();
  const token = cookie.split('=')[1];
  assert.match(token, /^[0-9a-f]{64}$/);
  const session = await db.prepare('SELECT * FROM sessions').first();
  const person = await db.prepare('SELECT * FROM people').first();
  assert.deepEqual(session, { token_hash: await hashToken(token), person_id: person.id, expires_at: AT.getTime() + 604800000, created_at: AT.getTime() });
  assert.equal(JSON.stringify(session).includes(token), false);
  const restarted = createApp({ now: () => AT, fetch: async () => assert.fail('セッション照会では通信しない') });
  assert.equal((await request(restarted, f.env, '/me', { cookie })).status, 200);
  const expired = createApp({ now: () => new Date(AT.getTime() + 604800000) });
  await failure(await request(expired, f.env, '/me', { cookie }), 401);
  await failure(await request(restarted, f.env, '/me', { cookie: `__Host-gm_session=${randomToken()}` }), 401);
  await db.prepare('DELETE FROM people').run();
  await failure(await request(restarted, f.env, '/me', { cookie }), 401);
});

test('許可チーム設定変更後の古いセッションは全ユーザーAPIで403、countsは影響なし', async () => {
  const f = setup();
  const cookie = await f.login();
  const env = { ...f.env, ALLOWED_SLACK_TEAM_ID: 'FAKE_REPLACEMENT_TEAM' };
  for (const [method, path] of COOKIE_APIS) await failure(await request(f.app, env, path, { method, cookie, body: method === 'GET' ? undefined : POST }), 403);
  assert.equal((await request(f.app, env, '/places/kitchen/counts', { headers: { Authorization: `Bearer ${BASE.M5_DEVICE_KEY}` } })).status, 200);
});

test('productionでもOrigin一致が全変更APIに必須、検索/人物投稿は同一チームの同意者だけ、受信拒否で即時除外', async () => {
  const actor = setup();
  const cookie = await actor.login();
  const receiver = setup({ claims: { sub: 'FAKE_RECEIVER', [USER]: 'FAKE_RECEIVER', name: '架空ユキ' } });
  const recipientCookie = await receiver.login();
  const person = await db.prepare('SELECT * FROM people WHERE slack_user_id = ?').bind('FAKE_RECEIVER').first();
  await db.prepare(`INSERT INTO people VALUES ('fake-other', 'FAKE_OTHER_TEAM', 'FAKE_OTHER', '架空ユキ', 1, 1, 1)`).run();
  for (const [method, path] of COOKIE_APIS.filter(([method]) => method !== 'GET')) {
    for (const origin of ['https://untrusted.example', '']) await failure(await request(actor.app, actor.env, path,
      { method, cookie, origin, body: { ...POST, terms_accepted: true, feedback_opt_in: true } }), 403);
  }
  await request(actor.app, actor.env, '/me/preferences', { method: 'PATCH', cookie, body: { terms_accepted: true, feedback_opt_in: false } });
  assert.deepEqual(await (await request(actor.app, actor.env, '/people?query=架空', { cookie })).json(), { people: [] });
  for (const optIn of [true, false]) {
    await request(receiver.app, receiver.env, '/me/preferences', { method: 'PATCH', cookie: recipientCookie,
      body: { terms_accepted: true, feedback_opt_in: optIn } });
    assert.deepEqual(await (await request(actor.app, actor.env, '/people?query=架空', { cookie })).json(),
      { people: optIn ? [{ id: person.id, name: '架空ユキ' }] : [] });
    const response = await request(actor.app, actor.env, '/posts', { method: 'POST', cookie, body: { ...POST, target_type: 'person', target_id: person.id } });
    assert.equal(response.status, optIn ? 201 : 403);
  }
});

test('成功・失敗とも秘密値・JWT・認可コード・アクセストークン・セッション・投稿本文をログ/不要な応答/D1に残さない', async t => {
  const logs = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'].map(method => t.mock.method(console, method, () => {}));
  let idToken;
  const f = setup({ handlers: { token: async (_url, _options, payload) => {
    idToken = await signed(payload);
    return Response.json({ ok: true, id_token: idToken, access_token: 'fake-access-token' });
  } } });
  const cookie = await f.login();
  await request(f.app, f.env, '/me/preferences', { method: 'PATCH', cookie, body: { terms_accepted: true, feedback_opt_in: false } });
  assert.equal((await request(f.app, f.env, '/posts', { method: 'POST', cookie, body: POST })).status, 201);
  const meResponse = await request(f.app, f.env, '/me', { cookie });
  const publicData = await meResponse.text();
  for (const value of [BASE.SLACK_CLIENT_SECRET, idToken, 'fake-code', 'fake-access-token', cookie.split('=')[1], POST.text]) assert.equal(publicData.includes(value), false);
  const bad = setup({ handlers: { token: async () => { throw new Error(`${BASE.SLACK_CLIENT_SECRET} fake-code fake-access-token ${cookie} ${POST.text}`); } } });
  await failure(await bad.finish(await bad.start()), 503);
  assert.equal(logs.every(log => log.mock.callCount() === 0), true);
  const authData = JSON.stringify(await Promise.all(['people', 'sessions', 'oauth_states'].map(table => db.prepare(`SELECT * FROM ${table}`).all())));
  for (const value of [BASE.SLACK_CLIENT_SECRET, idToken, 'fake-code', 'fake-access-token', cookie.split('=')[1]]) assert.equal(authData.includes(value), false);
});
