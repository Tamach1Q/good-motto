import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/index.mjs';
import { createRepository } from '../src/data/repository.mjs';
import { createGemini } from '../src/ai/gemini.mjs';
import { createD1, AO, MIDORI, SORA } from './helpers/d1.mjs';
import { productionApp, NOW, SAFE_SUMMARY, geminiResponse } from './helpers/integration.mjs';

function keys(value, expected) { assert.deepEqual(Object.keys(value).sort(), expected.sort()); }
function string(value) { assert.equal(typeof value, 'string'); assert.ok(value.length > 0); }
// e605317 frontend/src/api.ts の検査条件を独立に保持。実ファイルによる検査はverify:branchesで行う。
function session(value) {
  keys(value, ['person_id', 'display_name', 'terms_accepted', 'feedback_opt_in']);
  string(value.person_id); string(value.display_name);
  assert.equal(typeof value.terms_accepted, 'boolean'); assert.equal(typeof value.feedback_opt_in, 'boolean');
}
async function json(response, status) { assert.equal(response.status, status); return response.json(); }

test('Web: productionログインから同意・AI提案・本人選択・投稿・ログアウトまで実D1で接続', async t => {
  const db = await createD1(t);
  const f = await productionApp(db);
  const cookie = await f.login();
  const me = await json(await f.request('/me', { cookie }), 200);
  session(me); assert.equal(me.terms_accepted, false);
  const preferences = await json(await f.request('/me/preferences', { cookie, method: 'PATCH',
    body: { terms_accepted: true, feedback_opt_in: false } }), 200);
  session(preferences); assert.equal(preferences.terms_accepted, true);
  const analysis = await json(await f.request('/posts/analyze', { cookie, method: 'POST', body: { text: '架空の協力への感謝' } }), 200);
  keys(analysis, ['sentiment', 'target_type', 'target_id', 'target_label']);
  assert.ok(['good', 'motto'].includes(analysis.sentiment));
  assert.ok(['person', 'place', 'unknown'].includes(analysis.target_type));
  assert.ok(analysis.target_id === null || typeof analysis.target_id === 'string' && analysis.target_id.length > 0);
  assert.ok(analysis.target_label == null || typeof analysis.target_label === 'string');
  assert.equal(analysis.target_type, 'person'); assert.equal(analysis.target_id, null);
  const people = await json(await f.request('/people?query=架空', { cookie }), 200);
  const places = await json(await f.request('/places', { cookie }), 200);
  keys(people, ['people']); keys(places, ['places']);
  assert.ok(Array.isArray(people.people) && people.people.length > 0);
  assert.ok(Array.isArray(places.places) && places.places.length > 0);
  for (const item of [...people.people, ...places.places]) { keys(item, ['id', 'name']); string(item.id); string(item.name); }
  const selected = people.people.find(person => person.id === SORA);
  assert.ok(selected);
  const post = { text: '架空の協力への感謝', sentiment: analysis.sentiment, target_type: 'person', target_id: selected.id };
  const created = await json(await f.request('/posts', { cookie, method: 'POST', body: post }), 201);
  keys(created, ['post_id', 'status']); string(created.post_id); assert.equal(created.status, 'created');
  const saved = await db.prepare('SELECT * FROM posts WHERE id = ?').bind(created.post_id).first();
  assert.equal(saved.target_id, selected.id); assert.equal(saved.author_person_id, me.person_id);
  // Webと同じtrim後のUnicodeコードポイント。サロゲートペアと結合文字も含める。
  for (const text of ['あ'.repeat(500), '😀'.repeat(500), 'か\u3099'.repeat(250)]) {
    assert.equal(Array.from(text.trim()).length, 500);
    for (const [suffix, expected] of [['', true], ['😀', false]]) {
      const input = ` \n${text}${suffix}\t `;
      assert.equal(Array.from(input.trim()).length, expected ? 500 : 501);
      assert.equal((await f.request('/posts/analyze', { cookie, method: 'POST', body: { text: input } })).status, expected ? 200 : 400);
      const result = await f.request('/posts', { cookie, method: 'POST', body: { ...post, text: input } });
      assert.equal(result.status, expected ? 201 : 400);
      if (expected) {
        const { post_id } = await result.json();
        assert.equal((await db.prepare('SELECT text FROM posts WHERE id = ?').bind(post_id).first()).text, input.trim());
      }
    }
  }
  const logout = await f.request('/auth/logout', { cookie, method: 'POST' });
  assert.equal(logout.status, 204); assert.equal(await logout.text(), '');
  assert.equal((await f.request('/me', { cookie })).status, 401);
});

test('M5Stack: 実際のAPI投稿から境界色を計算し、人物投稿と非公開情報を除外', async t => {
  const db = await createD1(t);
  const app = createApp({ now: () => NOW, fetch: () => assert.fail('外部通信は禁止') });
  const env = { DB: db, ENV: 'development', ALLOWED_ORIGIN: 'http://127.0.0.1:5173', M5_DEVICE_KEY: 'fake-key' };
  const request = (path, init = {}) => app.request(`http://127.0.0.1/api/v1${path}`, init, env);
  const login = await request('/auth/slack/login');
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const post = async (sentiment, target_type = 'place', target_id = 'kitchen') => {
    const response = await request('/posts', { method: 'POST', headers: { Cookie: cookie, Origin: env.ALLOWED_ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '架空の表示検証用投稿', sentiment, target_type, target_id }) });
    assert.equal(response.status, 201);
  };
  const color = ({ good_count: g, motto_count: m }) => g + m < 5 ? 'gray' : g / (g + m) >= 0.65 ? 'green' : g / (g + m) >= 0.40 ? 'yellow' : 'red';
  for (const [good, motto, expected] of [[4, 0, 'gray'], [5, 0, 'green'], [13, 7, 'green'], [12, 8, 'yellow'], [8, 12, 'yellow'], [7, 13, 'red'], [2, 3, 'yellow'], [1, 4, 'red']]) {
    await db.prepare('DELETE FROM posts').run();
    for (let i = 0; i < good + motto; i++) await post(i < good ? 'good' : 'motto');
    await post('good', 'person', SORA);
    const result = await json(await request('/places/kitchen/counts', { headers: { Authorization: `Bearer ${env.M5_DEVICE_KEY}` } }), 200);
    keys(result, ['place_id', 'period_days', 'good_count', 'motto_count', 'updated_at']);
    assert.equal(result.place_id, 'kitchen'); assert.equal(result.period_days, 7);
    assert.equal(result.good_count, good); assert.equal(result.motto_count, motto);
    assert.ok(Number.isInteger(result.good_count) && result.good_count >= 0);
    assert.ok(Number.isInteger(result.motto_count) && result.motto_count >= 0);
    assert.equal(result.updated_at, NOW.toISOString()); assert.equal(color(result), expected);
  }
});

test('週次: repoとGemini要約の内部インターフェース、受信同意の即時撤回', async t => {
  const db = await createD1(t);
  const repo = createRepository(db, { now: () => NOW });
  await repo.insertPost({ id: 'fake-weekly-post', author_person_id: AO, target_type: 'person', target_id: SORA,
    sentiment: 'good', text: '架空の投稿内容', teamId: 'FAKE_TEAM_LOCAL' });
  const posts = await repo.listPersonPosts({ from: new Date(NOW.getTime() - 1), to: new Date(NOW.getTime() + 1) });
  assert.equal(posts.length, 1);
  keys(posts[0], ['id', 'author_person_id', 'target_type', 'target_id', 'sentiment', 'text', 'created_at']);
  for (const value of Object.values(posts[0])) string(value);
  const recipient = await repo.getRecipient(SORA);
  keys(recipient, ['id', 'slack_team_id', 'slack_user_id', 'display_name', 'feedback_opt_in']);
  assert.equal(recipient.feedback_opt_in, 1); assert.equal(await repo.getRecipient('nonexistent'), null);
  assert.ok((await repo.listDisplayNames()).every(name => typeof name === 'string'));
  const gemini = createGemini({ apiKey: 'fake-key', model: 'fake-model', fetch: async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
    assert.deepEqual(input, { good: posts.map(post => post.text), motto: [] });
    return geminiResponse(SAFE_SUMMARY);
  } });
  assert.deepEqual(await gemini.summarize({ good: posts.map(post => post.text), motto: [] }), SAFE_SUMMARY);
  assert.equal(await repo.getDelivery(SORA, 'fake-week'), null);
  assert.equal(await repo.claimDelivery(SORA, 'fake-week'), true);
  assert.equal(await repo.claimDelivery(SORA, 'fake-week'), false);
  await repo.finishDelivery(SORA, 'fake-week', { status: 'sent', ts: 'fake-ts', channel: 'FAKE_CHANNEL' });
  assert.equal((await repo.getDelivery(SORA, 'fake-week')).status, 'sent');
  await repo.updatePreferences(SORA, { terms_accepted: true, feedback_opt_in: false });
  assert.equal((await repo.getRecipient(SORA)).feedback_opt_in, 0);
  assert.equal((await repo.getRecipient(MIDORI)).feedback_opt_in, 0);
});
