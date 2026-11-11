import test from 'node:test';
import assert from 'node:assert/strict';
import { runWeeklyDigest, targetWeek, findLeak } from '../src/jobs/weeklyDigest.js';
import { createMemoryRepo, mockPosts, mockSummarize, mockPeople, MOCK_TEAM_ID } from '../src/jobs/mock.js';
import { DeliveryError } from '../src/slack/client.js';

const now = new Date('2026-11-02T00:00:00Z'); // 月曜 09:00 JST
const week = targetWeek(now);
const silent = { info() {}, error() {} };
const [TANAKA, SATO, SUZUKI, , ITO] = mockPeople.map(p => p.id);
const setup = (opts = {}) => createMemoryRepo({ posts: mockPosts(week), ...opts });
const run = opts => runWeeklyDigest({ summarize: mockSummarize, now, allowedTeamId: MOCK_TEAM_ID, log: silent, ...opts });
const byId = (report, id) => report.results.find(r => r.person_id === id);
const okDeliver = async () => ({ channel: 'D1', ts: '1.0' });

test('targetWeek is previous Monday-Sunday in JST', () => {
  assert.equal(week.key, '2026-10-26');
  assert.equal(week.from.toISOString(), '2026-10-25T15:00:00.000Z');
  assert.equal(week.to.toISOString(), '2026-11-01T15:00:00.000Z');
  assert.equal(week.endLabel, '2026-11-01');
  assert.equal(targetWeek(new Date('2026-11-01T14:59:00Z')).key, '2026-10-19');
});

test('allowedTeamId is required', async () => {
  await assert.rejects(runWeeklyDigest({ repo: setup(), summarize: mockSummarize, now, log: silent }), /allowedTeamId/);
});

test('dry-run builds a brief only for opted-in people in the allowed workspace with >=3 authors', async () => {
  const repo = setup();
  const report = await run({ repo, deliver: () => assert.fail('must not send') });
  assert.equal(byId(report, TANAKA).status, 'dry_run');
  assert.match(byId(report, TANAKA).preview, /今週のGood \/ Motto/);
  assert.deepEqual(byId(report, SATO), { person_id: SATO, status: 'held', reason: 'insufficient_authors', authors: 2 });
  assert.equal(byId(report, SUZUKI).reason, 'no_consent');
  assert.equal(byId(report, ITO).reason, 'workspace_not_allowed');
  assert.equal(report.results.length, 4);
  assert.deepEqual(repo.deliveries, {});
});

test('posts outside the week, self-posts and non-person posts are not counted', async () => {
  const posts = mockPosts(week).filter(p => p.target_id === TANAKA);
  posts[0] = { ...posts[0], created_at: week.to.toISOString() };
  posts[1] = { ...posts[1], author_person_id: TANAKA };
  posts.push({ ...posts[2], id: 'place', target_type: 'place', author_person_id: 'someone-else' });
  const report = await run({ repo: setup({ posts }) });
  assert.equal(byId(report, TANAKA).reason, 'insufficient_authors');
});

test('live run sends once per person per week, re-run does not double send', async () => {
  const repo = setup();
  const sent = [];
  const deliver = async (slackId, payload) => { sent.push({ slackId, payload }); return okDeliver(); };
  assert.equal(byId(await run({ repo, deliver, dryRun: false }), TANAKA).status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].slackId, mockPeople[0].slack_user_id);
  assert.equal(sent[0].payload.mrkdwn, false);
  assert.equal(byId(await run({ repo, deliver, dryRun: false }), TANAKA).reason, 'already_sent');
  assert.equal(sent.length, 1);
});

test('failed delivery is retried on re-run, unknown delivery is never auto-retried', async () => {
  for (const [code, expected, retried] of [['slack_rate_limited', 'failed', true], ['delivery_unknown', 'unknown', false]]) {
    const repo = setup();
    let calls = 0;
    const failing = async () => { calls++; throw new DeliveryError(code, 429, '30'); };
    assert.equal(byId(await run({ repo, deliver: failing, dryRun: false }), TANAKA).status, expected);
    const second = await run({ repo, deliver: async () => { calls++; return okDeliver(); }, dryRun: false });
    assert.equal(byId(second, TANAKA).status, retried ? 'sent' : 'skipped');
    assert.equal(calls, retried ? 2 : 1);
  }
});

test('if recording "sent" fails after a successful send, it is not resent on re-run', async () => {
  for (const unknownWriteFails of [false, true]) {
    const repo = setup();
    const finish = repo.finishDelivery;
    repo.finishDelivery = async (id, wk, result) => {
      if (result.status === 'sent' || (unknownWriteFails && result.status === 'unknown')) throw new Error('D1 write failed');
      return finish(id, wk, result);
    };
    let calls = 0;
    const deliver = async () => { calls++; return okDeliver(); };
    const first = await run({ repo, deliver, dryRun: false });
    assert.deepEqual(byId(first, TANAKA), { person_id: TANAKA, status: 'unknown', reason: 'record_failed' });
    repo.finishDelivery = finish;
    const second = await run({ repo, deliver, dryRun: false });
    assert.equal(byId(second, TANAKA).status, 'skipped');
    assert.equal(calls, 1);
  }
});

test('summary that leaks raw text, other names, or specific details is held, not sent', async () => {
  const risky = [
    async ({ good }) => ({ good: good[0], motto: '' }),
    async () => ({ good: '佐藤さんが感謝しています', motto: '' }),
    async () => ({ good: '3階の部屋での片付けに感謝が届いています', motto: '' }),
    async () => ({ good: '「ありがとう」という声がありました', motto: '' }),
    async () => ({ good: '感謝が届いています', motto: '', needs_review: true }),
    async () => ({ good: '', motto: '' }),
  ];
  for (const summarize of risky) {
    const report = await run({ repo: setup(), summarize, deliver: () => assert.fail('must not send'), dryRun: false });
    assert.equal(byId(report, TANAKA).status, 'held');
  }
});

test('summarizer error is logged as failed and does not stop other people', async () => {
  const report = await run({ repo: setup(), summarize: async () => { throw new Error('gemini 503'); } });
  assert.equal(byId(report, TANAKA).reason, 'summarize_failed');
  assert.equal(byId(report, SUZUKI).reason, 'no_consent');
});

test('only limits recipients for manual test sends', async () => {
  const report = await run({ repo: setup(), only: [SATO] });
  assert.deepEqual(report.results.map(r => r.person_id), [SATO]);
});

test('findLeak ignores punctuation/spacing differences', () => {
  const posts = [{ text: '共用スペースの片付けを率先してやってくれて助かった' }];
  assert.equal(findLeak('共用スペースの片付けを、率先して', posts), 'contains_raw_text');
  assert.equal(findLeak('周囲への気配りが感謝されています', posts), null);
});

test('mock data contains only fictional Slack IDs', () => {
  for (const p of mockPeople) assert.match(`${p.slack_team_id}${p.slack_user_id}`, /MOCK|OTHERWS/);
});

// ---- 競合・同意撤回の回帰テスト（PR #7 再レビュー指摘） ----

/** 要約の途中で people を書き換える summarize */
const summarizeThen = mutate => async input => { mutate(); return mockSummarize(input); };
/** 現行 D1 実装のように claim の条件に同意を含めない repo（送信直前の再検証だけで防げることを確かめる） */
const withoutConsentInClaim = repo => {
  const claim = repo.claimDelivery;
  return Object.assign(repo, { claimDelivery: (id, wk) => claim(id, wk) });
};

test('consent revoked while summarizing: no DM is sent (claim condition and pre-send recheck)', async () => {
  for (const variant of ['claim-checks-consent', 'claim-ignores-consent']) {
    const people = mockPeople.map(p => ({ ...p }));
    let repo = setup({ people });
    if (variant === 'claim-ignores-consent') repo = withoutConsentInClaim(repo);
    let calls = 0;
    const report = await run({ repo, only: [TANAKA], dryRun: false,
      summarize: summarizeThen(() => { people[0].feedback_opt_in = 0; }),
      deliver: async () => { calls++; return okDeliver(); } });
    assert.equal(calls, 0, variant);
    assert.deepEqual(byId(report, TANAKA), { person_id: TANAKA, status: 'skipped', reason: 'no_consent_before_send' }, variant);
    // 次回実行でも同意なしとして扱われ、送られない
    const next = await run({ repo, only: [TANAKA], dryRun: false, deliver: async () => { calls++; return okDeliver(); } });
    assert.equal(byId(next, TANAKA).reason, 'no_consent', variant);
    assert.equal(calls, 0, variant);
  }
});

test('workspace changed while summarizing: no DM is sent', async () => {
  const people = mockPeople.map(p => ({ ...p }));
  const repo = withoutConsentInClaim(setup({ people }));
  const report = await run({ repo, only: [TANAKA], dryRun: false,
    summarize: summarizeThen(() => { people[0].slack_team_id = 'T00OTHERWS'; }),
    deliver: () => assert.fail('must not send') });
  assert.equal(byId(report, TANAKA).reason, 'workspace_not_allowed_before_send');
});

test('Slack ID changed while summarizing: DM goes to the freshly read ID', async () => {
  const people = mockPeople.map(p => ({ ...p }));
  const repo = setup({ people });
  const to = [];
  await run({ repo, only: [TANAKA], dryRun: false,
    summarize: summarizeThen(() => { people[0].slack_user_id = 'U00000MOCKNEW'; }),
    deliver: async id => { to.push(id); return okDeliver(); } });
  assert.deepEqual(to, ['U00000MOCKNEW']);
});

test('recipient re-read failure before send: no DM, recorded as failed', async () => {
  const repo = setup();
  const get = repo.getRecipient;
  let reads = 0;
  repo.getRecipient = async id => { if (++reads === 2) throw new Error('D1 down'); return get(id); };
  const report = await run({ repo, only: [TANAKA], dryRun: false, deliver: () => assert.fail('must not send') });
  assert.deepEqual(byId(report, TANAKA), { person_id: TANAKA, status: 'failed', reason: 'recipient_recheck_failed' });
  assert.equal((await repo.getDelivery(TANAKA, week.key)).status, 'failed');
});

test('two cron runs at the same time send only one DM per person', async () => {
  const repo = setup();
  let calls = 0;
  const slowSummarize = async input => { await new Promise(r => setTimeout(r, 20)); return mockSummarize(input); };
  const deliver = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return okDeliver(); };
  const [a, b] = await Promise.all([
    run({ repo, summarize: slowSummarize, deliver, dryRun: false }),
    run({ repo, summarize: slowSummarize, deliver, dryRun: false }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual([byId(a, TANAKA).status, byId(b, TANAKA).status].sort(), ['sent', 'skipped']);
  assert.equal([byId(a, TANAKA), byId(b, TANAKA)].find(r => r.status === 'skipped').reason, 'already_claimed');
});

test('postMessage result unknown: not resent on the next runs, even concurrently', async () => {
  const repo = setup();
  let calls = 0;
  await run({ repo, only: [TANAKA], dryRun: false, deliver: async () => { calls++; throw new DeliveryError('delivery_unknown'); } });
  const ok = async () => { calls++; return okDeliver(); };
  const reruns = await Promise.all([1, 2, 3].map(() => run({ repo, only: [TANAKA], dryRun: false, deliver: ok })));
  assert.equal(calls, 1);
  assert.ok(reruns.every(r => byId(r, TANAKA).reason === 'previous_unknown'));
});
