// 固定コミットを一時領域に展開するだけで、checkout/mergeや他担当のコード変更は行わない。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, cp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyWeekly } from './verify-weekly.mjs';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(backend, '..');
const origin = 'http://127.0.0.1:5173';
const api = `${origin}/api/v1`;
const WEB = 'e605317';
const WEEKLY = '9621483';
const temp = await mkdtemp(join(tmpdir(), 'good-motto-verify-'));
const children = new Map();
// 実際のSecretや接続設定を子プロセスに引き継がない。
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'SystemRoot'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { CI: 'true', WRANGLER_SEND_METRICS: 'false', PLAYWRIGHT_BROWSERS_PATH: join(temp, 'browsers'),
  XDG_CONFIG_HOME: join(temp, 'config'), WRANGLER_LOG_PATH: join(temp, 'wrangler.log') });
const deadline = AbortSignal.timeout(600000);
let originalStatus, originalRefs;
let cleaning;
let activeBrowser;

function start(command, args, cwd, extra = {}) {
  deadline.throwIfAborted();
  const child = spawn(command, args, { cwd, env: { ...env, ...extra }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { output: '', done: false };
  child.stdout.on('data', data => { state.output = (state.output + data).slice(-100000); });
  child.stderr.on('data', data => { state.output = (state.output + data).slice(-100000); });
  state.exit = once(child, 'exit').then(([code]) => { state.done = true; return code; }, () => { state.done = true; return -1; });
  children.set(child, state);
  return child;
}
async function stop(child) {
  const state = children.get(child);
  if (!state) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  if (!await Promise.race([state.exit.then(() => true), delay(3000, false)])) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await state.exit;
  children.delete(child);
}
async function command(program, args, cwd = root, timeout = 120000) {
  const child = start(program, args, cwd);
  const state = children.get(child);
  let timer;
  try {
    const code = await Promise.race([state.exit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${program} ${args[0]}: ${timeout}ms timeout`)), timeout);
    })]);
    if (code !== 0) throw new Error(`${program} ${args[0]} failed (exit ${code})`);
    return state.output;
  } finally { clearTimeout(timer); await stop(child); }
}
const git = (...args) => command('git', ['--no-optional-locks', ...args]);
async function cleanup() {
  if (!cleaning) cleaning = (async () => {
    await activeBrowser?.close();
    for (const child of [...children.keys()].reverse()) await stop(child);
    await rm(temp, { recursive: true, force: true });
  })();
  return cleaning;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().then(() => process.exit(1)); });
deadline.addEventListener('abort', () => { console.error('verify:branches: 600秒の上限に到達'); void cleanup().then(() => process.exit(1)); });

async function extract(commit, paths, directory) {
  const sha = (await git('rev-parse', '--verify', `${commit}^{commit}`)).trim();
  assert.ok(sha.startsWith(commit));
  // バイナリarchiveを文字列化しない。gitは読み取りだけ。
  await mkdir(directory, { recursive: true });
  const archive = join(directory, 'source.tar');
  await command('git', ['archive', '--format=tar', `--output=${archive}`, sha, ...paths]);
  await command('tar', ['-xf', archive, '-C', directory]);
  await rm(archive);
  return sha;
}
async function vacant(port) {
  // 他の開発サーバーを停止・操作しない。
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', () => reject(new Error(`${port}番ポートが使用中です。停止してから再実行してください`)));
    server.listen(port, '127.0.0.1', resolvePromise);
  });
  await new Promise(resolvePromise => server.close(resolvePromise));
}
async function ready(child, url, expected) {
  for (let i = 0; i < 150; i++) {
    const state = children.get(child);
    if (state.done || /EADDRINUSE|address already in use/i.test(state.output)) throw new Error('検証用サーバーを起動できません');
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).status === expected) return; } catch { /* 起動待ち */ }
    deadline.throwIfAborted();
    await delay(200);
  }
  throw new Error(`検証用サーバーの起動待ちが上限を超えました: ${url}`);
}

async function nodeFallback(frontend) {
  const ts = (await import(pathToFileURL(join(frontend, 'node_modules/typescript/lib/typescript.js')))).default;
  const directory = join(temp, 'node-client');
  await mkdir(directory);
  for (const file of ['api', 'textValidation']) {
    const source = (await readFile(join(frontend, `src/${file}.ts`), 'utf8'))
      .replaceAll('import.meta.env', '({ VITE_API_MODE: "live", VITE_POST_MAX_CHARACTERS: "500" })')
      .replaceAll("'./textValidation'", "'./textValidation.mjs'");
    await writeFile(join(directory, `${file}.mjs`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  }
  const { createHttpApi, ApiError } = await import(pathToFileURL(join(directory, 'api.mjs')));
  const nativeFetch = globalThis.fetch;
  let cookie;
  const login = async user => {
    const response = await nativeFetch(`${api}/auth/slack/login?mock_user=${user}`, { redirect: 'manual' });
    assert.equal(response.status, 302); cookie = response.headers.get('Set-Cookie').split(';')[0];
  };
  globalThis.fetch = (url, init) => nativeFetch(url, { ...init, headers: { ...init.headers, Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } });
  try {
    const client = createHttpApi(origin);
    await assert.rejects(client.me(), error => error instanceof ApiError && error.status === 401);
    await login('pending');
    assert.equal((await client.me()).terms_accepted, false);
    await assert.rejects(client.analyze('架空の協力への感謝'), error => error.status === 403);
    assert.equal((await client.preferences({ terms_accepted: true, feedback_opt_in: false })).terms_accepted, true);
    assert.equal((await client.analyze('😀'.repeat(500))).target_type, 'place');
    await assert.rejects(client.analyze('😀'.repeat(501)), error => error.status === 400);
    assert.ok((await client.people('架空')).some(person => person.name === '架空ソラ'));
    assert.ok((await client.places()).some(place => place.id === 'kitchen'));
    assert.equal((await client.post({ text: '架空の協力への感謝', sentiment: 'good', target_type: 'place', target_id: 'kitchen' })).status, 'created');
    await client.logout();
    await assert.rejects(client.me(), error => error.status === 401);
  } finally { globalThis.fetch = nativeFetch; }
  console.log('PASS Web Node代替: 固定api.tsのcreateHttpApi → 実Vite proxy/Worker/D1（実ブラウザ・Cookie受理・画面分岐は未検証）');
}

async function browserFlow(browser) {
  const context = await browser.newContext();
  // ブラウザからもループバック以外へ接続しない。
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const visible = async locator => locator.waitFor({ state: 'visible' });
  const response = (path, status) => page.waitForResponse(res => new URL(res.url()).pathname === `/api/v1${path}` && res.status() === status);
  await page.goto(origin);
  await visible(page.getByRole('heading', { name: 'Slackでログイン', exact: true }));
  await page.getByRole('link', { name: 'Slackでログインする', exact: true }).click();
  await visible(page.getByLabel('メモの本文'));
  const cookie = (await context.cookies()).find(cookie => cookie.name === '__Host-gm_session');
  assert.ok(cookie, 'Secure Cookieが拒否された。モック環境限定の対応が必要');
  assert.equal(cookie.secure, true); assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Lax');
  console.log(`PASS Chromium ${browser.version()}: HTTP 127.0.0.1 + Vite proxyで__Host-gm_session（Secure）受理、ログイン後/me 200`);
  // 画面の本人状態を保持したままセッションを未同意ユーザーに切り替え、実APIの403を発生させる。
  assert.equal((await context.request.get(`${api}/auth/slack/login?mock_user=pending`, { maxRedirects: 0 })).status(), 302);
  await page.getByLabel('メモの本文').fill('架空の共有場所への感想');
  const forbidden = response('/posts/analyze', 403);
  await page.getByRole('button', { name: '内容を確認する' }).click();
  await forbidden;
  await visible(page.getByRole('heading', { name: '利用設定', exact: true }));
  await page.getByRole('checkbox', { name: '上記の扱いを確認し、サービスの利用に同意する' }).check();
  await page.getByRole('button', { name: '設定を保存する' }).click();
  await visible(page.getByLabel('メモの本文'));
  await page.getByLabel('メモの本文').fill('😀'.repeat(501));
  assert.equal(await page.getByRole('button', { name: '内容を確認する' }).isEnabled(), false);
  await page.getByLabel('メモの本文').fill('😀'.repeat(500));
  assert.equal(await page.getByRole('button', { name: '内容を確認する' }).isEnabled(), true);
  await page.getByLabel('メモの本文').fill('架空の共用キッチンが使いやすかった');
  await page.getByRole('button', { name: '内容を確認する' }).click();
  await visible(page.getByRole('heading', { name: '投稿内容を確認', exact: true }));
  await page.getByRole('button', { name: /候補：.*未確定/ }).click();
  await visible(page.getByRole('option', { name: /共用キッチン/ }));
  // placesとpeople双方の実レスポンスを、取り出したapi.tsが検査する。
  await page.getByRole('button', { name: '人物', exact: true }).click();
  await page.getByRole('combobox').fill('架空');
  await page.getByRole('option', { name: /架空ソラ/ }).click();
  const posted = response('/posts', 201);
  await page.getByRole('button', { name: '投稿する', exact: true }).click();
  const created = await (await posted).json();
  assert.equal(created.status, 'created'); assert.equal(typeof created.post_id, 'string');
  await visible(page.getByRole('heading', { name: '投稿しました', exact: true }));
  const loggedOut = response('/auth/logout', 204);
  await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
  assert.equal((await loggedOut).status(), 204); // Chromiumは204の本文をNetwork.getResponseBodyで取得できない。
  await visible(page.getByRole('heading', { name: 'Slackでログイン', exact: true }));
  assert.equal((await context.request.get(`${api}/me`)).status(), 401);
  // 投稿中セッション失効の401でもログイン画面へ戻る。
  await page.getByRole('link', { name: 'Slackでログインする', exact: true }).click();
  await visible(page.getByLabel('メモの本文'));
  await page.getByLabel('メモの本文').fill('架空の追加確認');
  await context.clearCookies();
  const unauthorized = response('/posts/analyze', 401);
  await page.getByRole('button', { name: '内容を確認する' }).click();
  await unauthorized;
  await visible(page.getByRole('heading', { name: 'Slackでログイン', exact: true }));
  await context.close();
  console.log('PASS Web画面: 実401→ログイン、実403→利用設定、同意→入力→分析→人物選択→投稿201→完了→ログアウト204、500/501文字');
}

try {
  await writeFile(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  originalStatus = await git('status', '--porcelain=v1', '--untracked-files=all');
  originalRefs = await git('show-ref', '--head');
  const web = join(temp, 'web'); const weekly = join(temp, 'weekly');
  console.log(`固定コミット Web=${await extract(WEB, ['frontend'], web)} Slack=${await extract(WEEKLY, ['backend/src', 'docs/slack/weekly-digest.md'], weekly)}`);
  const frontend = join(web, 'frontend');
  await verifyWeekly(weekly);
  for (const commit of [WEEKLY, WEB]) {
    const base = (await git('merge-base', 'origin/feat/4-backend-api', commit)).trim();
    // 3引数のmerge-treeはGitオブジェクト・index・refsを変更しない。
    const result = await git('merge-tree', base, 'origin/feat/4-backend-api', commit);
    const conflicts = [...result.matchAll(/^\+<<<<<<< /gm)].length;
    const paths = [...result.matchAll(/^changed in both\n(?:  .*\n)+/gm)]
      .map(match => match[0].match(/^  our\s+\d+ [a-f0-9]+ (.+)$/m)?.[1]).filter(Boolean);
    console.log(`merge-tree ${commit}: 衝突マーカー=${conflicts}; 両側変更=${[...new Set(paths)].join(', ') || 'なし'}`);
  }
  await vacant(8787); await vacant(5173);
  const local = join(temp, 'backend');
  await mkdir(local);
  for (const name of ['src', 'migrations', 'seeds', 'wrangler.jsonc', 'package.json']) await cp(join(backend, name), join(local, name), { recursive: true });
  await symlink(join(backend, 'node_modules'), join(local, 'node_modules'), 'dir');
  const vars = (await readFile(join(backend, '.dev.vars.example'), 'utf8')).replace(/^M5_DEVICE_KEY=.*$/m, 'M5_DEVICE_KEY=fake-integration-device-key');
  assert.ok(vars.includes(`ALLOWED_ORIGIN=${origin}`), '設定例と実際のViteのOriginを一致させてください');
  await writeFile(join(local, '.dev.vars'), vars);
  const wrangler = join(backend, 'node_modules/wrangler/bin/wrangler.js');
  const wr = args => command(process.execPath, [wrangler, ...args], local);
  await wr(['d1', 'migrations', 'apply', 'DB', '--local']);
  await wr(['d1', 'execute', 'DB', '--local', '--file', 'seeds/development.sql']);
  console.log('SETUP: 固定Webの依存を一時領域へインストール');
  await command('npm', ['ci', '--no-audit', '--no-fund'], frontend);
  const vite = start('npm', ['run', 'dev', '--', '--port', '5173', '--strictPort'], frontend,
    { VITE_API_MODE: 'live', VITE_POST_MAX_CHARACTERS: '500' });
  await ready(vite, origin, 200);
  // 既知の旧設定で403を再現。正しいOriginでの成功は修正後に確認。
  await writeFile(join(local, '.dev.vars'), vars.replace(origin, 'http://localhost:5173'));
  const broken = start('npm', ['run', 'dev'], local);
  await ready(broken, 'http://127.0.0.1:8787/api/v1/me', 401);
  const login = await fetch(`${api}/auth/slack/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const forbidden = await fetch(`${api}/posts/analyze`, { method: 'POST', headers: { Cookie: login.headers.get('Set-Cookie').split(';')[0],
    Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '架空のOrigin確認' }) });
  assert.equal(forbidden.status, 403); assert.equal((await forbidden.json()).error.code, 'FORBIDDEN');
  console.log('REPRODUCED: 旧ALLOWED_ORIGIN=http://localhost:5173 + 実Origin=http://127.0.0.1:5173 → analyze 403 FORBIDDEN');
  await stop(broken);
  await writeFile(join(local, '.dev.vars'), vars);
  const server = start('npm', ['run', 'dev'], local);
  await ready(server, 'http://127.0.0.1:8787/api/v1/me', 401);
  let browser;
  let browserUnavailable;
  try {
    await writeFile(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    console.log('SETUP: PlaywrightとChromiumを一時領域へインストール');
    await command('npm', ['install', '--no-audit', '--no-fund', '--save-exact', 'playwright@1.56.1'], temp);
    await command(process.execPath, [join(temp, 'node_modules/playwright/cli.js'), 'install', 'chromium'], temp);
    process.env.PLAYWRIGHT_BROWSERS_PATH = env.PLAYWRIGHT_BROWSERS_PATH;
    const { chromium } = await import(pathToFileURL(join(temp, 'node_modules/playwright/index.mjs')));
    browser = await chromium.launch({ headless: true });
    activeBrowser = browser;
  } catch (error) { browserUnavailable = error.message.split('\n')[0]; }
  if (browser) {
    try { await browserFlow(browser); } finally { await browser.close(); activeBrowser = undefined; }
  } else {
    console.log(`UNVERIFIED: Chromiumを起動できないため実ブラウザ未検証 (${browserUnavailable})`);
    await nodeFallback(frontend);
  }
  console.log('PASS: verify:branches 完了（実Slack/Gemini/Cloudflare/M5Stack実機は未検証）');
} finally {
  await cleanup();
  if (originalStatus !== undefined) {
    // cleanup後にgitだけを読み取る。期限切れ時には上のabort handlerが終了させる。
    assert.equal(await git('status', '--porcelain=v1', '--untracked-files=all'), originalStatus, '作業ツリーを変更してはいけません');
    assert.equal(await git('show-ref', '--head'), originalRefs, 'Git履歴・refsを変更してはいけません');
    console.log('PASS cleanup: 一時ファイル・サーバーを破棄、git statusと全refsは実行前と一致');
  }
}
