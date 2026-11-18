import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledWeeklyDigest, checkDigestConfig } from '../src/jobs/scheduled.js';
import { createMemoryRepo, mockPosts, mockSummarize, mockPeople, MOCK_TEAM_ID } from '../src/jobs/mock.js';
import { targetWeek } from '../src/jobs/weeklyDigest.js';

const NOW = Date.parse('2026-11-02T00:00:00Z'); // 月曜 09:00 JST（cron 0 0 * * 1）
const [TANAKA] = mockPeople.map(p => p.id);
const baseEnv = { DB: {}, ALLOWED_SLACK_TEAM_ID: MOCK_TEAM_ID, GEMINI_API_KEY: 'fake-key', GEMINI_MODEL: 'fake-model' };

function harness({ authTeam = MOCK_TEAM_ID, postMessage = 'ok' } = {}) {
  const repo = createMemoryRepo({ posts: mockPosts(targetWeek(new Date(NOW))) });
  const calls = [];
  const logs = { info: [], error: [] };
  const fetch = async (url, init) => {
    const method = url.split('/').pop();
    calls.push({ method, body: JSON.parse(init.body), auth: init.headers.Authorization });
    if (method === 'auth.test') return Response.json({ ok: true, team_id: authTeam, user_id: 'U00000BOT', bot_id: 'B00000BOT' });
    if (method === 'conversations.open') return Response.json({ ok: true, channel: { id: 'D00000MOCK' } });
    if (method === 'chat.postMessage') {
      if (postMessage === 'throw') throw new Error('network down');
      return Response.json({ ok: true, channel: 'D00000MOCK', ts: '1.0' });
    }
    throw new Error(`unexpected ${url}`);
  };
  const geminiArgs = [];
  const scheduled = createScheduledWeeklyDigest({
    createRepository: db => { assert.equal(db, baseEnv.DB); return repo; },
    createGemini: args => { geminiArgs.push(args); return { summarize: mockSummarize }; },
    fetch,
    log: { info: m => logs.info.push(m), error: m => logs.error.push(m) },
  });
  const run = env => scheduled({ scheduledTime: NOW }, env, { waitUntil: () => {} });
  return { repo, calls, logs, geminiArgs, run, sent: () => calls.filter(c => c.method === 'chat.postMessage') };
}

test('requires backend factories to be injected', () => {
  assert.throws(() => createScheduledWeeklyDigest({}), /createRepository and createGemini/);
});

test('config check: dry-run is default, live modes need token, live-test needs explicit recipients', () => {
  assert.deepEqual(checkDigestConfig(baseEnv), { mode: 'dry-run', only: undefined });
  assert.deepEqual(checkDigestConfig({}).missing, ['DB', 'ALLOWED_SLACK_TEAM_ID', 'GEMINI_API_KEY', 'GEMINI_MODEL']);
  assert.deepEqual(checkDigestConfig({ ...baseEnv, DIGEST_MODE: 'live' }).missing, ['SLACK_BOT_TOKEN']);
  assert.deepEqual(checkDigestConfig({ ...baseEnv, DIGEST_MODE: 'live-test', SLACK_BOT_TOKEN: 'xoxb-fake' }).missing, ['DIGEST_ONLY_PERSON_IDS']);
  assert.equal(checkDigestConfig({ ...baseEnv, DIGEST_MODE: 'yolo' }).error, 'invalid_digest_mode');
  assert.deepEqual(checkDigestConfig({ ...baseEnv, DIGEST_MODE: 'live-test', SLACK_BOT_TOKEN: 'x', DIGEST_ONLY_PERSON_IDS: ' a , b ' }).only, ['a', 'b']);
});

test('missing config skips without touching DB, Gemini or Slack', async () => {
  const h = harness();
  assert.deepEqual(await h.run({}), { skipped: 'missing_config' });
  assert.equal(h.calls.length, 0);
  assert.equal(h.geminiArgs.length, 0);
  assert.match(h.logs.error[0], /missing_config \(DB, ALLOWED_SLACK_TEAM_ID, GEMINI_API_KEY, GEMINI_MODEL\)/);
});

test('dry-run with token: checks auth.test, passes Gemini config, sends nothing, logs only counts', async () => {
  const h = harness();
  const summary = await h.run({ ...baseEnv, SLACK_BOT_TOKEN: 'xoxb-fake' });
  assert.deepEqual(h.calls.map(c => c.method), ['auth.test']);
  assert.deepEqual(h.geminiArgs[0].apiKey, 'fake-key');
  assert.equal(h.geminiArgs[0].model, 'fake-model');
  assert.equal(summary.dry_run, true);
  assert.equal(summary.counts.dry_run, 1);
  assert.deepEqual(h.repo.deliveries, {});
  const logged = h.logs.info.join('\n');
  assert.match(logged, /auth\.test ok is_bot=true team_match=true/);
  assert.doesNotMatch(logged, /xoxb|感謝|田中|U00000MOCK/);
});

test('live-test sends only to the listed person, once per week', async () => {
  const h = harness();
  const env = { ...baseEnv, SLACK_BOT_TOKEN: 'xoxb-fake', DIGEST_MODE: 'live-test', DIGEST_ONLY_PERSON_IDS: TANAKA };
  const first = await h.run(env);
  assert.deepEqual(first.counts, { sent: 1 });
  assert.equal(h.sent().length, 1);
  assert.equal(h.calls.find(c => c.method === 'conversations.open').body.users, mockPeople[0].slack_user_id);
  const second = await h.run(env);
  assert.deepEqual(second.counts, { 'skipped:already_sent': 1 });
  assert.equal(h.sent().length, 1);
});

test('live refuses to send when the bot token belongs to another workspace', async () => {
  const h = harness({ authTeam: 'T00OTHERWS' });
  assert.deepEqual(await h.run({ ...baseEnv, SLACK_BOT_TOKEN: 'xoxb-fake', DIGEST_MODE: 'live' }), { skipped: 'slack_team_mismatch' });
  assert.equal(h.sent().length, 0);
});

test('network failure during postMessage is recorded as unknown and not retried', async () => {
  const h = harness({ postMessage: 'throw' });
  const env = { ...baseEnv, SLACK_BOT_TOKEN: 'xoxb-fake', DIGEST_MODE: 'live' };
  assert.deepEqual((await h.run(env)).counts, { 'unknown:delivery_unknown': 1, 'held:insufficient_authors': 1, 'skipped:no_consent': 1, 'skipped:workspace_not_allowed': 1 });
  assert.equal((await h.run(env)).counts['skipped:previous_unknown'], 1);
  assert.equal(h.sent().length, 1);
});

test('an unexpected DB error aborts the run without throwing out of scheduled()', async () => {
  const logs = [];
  const scheduled = createScheduledWeeklyDigest({
    createRepository: () => ({ listPersonPosts: async () => { throw new Error('Database unavailable SELECT secret'); } }),
    createGemini: () => ({ summarize: mockSummarize }),
    fetch: async () => assert.fail('no network'),
    log: { info() {}, error: m => logs.push(m) },
  });
  await scheduled({ scheduledTime: NOW }, baseEnv, { waitUntil: () => {} });
  assert.deepEqual(logs, ['[weekly-digest] aborted: Error']);
});
