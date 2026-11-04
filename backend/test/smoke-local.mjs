// 実Slack/Cloudflareへ接続せず、ローカルWranglerの停止・再起動までHTTP確認する。
// 実行: npm run test:smoke --prefix backend （全体上限180秒）
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const backend = fileURLToPath(new URL('..', import.meta.url));
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const base = 'http://127.0.0.1:8787/api/v1';
const origin = 'http://localhost:5173';
const deadline = AbortSignal.timeout(180000);
const childEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
let server;
const finished = new Map();

async function stop() {
  if (!server) return;
  const child = server;
  server = undefined;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const exited = finished.get(child);
  const stopped = await Promise.race([exited.then(() => true), delay(5000, false)]);
  if (!stopped) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await exited;
  }
  finished.delete(child);
}

async function start() {
  server = spawn(process.execPath, [wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', '8787',
    '--var', 'ENV:development', '--var', `ALLOWED_ORIGIN:${origin}`, '--log-level', 'error'],
  { cwd: backend, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const child = server;
  let addressInUse = false;
  // Wranglerの設定表示・URL・ヘッダーを転記しない。
  child.stdout.on('data', () => {});
  child.stderr.on('data', data => { if (/EADDRINUSE|address already in use/i.test(data.toString())) addressInUse = true; });
  const exited = once(child, 'exit');
  finished.set(child, exited);
  let childExited = false;
  exited.then(() => { childExited = true; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (childExited || addressInUse) throw new Error('Wranglerを起動できません。8787番ポートの利用状況を確認してください');
    try {
      const response = await fetch(`${base}/me`, { signal: AbortSignal.any([deadline, AbortSignal.timeout(1000)]) });
      if (response.status === 401) return;
    } catch { /* 起動中はHTTP受付を待つ */ }
    deadline.throwIfAborted();
    await delay(200);
  }
  throw new Error('WranglerのHTTP受付が上限時間内に始まりませんでした');
}

async function http(path, { method = 'GET', cookie, body } = {}) {
  const response = await fetch(`${base}${path}`, { method, redirect: 'manual',
    signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
    headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return response;
}

// 他の開発サーバーへ誤ってリクエストしない。
try {
  await fetch(`${base}/me`, { signal: AbortSignal.timeout(1000) });
  throw new Error('8787番ポートが使用中です。既存の開発サーバーを停止してから実行してください');
} catch (error) {
  if (error.message.startsWith('8787')) throw error;
}

try {
  for (const args of [['d1', 'migrations', 'apply', 'DB', '--local'], ['d1', 'execute', 'DB', '--local', '--file', 'seeds/development.sql']]) {
    const result = spawnSync(process.execPath, [wrangler, ...args], { cwd: backend, env: childEnv, stdio: 'inherit', timeout: 60000 });
    assert.equal(result.status, 0, 'ローカルD1の準備に失敗しました');
  }
  await start();
  const login = await http('/auth/slack/login');
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('Location'), '/');
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await http('/me', { cookie })).status, 200);
  const post = await http('/posts', { method: 'POST', cookie,
    body: { text: 'HTTP確認用の架空の投稿', sentiment: 'good', target_type: 'place', target_id: 'kitchen' } });
  assert.equal(post.status, 201);
  console.log('PASS: login 302 → /me 200 → post 201');
  await stop();
  await start();
  assert.equal((await http('/me', { cookie })).status, 200);
  console.log('PASS: Wrangler再起動後、再ログインせず同じCookieで /me 200');
  const logout = await http('/auth/logout', { method: 'POST', cookie });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await http('/me', { cookie })).status, 401);
  console.log('PASS: logout 204 → 同じCookieで /me 401');
} finally {
  await stop();
}
