import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createApp } from '../src/index.mjs';
import { createRepository } from '../src/data/repository.mjs';
import { createGemini } from '../src/ai/gemini.mjs';
import { createD1, addPost, AO, MIDORI, SORA } from '../test/helpers/d1.mjs';
import { NOW, SAFE_SUMMARY, geminiResponse } from '../test/helpers/integration.mjs';

export async function verifyWeekly(directory) {
  const { runWeeklyDigest, targetWeek } = await import(pathToFileURL(`${directory}/backend/src/jobs/weeklyDigest.js`));
  const { scheduledWeeklyDigest } = await import(pathToFileURL(`${directory}/backend/src/jobs/scheduled.js`));
  let dispose;
  const db = await createD1({ after: fn => { dispose = fn; } });
  try {
    const repo = createRepository(db, { now: () => NOW });
    const donor = '00000000-0000-4000-8000-000000000004';
    const other = '00000000-0000-4000-8000-000000000005';
    await db.prepare('INSERT INTO people VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(donor, 'FAKE_TEAM_LOCAL', 'FAKE_USER_DONOR', '架空ハル', NOW.getTime(), 0, NOW.getTime()).run();
    await repo.updatePreferences(MIDORI, { terms_accepted: true, feedback_opt_in: false });
    await db.prepare('INSERT INTO people VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(other, 'FAKE_OTHER_TEAM', 'FAKE_OTHER_USER', '架空ヨル', NOW.getTime(), 1, NOW.getTime()).run();
    // 過去の同意済み期間の投稿を模したfixture。送信時点の同意・チームはrepoが毎回取得する。
    const at = new Date(targetWeek(NOW).from.getTime() + 86400000);
    for (const [target, authors] of [[SORA, [AO, MIDORI, donor]], [AO, [MIDORI, SORA]], [MIDORI, [AO, SORA, donor]], [other, [AO, MIDORI, SORA]]]) {
      for (const author of authors) await addPost(db, { author, type: 'person', target, text: '架空の資料を整える手伝いについての感想です。', at });
    }
    let output = SAFE_SUMMARY;
    let calls = 0;
    const { summarize } = createGemini({ apiKey: 'fake-key', model: 'fake-model', fetch: async (_url, options) => {
      calls++;
      const input = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
      assert.deepEqual(Object.keys(input).sort(), ['good', 'motto']);
      assert.ok([...input.good, ...input.motto].every(text => typeof text === 'string'));
      return geminiResponse(output);
    } });
    let deliveries = 0;
    const deps = { repo, summarize, allowedTeamId: 'FAKE_TEAM_LOCAL', now: NOW, log: {}, deliver: async (user, payload) => {
      assert.equal(user, 'FAKE_USER_SORA'); assert.ok(payload.text.includes(SAFE_SUMMARY.good));
      deliveries++; return { channel: 'FAKE_CHANNEL', ts: 'fake-ts' };
    } };
    // AOは受信同意を有効化し、独立投稿者が足りないケースにする。
    await repo.updatePreferences(AO, { terms_accepted: true, feedback_opt_in: true });
    const dry = await runWeeklyDigest(deps);
    const byId = Object.fromEntries(dry.results.map(result => [result.person_id, result]));
    assert.equal(byId[SORA].status, 'dry_run'); assert.ok(byId[SORA].preview.includes(SAFE_SUMMARY.good));
    assert.equal(byId[AO].reason, 'insufficient_authors');
    assert.equal(byId[MIDORI].reason, 'no_consent'); assert.equal(byId[other].reason, 'workspace_not_allowed');
    assert.equal(deliveries, 0); assert.equal(await repo.getDelivery(SORA, dry.week), null);
    console.log('PASS weekly: 実D1+Geminiモックで3投稿者の本文生成、少人数保留、未同意・別チームskip、dry-run履歴なし');
    for (const [good, reason] of [['穏'.repeat(400), undefined], ['穏'.repeat(401), 'summary_too_long'],
      ['協力が3回ありました。', 'needs_manual_review'], ['「協力」に感謝します。', 'needs_manual_review']]) {
      output = { good, motto: '', needs_review: false };
      const report = await runWeeklyDigest({ ...deps, only: [SORA] });
      assert.equal(report.results[0].status, reason ? 'held' : 'dry_run');
      assert.equal(report.results[0].reason, reason);
    }
    output = SAFE_SUMMARY;
    assert.ok(calls >= 5);
    const sent = await runWeeklyDigest({ ...deps, dryRun: false });
    assert.equal(sent.results.find(result => result.person_id === SORA).status, 'sent');
    const again = await runWeeklyDigest({ ...deps, dryRun: false });
    assert.equal(again.results.find(result => result.person_id === SORA).reason, 'already_sent');
    assert.equal(deliveries, 1);
    await repo.updatePreferences(SORA, { terms_accepted: true, feedback_opt_in: false });
    const revoked = await runWeeklyDigest(deps);
    assert.equal(revoked.results.find(result => result.person_id === SORA).reason, 'no_consent');
    console.log('PASS weekly: 400文字許可・401文字/数字/引用符を保留、偽deliverは1回だけ、撤回即時反映');

    const app = createApp({ fetch: () => assert.fail('外部通信は禁止') });
    const worker = { fetch: app.fetch, scheduled: scheduledWeeklyDigest };
    assert.equal((await worker.fetch(new Request('http://127.0.0.1/api/v1/me'), { ENV: 'development', DB: db })).status, 401);
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = message => warnings.push(message);
    try {
      await worker.scheduled({ scheduledTime: NOW.getTime() }, { DB: db }, { waitUntil: () => assert.fail('D1ありの現行入口は処理を開始しない') });
    } finally { console.warn = originalWarn; }
    assert.ok(warnings.some(message => message.includes('D1 repo is not wired yet; skipped')));
    console.log('FINDING weekly: { fetch: app.fetch, scheduled }のfetchは動くが、scheduled.jsはDBありでskip（未接続）');
  } finally { await dispose?.(); }
}
