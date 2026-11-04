import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/index.mjs';

// すべて架空。実Secret・外部通信・Cloudflareアカウントは不要。
const ENV = { ENV: 'development', ALLOWED_ORIGIN: 'http://localhost:5173', M5_DEVICE_KEY: 'test-only-device-key' };
const PREFIX = '/api/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODES = { 400: 'INVALID_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 500: 'INTERNAL_ERROR', 503: 'SERVICE_UNAVAILABLE' };
const POST = { text: '架空の共用スペースを片付けてくれて助かった', sentiment: 'good', target_type: 'place', target_id: 'kitchen' };
const COOKIE_APIS = [
  ['GET', '/me'], ['PATCH', '/me/preferences'], ['POST', '/auth/logout'],
  ['POST', '/posts/analyze'], ['POST', '/posts'], ['GET', '/places'], ['GET', '/people?query=架空'],
];
const MUTATIONS = COOKIE_APIS.filter(([method]) => method !== 'GET');
const ALL_APIS = [
  ['GET', '/auth/slack/login'], ['GET', '/auth/slack/callback'], ...COOKIE_APIS,
  ['GET', '/places/kitchen/counts'],
];

function request(app, path, { method = 'GET', cookie, body, origin = ENV.ALLOWED_ORIGIN, env = ENV, headers = {} } = {}) {
  return app.request(`http://127.0.0.1:8787${PREFIX}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin === undefined ? {} : { Origin: origin }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
}

async function login(app, user = 'accepted') {
  const response = await request(app, `/auth/slack/login?mock_user=${user}`);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), '/');
  const setCookie = response.headers.get('Set-Cookie');
  assert.ok(setCookie);
  return { cookie: setCookie.split(';')[0], setCookie };
}

async function expectError(response, status) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('Content-Type'), /application\/json/);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['error']);
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
  assert.equal(body.error.code, CODES[status]);
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.error.message.length > 0);
  return body;
}

for (const mode of [undefined, '', 'production', 'staging', 'Development']) {
  test(`ENV=${String(mode)}: 全10 APIが503、Cookie・固定データを返さない`, async () => {
    const app = createApp();
    const { cookie } = await login(app);
    for (const [method, path] of ALL_APIS) {
      const response = await request(app, path, {
        method, cookie, env: { ...ENV, ENV: mode },
        headers: { Authorization: `Bearer ${ENV.M5_DEVICE_KEY}` },
        ...(method === 'GET' ? {} : { body: POST }),
      });
      await expectError(response, 503);
      assert.equal(response.headers.get('Set-Cookie'), null);
      assert.equal(response.headers.get('Location'), null);
    }
  });
}

test('ENV=developmentでも公開ホストでは全10 APIを無効化する', async () => {
  const app = createApp();
  for (const [method, path] of ALL_APIS) {
    const response = await app.request(`https://example.com${PREFIX}${path}`, { method }, ENV);
    await expectError(response, 503);
    assert.equal(response.headers.get('Set-Cookie'), null);
  }
});

test('モックログインのCookieで/meが200、Cookie属性・UUID・初期設定が契約どおり', async () => {
  const app = createApp();
  const first = await login(app);
  const second = await login(app);
  assert.notEqual(first.cookie, second.cookie);
  assert.match(first.cookie, /^__Host-gm_session=[0-9a-f]{64}$/);
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=604800']) assert.ok(first.setCookie.includes(attribute));
  assert.doesNotMatch(first.setCookie, /Domain=/i);
  const response = await request(app, '/me', { cookie: first.cookie });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const me = await response.json();
  assert.deepEqual(Object.keys(me).sort(), ['display_name', 'feedback_opt_in', 'person_id', 'terms_accepted']);
  assert.match(me.person_id, UUID);
  assert.equal(me.display_name, '架空アオ');
  assert.equal(me.terms_accepted, true);
  assert.equal(me.feedback_opt_in, false);
  const pending = await login(app, 'pending');
  const pendingMe = await (await request(app, '/me', { cookie: pending.cookie })).json();
  assert.equal(pendingMe.terms_accepted, false);
  assert.equal(pendingMe.feedback_opt_in, false);
  assert.notEqual(me.person_id, pendingMe.person_id);
});

test('callbackは相対パス/に302、独自にCookieを発行しない', async () => {
  const response = await request(createApp(), '/auth/slack/callback?code=fake');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), '/');
  assert.equal(response.headers.get('Set-Cookie'), null);
  await expectError(await request(createApp(), '/auth/slack/login?mock_user=invalid'), 400);
});

for (const cookie of [undefined, '__Host-gm_session=invalid', 'gm_session=invalid']) {
  test(`全Cookie必須APIが未認証を拒否: ${cookie ?? 'Cookieなし'}`, async () => {
    const app = createApp();
    for (const [method, path] of COOKIE_APIS) {
      await expectError(await request(app, path, { method, cookie, ...(method === 'GET' ? {} : { body: POST }) }), 401);
    }
  });
}

test('端末キーをユーザー認証として使用できない', async () => {
  const app = createApp();
  for (const [method, path] of COOKIE_APIS) {
    await expectError(await request(app, path, { method, headers: { Authorization: `Bearer ${ENV.M5_DEVICE_KEY}` } }), 401);
  }
});

test('未同意ユーザーのanalyze/postsは403', async () => {
  const app = createApp();
  const { cookie } = await login(app, 'pending');
  for (const path of ['/posts/analyze', '/posts']) await expectError(await request(app, path, { method: 'POST', cookie, body: POST }), 403);
});

for (const origin of ['', 'null', 'http://evil.example', 'http://localhost:5173.evil.example', 'http://127.0.0.1:8787']) {
  test(`変更系全APIが許可外Originを拒否（JSONも対象）: ${origin || '空'}`, async () => {
    const app = createApp();
    const { cookie } = await login(app);
    for (const [method, path] of MUTATIONS) await expectError(await request(app, path, { method, cookie, origin, body: POST }), 403);
  });
}

test('Origin欠落・設定欠落・ワイルドカードは拒否する', async () => {
  const app = createApp();
  const { cookie } = await login(app);
  for (const [method, path] of MUTATIONS) {
    const response = await app.request(`http://127.0.0.1:8787${PREFIX}${path}`, { method, headers: { Cookie: cookie } }, ENV);
    await expectError(response, 403);
    for (const allowed of [undefined, '', '*']) {
      await expectError(await request(app, path, { method, cookie, body: POST, env: { ...ENV, ALLOWED_ORIGIN: allowed } }), 403);
    }
  }
});

test('proxyでHostが変わっても設定されたVite Originを受け付け、CORSを公開しない', async () => {
  const app = createApp();
  const { cookie } = await login(app);
  const response = await request(app, '/posts/analyze', { method: 'POST', cookie, body: { text: '架空の投稿' }, headers: { Host: '127.0.0.1:8787' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  const options = await request(app, '/posts', { method: 'OPTIONS', origin: 'http://evil.example' });
  await expectError(options, 404);
});

test('preferencesは同一プロセスの全セッションと検索・人物投稿に反映し、受信同意を撤回できる', async () => {
  const app = createApp();
  const first = await login(app);
  const second = await login(app);
  const actor = await login(app, 'pending');
  assert.equal((await request(app, '/me/preferences', { method: 'PATCH', cookie: actor.cookie, body: { terms_accepted: true, feedback_opt_in: false } })).status, 200);
  const original = await (await request(app, '/me', { cookie: first.cookie })).json();
  for (const optIn of [true, false]) {
    const response = await request(app, '/me/preferences', { method: 'PATCH', cookie: first.cookie, body: { terms_accepted: true, feedback_opt_in: optIn } });
    assert.equal(response.status, 200);
    const expected = { ...original, feedback_opt_in: optIn };
    assert.deepEqual(await response.json(), expected);
    assert.deepEqual(await (await request(app, '/me', { cookie: second.cookie })).json(), expected);
    const search = await (await request(app, '/people?query=アオ', { cookie: actor.cookie })).json();
    assert.equal(search.people.length, optIn ? 1 : 0);
    const post = await request(app, '/posts', { method: 'POST', cookie: actor.cookie, body: { ...POST, target_type: 'person', target_id: original.person_id } });
    if (optIn) assert.equal(post.status, 201);
    else await expectError(post, 403);
  }
});

test('preferencesの必須boolean検証・利用同意撤回拒否', async () => {
  const app = createApp();
  const { cookie } = await login(app);
  for (const body of [null, [], {}, { terms_accepted: true }, { feedback_opt_in: false },
    { terms_accepted: 'true', feedback_opt_in: false }, { terms_accepted: true, feedback_opt_in: 0 },
    { terms_accepted: null, feedback_opt_in: true }, { terms_accepted: false, feedback_opt_in: false }]) {
    await expectError(await request(app, '/me/preferences', { method: 'PATCH', cookie, body }), 400);
  }
  const me = await (await request(app, '/me', { cookie })).json();
  assert.equal(me.terms_accepted, true);
  assert.equal(me.feedback_opt_in, false);
});

test('未同意のまま受信同意は403、同時に利用同意すれば投稿できる', async () => {
  const app = createApp();
  const { cookie } = await login(app, 'pending');
  await expectError(await request(app, '/me/preferences', { method: 'PATCH', cookie, body: { terms_accepted: false, feedback_opt_in: true } }), 403);
  const unchanged = await (await request(app, '/me', { cookie })).json();
  assert.equal(unchanged.terms_accepted, false);
  assert.equal(unchanged.feedback_opt_in, false);
  const decline = await request(app, '/me/preferences', { method: 'PATCH', cookie, body: { terms_accepted: false, feedback_opt_in: false } });
  assert.equal(decline.status, 200);
  const response = await request(app, '/me/preferences', { method: 'PATCH', cookie, body: { terms_accepted: true, feedback_opt_in: true } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).feedback_opt_in, true);
  assert.equal((await request(app, '/posts', { method: 'POST', cookie, body: POST })).status, 201);
});

test('logoutは本文なし204とCookie削除、古いCookieは全APIで401', async () => {
  const app = createApp();
  const { cookie } = await login(app);
  const response = await request(app, '/auth/logout', { method: 'POST', cookie });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  const deletion = response.headers.get('Set-Cookie');
  for (const attribute of ['__Host-gm_session=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=0']) assert.ok(deletion.includes(attribute));
  assert.doesNotMatch(deletion, /Domain=/i);
  for (const [method, path] of COOKIE_APIS) await expectError(await request(app, path, { method, cookie }), 401);
});

for (const path of ['/posts/analyze', '/posts']) {
  test(`${path}: trim後のUnicodeコードポイント1〜500、絵文字と境界値`, async () => {
    const app = createApp();
    const { cookie } = await login(app);
    for (const text of ['あ', '😀', 'あ'.repeat(500), '😀'.repeat(500), ` \n${'😀'.repeat(500)}\t `, ' '.repeat(10000) + '架空' + ' '.repeat(10000)]) {
      const response = await request(app, path, { method: 'POST', cookie, body: { ...POST, text } });
      assert.equal(response.status, path.endsWith('analyze') ? 200 : 201);
    }
    for (const text of [undefined, null, 1, true, [], {}, '', ' \n\t　', 'あ'.repeat(501), '😀'.repeat(501)]) {
      await expectError(await request(app, path, { method: 'POST', cookie, body: { ...POST, text } }), 400);
    }
  });
}

test('analyzeは内容から人物IDを推測せず、契約例を固定で返す', async () => {
  const app = createApp();
  const { cookie } = await login(app);
  for (const text of ['架空アオさんが手伝ってくれた', '架空の洗濯室を使った']) {
    const response = await request(app, '/posts/analyze', { method: 'POST', cookie, body: { text } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sentiment: 'motto', target_type: 'place', target_id: 'kitchen', target_label: '共用キッチン' });
  }
});

test('postsは201と文字列ID、good/motto・place/personの有効値を受け付ける', async () => {
  const app = createApp();
  const { cookie } = await login(app);
  const { people } = await (await request(app, '/people?query=架空', { cookie })).json();
  const ids = new Set();
  for (const sentiment of ['good', 'motto']) {
    for (const [target_type, target_id] of [['place', 'kitchen'], ['place', 'laundry'], ['person', people[0].id]]) {
      const response = await request(app, '/posts', { method: 'POST', cookie, body: { ...POST, sentiment, target_type, target_id } });
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.deepEqual(Object.keys(body).sort(), ['post_id', 'status']);
      assert.equal(body.status, 'created');
      assert.equal(typeof body.post_id, 'string');
      assert.ok(body.post_id.length > 0);
      ids.add(body.post_id);
    }
  }
  assert.equal(ids.size, 6);
});

test('postsの列挙値・target_id・未存在/未同意/種類違いの対象を検証する', async () => {
  const app = createApp();
  const { cookie } = await login(app);
  for (const change of [{ sentiment: 'bad' }, { sentiment: undefined }, { sentiment: null }, { target_type: 'unknown' }, { target_type: null }, { target_type: undefined }, { target_id: null }, { target_id: 1 }, { target_id: '' }, { target_id: undefined }]) {
    await expectError(await request(app, '/posts', { method: 'POST', cookie, body: { ...POST, ...change } }), 400);
  }
  for (const change of [{ target_id: 'missing' }, { target_id: '__proto__' }, { target_type: 'person', target_id: 'missing' }, { target_type: 'person', target_id: 'kitchen' }, { target_id: '00000000-0000-4000-8000-000000000003' }]) {
    await expectError(await request(app, '/posts', { method: 'POST', cookie, body: { ...POST, ...change } }), 404);
  }
  for (const target_id of ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']) {
    await expectError(await request(app, '/posts', { method: 'POST', cookie, body: { ...POST, target_type: 'person', target_id } }), 403);
  }
});

test('投稿者ID・日時の偽装を拒否し、セッション本人を変更しない', async () => {
  const app = createApp();
  const { cookie } = await login(app);
  const before = await (await request(app, '/me', { cookie })).json();
  for (const key of ['author_person_id', 'author_id', 'person_id', 'user_id', 'created_at']) {
    await expectError(await request(app, '/posts', { method: 'POST', cookie, body: { ...POST, [key]: 'spoofed' } }), 400);
  }
  assert.deepEqual(await (await request(app, '/me', { cookie })).json(), before);
  assert.equal((await request(app, '/posts', { method: 'POST', cookie, body: POST })).status, 201);
});

test('placesとpeopleの契約、UUID・公開キー・未同意人物の除外・検索', async () => {
  const app = createApp();
  const { cookie } = await login(app);
  const places = await request(app, '/places', { cookie });
  assert.equal(places.status, 200);
  assert.deepEqual(await places.json(), { places: [{ id: 'kitchen', name: '共用キッチン' }, { id: 'laundry', name: '洗濯室' }] });
  const response = await request(app, '/people?query=架空', { cookie });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['people']);
  assert.equal(body.people.length, 1);
  for (const person of body.people) {
    assert.deepEqual(Object.keys(person).sort(), ['id', 'name']);
    assert.match(person.id, UUID);
    assert.equal(person.name, '架空ソラ');
  }
  for (const query of ['アオ', 'ミドリ', '存在しない架空名']) {
    assert.deepEqual(await (await request(app, `/people?query=${encodeURIComponent(query)}`, { cookie })).json(), { people: [] });
  }
  for (const path of ['/people', '/people?query=', '/people?query=%20%E3%80%80']) await expectError(await request(app, path, { cookie }), 400);
});

test('countsは専用Bearerのみ、キー未設定・不一致・Cookieのみを拒否', async () => {
  const app = createApp();
  const { cookie } = await login(app);
  for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: 'Basic test-only-device-key' }, { Authorization: 'Bearer ' }]) {
    await expectError(await request(app, '/places/kitchen/counts', { cookie, headers }), 401);
  }
  await expectError(await request(app, '/places/kitchen/counts', { env: { ...ENV, M5_DEVICE_KEY: undefined }, headers: { Authorization: `Bearer ${ENV.M5_DEVICE_KEY}` } }), 401);
  await expectError(await request(app, '/places/kitchen/counts', { env: { ...ENV, M5_DEVICE_KEY: '' }, headers: { Authorization: 'Bearer ' } }), 401);
});

test('countsのキーは5つのみ、厨房8/12、洗濯室5件未満、不明場所404', async () => {
  const app = createApp();
  const headers = { Authorization: `Bearer ${ENV.M5_DEVICE_KEY}` };
  for (const place of ['kitchen', 'laundry']) {
    const response = await request(app, `/places/${place}/counts`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ['good_count', 'motto_count', 'period_days', 'place_id', 'updated_at']);
    assert.equal(body.place_id, place);
    assert.equal(body.period_days, 7);
    assert.ok(Number.isInteger(body.good_count) && body.good_count >= 0);
    assert.ok(Number.isInteger(body.motto_count) && body.motto_count >= 0);
    assert.ok(Number.isFinite(Date.parse(body.updated_at)));
    if (place === 'kitchen') assert.deepEqual(body, { place_id: 'kitchen', period_days: 7, good_count: 8, motto_count: 12, updated_at: '2026-11-04T04:00:00Z' });
    else assert.ok(body.good_count + body.motto_count < 5);
  }
  for (const id of ['missing', '__proto__', 'constructor']) await expectError(await request(app, `/places/${id}/counts`, { headers }), 404);
});

test('不正JSON・非object JSONは変更系JSON APIで400', async () => {
  const app = createApp();
  const { cookie } = await login(app);
  for (const [method, path] of [['PATCH', '/me/preferences'], ['POST', '/posts/analyze'], ['POST', '/posts']]) {
    for (const body of ['{', '', 'null', '[]', 'true', '42', '"text"']) {
      const response = await app.request(`http://localhost${PREFIX}${path}`, { method, headers: { Cookie: cookie, Origin: ENV.ALLOWED_ORIGIN, 'Content-Type': 'application/json' }, body }, ENV);
      await expectError(response, 400);
    }
  }
});

test('未定義パスは共通404、予期しない例外は詳細を隠した共通500、本文をログに出さない', async t => {
  const app = createApp();
  app.post('/api/v1/test-error', async c => {
    const body = await c.req.json();
    throw new Error(body.text);
  });
  const { cookie } = await login(app);
  const logs = ['log', 'info', 'warn', 'error', 'debug'].map(method => t.mock.method(console, method, () => {}));
  for (const path of ['/does-not-exist', '/posts/kitchen', '/']) await expectError(await request(app, path), 404);
  const secretText = '架空テストの本文がログに出ないことを確認';
  assert.equal((await request(app, '/posts', { method: 'POST', cookie, body: { ...POST, text: secretText } })).status, 201);
  await expectError(await request(app, '/posts', { method: 'POST', cookie, body: { ...POST, text: secretText, sentiment: 'invalid' } }), 400);
  const error = await expectError(await request(app, '/test-error', { method: 'POST', body: { text: secretText } }), 500);
  assert.ok(!JSON.stringify(error).includes(secretText));
  assert.ok(logs.every(log => log.mock.calls.length === 0));
});
