// Cloudflare Cron Trigger から呼ぶ週次ブリーフの入口。
// バックエンド（#4）の Worker で `scheduled` にこの関数を渡し、wrangler 設定に
//   "triggers": { "crons": ["0 0 * * 1"] }   // 毎週月曜 00:00 UTC = 09:00 JST
// を追加して使う。
import { runWeeklyDigest, targetWeek } from './weeklyDigest.js';
import { createMemoryRepo, mockPosts, mockSummarize, MOCK_TEAM_ID } from './mock.js';

export async function scheduledWeeklyDigest(event, env, ctx) {
  const now = new Date(event.scheduledTime);
  // D1の人物・投稿・送信履歴（#4）が用意されるまでは、モックでdry-runのみ行う。
  // 本番データが無い状態でモックをSlackへ送ることはしない。
  if (!env.DB) {
    const repo = createMemoryRepo({ posts: mockPosts(targetWeek(now)) });
    ctx.waitUntil(runWeeklyDigest({ repo, summarize: mockSummarize, allowedTeamId: MOCK_TEAM_ID, now, dryRun: true })
      .then(report => console.log(JSON.stringify(report))));
    return;
  }
  console.warn('[weekly-digest] D1 repo is not wired yet; skipped');
}
