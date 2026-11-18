import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWorker } from '../src/index.mjs';
import { createD1 } from './helpers/d1.mjs';
import { NOW } from './helpers/integration.mjs';

test('Staging Worker entrypoint handles HTTP and scheduled dry-run via D1 without real Slack DM', async t => {
  const db = await createD1(t);
  const calls = [];
  const logs = [];
  const worker = createWorker({
    fetch: async url => {
      const method = String(url).split('/').pop();
      calls.push(method);
      if (method === 'auth.test') return Response.json({
        ok: true, team_id: 'FAKE_TEAM_LOCAL', user_id: 'U00000BOT', bot_id: 'B00000BOT',
      });
      throw new Error('Unexpected external request: ' + method);
    },
    log: { info: value => logs.push(value), error: value => logs.push(value) },
  });
  const env = {
    DB: db, ENV: 'development', ALLOWED_ORIGIN: 'http://127.0.0.1:5173',
    ALLOWED_SLACK_TEAM_ID: 'FAKE_TEAM_LOCAL',
    GEMINI_API_KEY: 'fake-key', GEMINI_MODEL: 'fake-model',
    SLACK_BOT_TOKEN: 'xoxb-fake', DIGEST_MODE: 'dry-run',
  };
  const response = await worker.fetch(new Request('http://127.0.0.1/api/v1/me'), env);
  assert.equal(response.status, 401);
  const held = [];
  const summary = await worker.scheduled(
    { scheduledTime: NOW.getTime() }, env, { waitUntil(promise) { held.push(promise); } },
  );
  await Promise.all(held);
  assert.equal(summary.dry_run, true);
  assert.equal(summary.total, 0);
  assert.deepEqual(calls, ['auth.test']);
  assert.ok(logs.some(line => line.includes('team_match=true')));
  assert.ok(logs.every(line => !line.includes('xoxb-fake')));
});

test('Staging Worker does not touch external Slack when required cron configuration is missing', async () => {
  const logs = [];
  const worker = createWorker({
    fetch: () => assert.fail('network should not be used'),
    log: { info: () => {}, error: value => logs.push(value) },
  });
  const result = await worker.scheduled(
    { scheduledTime: NOW.getTime() }, {}, { waitUntil() {} },
  );
  assert.deepEqual(result, { skipped: 'missing_config' });
  assert.ok(logs[0].includes('missing_config'));
});
