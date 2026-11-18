// 週次ブリーフの手動実行（架空のモックデータを使用）。
//   node backend/scripts/weekly-digest.mjs                 … 送信せず本文を確認（dry-run、既定）
//   node --env-file=.env backend/scripts/weekly-digest.mjs --send --only=<person_id>
//                                                          … テスト受信者へだけ実際にDM送信
// オプション: --now=2026-11-02T00:00:00Z（実行時刻を指定）
//
// 実送信の宛先は Git 管理外の backend/.data/test-recipients.json に書く（実在のIDをリポジトリに置かないため）:
//   [{ "person_id": "<モックの人物ID>", "slack_team_id": "T...", "slack_user_id": "U..." }]
// ここに書くのは、本人からテストDMの受信OKをもらった人だけ。書かれた人はモック上で受信同意済みとして扱う。
// 実送信の本文には必ず【テスト送信】の表記が入る。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { runWeeklyDigest, targetWeek } from '../src/jobs/weeklyDigest.js';
import { createMemoryRepo, mockPeople, mockPosts, mockSummarize, MOCK_TEAM_ID } from '../src/jobs/mock.js';
import { sendDm } from '../src/slack/client.js';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const send = args.send === true;
const only = typeof args.only === 'string' ? args.only.split(',') : undefined;
const now = args.now ? new Date(args.now) : new Date();
if (Number.isNaN(now.getTime())) { console.error('--now が不正です'); process.exit(1); }

const dataDir = new URL('../.data/', import.meta.url);
let people = mockPeople;
let allowedTeamId = MOCK_TEAM_ID;
if (send) {
  if (!only) { console.error('実送信は --only=<person_id> で宛先を明示してください'); process.exit(1); }
  if (!process.env.SLACK_BOT_TOKEN?.startsWith('xoxb-')) { console.error('SLACK_BOT_TOKEN（xoxb-）が .env にありません'); process.exit(1); }
  if (!process.env.ALLOWED_SLACK_TEAM_ID) { console.error('ALLOWED_SLACK_TEAM_ID が .env にありません'); process.exit(1); }
  allowedTeamId = process.env.ALLOWED_SLACK_TEAM_ID;
  let testRecipients;
  try { testRecipients = JSON.parse(await readFile(new URL('test-recipients.json', dataDir), 'utf8')); } catch {
    console.error('backend/.data/test-recipients.json がありません（実送信の宛先はGit管理外のこのファイルに書きます）'); process.exit(1);
  }
  // テスト受信者だけ実IDに差し替えて同意済みにし、それ以外は送れない状態（同意なし）にする
  people = mockPeople.map(p => {
    const r = testRecipients.find(t => t.person_id === p.id);
    return r ? { ...p, slack_team_id: r.slack_team_id, slack_user_id: r.slack_user_id, feedback_opt_in: 1 } : { ...p, feedback_opt_in: 0 };
  });
}

// 送信履歴をファイルに残し、再実行しても同じ週に二重送信しない
const storeUrl = new URL('slack-deliveries.json', dataDir);
let deliveries = {};
try { deliveries = JSON.parse(await readFile(storeUrl, 'utf8')); } catch {}

const TEST_NOTE = '【テスト送信】開発中の動作確認です。内容は架空のダミーデータから作ったもので、実際の投稿ではありません。';
const markAsTest = payload => ({
  ...payload,
  text: `${TEST_NOTE}\n${payload.text}`,
  blocks: [{ type: 'context', elements: [{ type: 'plain_text', text: TEST_NOTE }] }, ...payload.blocks],
});

const repo = createMemoryRepo({ people, posts: mockPosts(targetWeek(now)), deliveries });
const report = await runWeeklyDigest({
  repo, summarize: mockSummarize, now, only, dryRun: !send, allowedTeamId,
  deliver: (slackUserId, payload) => sendDm(slackUserId, markAsTest(payload), process.env.SLACK_BOT_TOKEN),
  log: { info: () => {}, error: console.error },
});

if (send) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(storeUrl, JSON.stringify(repo.deliveries, null, 2));
}
const nameOf = id => mockPeople.find(p => p.id === id)?.display_name ?? '?';
console.log(`対象週: ${report.week}〜（${report.dry_run ? 'dry-run：送信しません' : '実送信'}）`);
for (const r of report.results) {
  console.log(`\n■ ${nameOf(r.person_id)} (${r.person_id}): ${r.status}${r.reason ? ` (${r.reason})` : ''}${r.authors != null ? ` 投稿者${r.authors}人` : ''}`);
  if (r.preview) console.log(r.preview.replace(/^/gm, '   '));
}
if (report.results.some(r => r.status === 'failed' || r.status === 'unknown')) process.exitCode = 1;
