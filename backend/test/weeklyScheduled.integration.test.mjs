// 週次バッチの結合テスト: 実D1(Miniflare) + #4 の repository.mjs / gemini.mjs + createScheduledWeeklyDigest。
// #4（PR #14）の backend 実装とテスト補助に依存するため、backend の `npm test` で実行する。
// Slack・Gemini への通信はすべて偽物で、架空の人物・投稿だけを使う。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../src/data/repository.mjs';
import { createGemini } from '../src/ai/gemini.mjs';
import { createScheduledWeeklyDigest } from '../src/jobs/scheduled.js';
import { targetWeek } from '../src/jobs/weeklyDigest.js';
import { createD1, addPost, AO, MIDORI, SORA } from './helpers/d1.mjs';
import { NOW, SAFE_SUMMARY, geminiResponse } from './helpers/integration.mjs';

test('scheduled() wired to real D1 repo and Gemini module: dry-run, live-test once, consent revoke', async t => {
  const db = await createD1(t);
  const repo = createRepository(db, { now: () => NOW });
  const donor = '00000000-0000-4000-8000-000000000004';
  await db.prepare('INSERT INTO people VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(donor, 'FAKE_TEAM_LOCAL', 'FAKE_USER_DONOR', '架空ハル', NOW.getTime(), 0, NOW.getTime()).run();
  const at = new Date(targetWeek(NOW).from.getTime() + 86400000);
  for (const author of [AO, MIDORI, donor]) {
    await addPost(db, { author, type: 'person', target: SORA, text: '架空の資料を整える手伝いについての感想です。', at });
  }
  await repo.updatePreferences(SORA, { terms_accepted: true, feedback_opt_in: true });

  const calls = [];
  const fetch = async (url, init) => {
    if (String(url).includes('generativelanguage')) { calls.push('gemini'); return geminiResponse(SAFE_SUMMARY); }
    const method = String(url).split('/').pop();
    calls.push(method);
    if (method === 'auth.test') return Response.json({ ok: true, team_id: 'FAKE_TEAM_LOCAL', user_id: 'UBOT', bot_id: 'BBOT' });
    if (method === 'conversations.open') {
      assert.equal(JSON.parse(init.body).users, 'FAKE_USER_SORA');
      return Response.json({ ok: true, channel: { id: 'DFAKE' } });
    }
    if (method === 'chat.postMessage') {
      assert.ok(JSON.parse(init.body).text.includes(SAFE_SUMMARY.good));
      return Response.json({ ok: true, channel: 'DFAKE', ts: '1.0' });
    }
    throw new Error(`unexpected ${url}`);
  };
  const logs = [];
  const scheduled = createScheduledWeeklyDigest({
    createRepository: d => createRepository(d, { now: () => NOW }), createGemini, fetch,
    log: { info: m => logs.push(m), error: m => logs.push(m) },
  });
  const env = { DB: db, ALLOWED_SLACK_TEAM_ID: 'FAKE_TEAM_LOCAL', GEMINI_API_KEY: 'fake-key', GEMINI_MODEL: 'fake-model', SLACK_BOT_TOKEN: 'xoxb-fake' };
  const run = extra => scheduled({ scheduledTime: NOW.getTime() }, { ...env, ...extra }, { waitUntil() {} });

  const dry = await run({});
  assert.equal(dry.counts.dry_run, 1);
  assert.ok(!calls.includes('chat.postMessage'));
  assert.equal(await repo.getDelivery(SORA, dry.week), null);

  const live = await run({ DIGEST_MODE: 'live-test', DIGEST_ONLY_PERSON_IDS: SORA });
  assert.deepEqual(live.counts, { sent: 1 });
  assert.equal((await repo.getDelivery(SORA, live.week)).status, 'sent');
  const again = await run({ DIGEST_MODE: 'live-test', DIGEST_ONLY_PERSON_IDS: SORA });
  assert.deepEqual(again.counts, { 'skipped:already_sent': 1 });
  assert.equal(calls.filter(c => c === 'chat.postMessage').length, 1);

  await repo.updatePreferences(SORA, { terms_accepted: true, feedback_opt_in: false });
  const revoked = await run({});
  assert.deepEqual(revoked.counts, { 'skipped:no_consent': 1 });
  assert.ok(logs.every(m => !/xoxb|架空の資料/.test(m)));
});
