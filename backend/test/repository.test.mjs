import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRepository } from '../src/data/repository.mjs';
import { createD1, applySql, addPost, AO, SORA } from './helpers/d1.mjs';

const AT = new Date('2026-11-04T04:00:00.123Z');

test('マイグレーションだけでは人物・投稿・送信履歴は空、場所と索引を作成する', async t => {
  const db = await createD1(t, { seed: false });
  for (const table of ['people', 'posts', 'slack_digest_deliveries', 'sessions', 'oauth_states']) {
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 0);
  }
  assert.deepEqual((await db.prepare('SELECT * FROM places ORDER BY id').all()).results,
    [{ id: 'kitchen', name: '共用キッチン' }, { id: 'laundry', name: '洗濯室' }]);
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map(row => row.name);
  assert.ok(tables.includes('sessions') && tables.includes('oauth_states'));
  assert.deepEqual((await db.prepare('PRAGMA table_info(sessions)').all()).results.map(r => r.name),
    ['token_hash', 'person_id', 'expires_at', 'created_at']);
  assert.deepEqual((await db.prepare('PRAGMA table_info(oauth_states)').all()).results.map(r => r.name),
    ['state_hash', 'nonce', 'expires_at']);
  for (const [index, columns] of [
    ['posts_place_counts', ['target_type', 'target_id', 'created_at', 'sentiment']],
    ['posts_weekly_period', ['target_type', 'created_at']],
    ['sessions_expiry', ['expires_at']], ['oauth_states_expiry', ['expires_at']],
  ]) assert.deepEqual((await db.prepare(`PRAGMA index_info(${index})`).all()).results.map(row => row.name), columns);
});

test('DB自身が人物の一意性・外部参照・NOT NULL・列挙値・送信履歴主キーを制約する', async t => {
  const db = await createD1(t);
  await assert.rejects(db.prepare(`INSERT INTO people SELECT 'fake-duplicate', slack_team_id, slack_user_id,
    display_name, terms_accepted_at, feedback_opt_in, created_at FROM people WHERE id = ?`).bind(AO).run());
  await assert.rejects(db.prepare('UPDATE people SET feedback_opt_in = 2 WHERE id = ?').bind(AO).run());
  for (const change of [{ author: 'missing' }, { type: 'unknown' }, { sentiment: 'bad' }, { target: null }]) {
    await assert.rejects(addPost(db, { at: AT, ...change }));
  }
  const repo = createRepository(db);
  assert.equal(await repo.claimDelivery(AO, '2026-11-02'), true);
  await assert.rejects(db.prepare("INSERT INTO slack_digest_deliveries (person_id, week_key, status, updated_at) VALUES (?, ?, 'sending', 1)").bind(AO, '2026-11-02').run());
  await assert.rejects(db.prepare("UPDATE slack_digest_deliveries SET status = 'bad'").run());
  await assert.rejects(repo.claimDelivery('missing', '2026-11-02'));
});

test('週次repo: personのみをfrom含有・to除外で抽出し、契約のキーとISO日時を返す', async t => {
  const db = await createD1(t);
  const from = new Date('2026-10-25T15:00:00Z');
  const to = new Date('2026-11-01T15:00:00Z');
  for (const [id, at, type] of [
    ['before', new Date(from.getTime() - 1), 'person'], ['from', from, 'person'],
    ['inside', new Date(to.getTime() - 1), 'person'], ['to', to, 'person'], ['place', from, 'place'],
  ]) await addPost(db, { id, at, type, target: type === 'person' ? SORA : 'kitchen' });
  const repo = createRepository(db);
  const posts = await repo.listPersonPosts({ from, to });
  assert.deepEqual(posts.map(row => row.id), ['from', 'inside']);
  assert.deepEqual(posts[0], { id: 'from', author_person_id: AO, target_type: 'person', target_id: SORA,
    sentiment: 'good', text: '架空の投稿', created_at: from.toISOString() });
  assert.equal(posts[1].created_at, new Date(to.getTime() - 1).toISOString());
  assert.deepEqual(await repo.getRecipient(SORA), { id: SORA, slack_team_id: 'FAKE_TEAM_LOCAL',
    slack_user_id: 'FAKE_USER_SORA', display_name: '架空ソラ', feedback_opt_in: 1 });
  assert.equal((await repo.getRecipient(AO)).feedback_opt_in, 0);
  assert.equal(await repo.getRecipient('missing'), null);
  assert.deepEqual(await repo.listDisplayNames(), ['架空アオ', '架空ミドリ', '架空ソラ']);
});

test('週次repo: 原子的claim、failed再取得、sending/sent/unknown再取得拒否、結果保存', async t => {
  const db = await createD1(t);
  let at = AT;
  const repo = createRepository(db, { now: () => at });
  const week = '2026-11-02';
  assert.equal(await repo.getDelivery(SORA, week), null);
  // 同じD1へ別repoから競合しても取得成功は1回だけ。
  const claims = await Promise.all([repo.claimDelivery(SORA, week), createRepository(db).claimDelivery(SORA, week)]);
  assert.deepEqual(claims.sort(), [false, true]);
  assert.equal(await repo.claimDelivery(SORA, week), false);
  let delivery = await repo.getDelivery(SORA, week);
  assert.equal(delivery.status, 'sending');
  assert.equal(delivery.attempts, 1);
  await repo.finishDelivery(SORA, week, { status: 'failed', error: 'fake_failure' });
  delivery = await repo.getDelivery(SORA, week);
  assert.equal(delivery.error, 'fake_failure');
  at = new Date(AT.getTime() + 1000);
  assert.equal(await repo.claimDelivery(SORA, week), true);
  delivery = await repo.getDelivery(SORA, week);
  assert.equal(delivery.attempts, 2);
  assert.equal(delivery.updated_at, at.getTime());
  assert.equal(delivery.error, null);
  await repo.finishDelivery(SORA, week, { status: 'sent', ts: 'fake-ts', channel: 'FAKE_CHANNEL' });
  delivery = await repo.getDelivery(SORA, week);
  assert.equal(delivery.slack_ts, 'fake-ts');
  assert.equal(delivery.slack_channel, 'FAKE_CHANNEL');
  assert.equal(delivery.status, 'sent');
  assert.equal(await repo.claimDelivery(SORA, week), false);
  const unknownWeek = '2026-11-09';
  assert.equal(await repo.claimDelivery(SORA, unknownWeek), true);
  await repo.finishDelivery(SORA, unknownWeek, { status: 'unknown', error: 'fake_timeout' });
  assert.equal((await repo.getDelivery(SORA, unknownWeek)).status, 'unknown');
  assert.equal(await repo.claimDelivery(SORA, unknownWeek), false);
  await assert.rejects(repo.finishDelivery(SORA, week, { status: 'sending' }), TypeError);
});

test('人物確認後に同意撤回されても、INSERTの現在のD1値で保存を拒否する', async t => {
  const db = await createD1(t);
  const repo = createRepository(db, { now: () => AT });
  assert.equal((await repo.getPerson(SORA)).feedback_opt_in, 1);
  await db.prepare('UPDATE people SET feedback_opt_in = 0 WHERE id = ?').bind(SORA).run();
  assert.equal(await repo.insertPost({ id: 'fake-race', author_person_id: AO, target_type: 'person',
    target_id: SORA, sentiment: 'good', text: '架空の投稿', teamId: 'FAKE_TEAM_LOCAL' }), false);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM posts').first()).n, 0);
});


test('開発シードの再投入は人物の同意と投稿を保持する', async t => {
  const db = await createD1(t);
  await db.prepare('UPDATE people SET feedback_opt_in = 1 WHERE id = ?').bind(AO).run();
  await addPost(db, { id: 'fake-persisted', at: AT });
  await applySql(db, '../../seeds/development.sql');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM people').first()).n, 3);
  assert.equal((await db.prepare('SELECT feedback_opt_in FROM people WHERE id = ?').bind(AO).first()).feedback_opt_in, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM posts').first()).n, 1);
});
