// Cloudflare Cron Trigger から呼ぶ週次ブリーフの入口。
//
// バックエンド（#4）の Worker（backend/src/index.mjs）で次のように組み込む:
//   import { createScheduledWeeklyDigest } from './jobs/scheduled.js';
//   export default {
//     fetch: app.fetch,
//     scheduled: createScheduledWeeklyDigest({ createRepository, createGemini }),
//   };
// wrangler.jsonc: "triggers": { "crons": ["0 0 * * 1"] }   // 毎週月曜 00:00 UTC = 09:00 JST
//
// D1 repo と Gemini は #4 のモジュールを引数で受け取る（このファイルから直接 import しない）。
//
// 環境変数（Worker Secret / vars）:
//   DB                     D1 バインディング（必須）
//   ALLOWED_SLACK_TEAM_ID  送信を許可する学校ワークスペース（必須）
//   GEMINI_API_KEY, GEMINI_MODEL  要約（必須）
//   SLACK_BOT_TOKEN        Bot Token（live では必須。dry-run でも設定されていれば auth.test で疎通確認する）
//   DIGEST_MODE            dry-run（既定）| live-test | live
//   DIGEST_ONLY_PERSON_IDS live-test で送ってよい people.id（カンマ区切り）。明示同意したテスト受信者だけを書く
import { runWeeklyDigest } from './weeklyDigest.js';
import { authTest, sendDm } from '../slack/client.js';

const MODES = new Set(['dry-run', 'live-test', 'live']);

/** 設定を検証し、足りなければ理由を返す（値そのものはログに出さない）。 */
export function checkDigestConfig(env) {
  const mode = env.DIGEST_MODE || 'dry-run';
  const missing = [];
  if (!MODES.has(mode)) return { mode, error: 'invalid_digest_mode' };
  if (!env.DB) missing.push('DB');
  if (!env.ALLOWED_SLACK_TEAM_ID) missing.push('ALLOWED_SLACK_TEAM_ID');
  if (!env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  if (!env.GEMINI_MODEL) missing.push('GEMINI_MODEL');
  if (mode !== 'dry-run' && !env.SLACK_BOT_TOKEN) missing.push('SLACK_BOT_TOKEN');
  const only = (env.DIGEST_ONLY_PERSON_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (mode === 'live-test' && only.length === 0) missing.push('DIGEST_ONLY_PERSON_IDS');
  if (missing.length) return { mode, error: 'missing_config', missing };
  return { mode, only: only.length ? only : undefined };
}

/** ログ用に、本文や人物情報を含めず件数だけに集計する。 */
export function summarizeReport(report) {
  const counts = {};
  for (const r of report.results) {
    const key = r.reason ? `${r.status}:${r.reason}` : r.status;
    counts[key] = (counts[key] || 0) + 1;
  }
  return { week: report.week, dry_run: report.dry_run, total: report.results.length, counts };
}

export function createScheduledWeeklyDigest({ createRepository, createGemini, fetch: fetchImpl = globalThis.fetch, log = console } = {}) {
  if (typeof createRepository !== 'function' || typeof createGemini !== 'function') {
    throw new TypeError('createRepository and createGemini are required');
  }

  async function run(event, env) {
    const config = checkDigestConfig(env);
    if (config.error) {
      log.error(`[weekly-digest] skipped: ${config.error}${config.missing ? ` (${config.missing.join(', ')})` : ''}`);
      return { skipped: config.error };
    }
    const dryRun = config.mode === 'dry-run';

    // Bot Token の疎通とワークスペース一致を確認する。live では不一致・失敗なら送信しない。
    if (env.SLACK_BOT_TOKEN) {
      try {
        const auth = await authTest(env.SLACK_BOT_TOKEN, fetchImpl);
        const teamMatch = auth.team_id === env.ALLOWED_SLACK_TEAM_ID;
        log.info?.(`[weekly-digest] slack auth.test ok is_bot=${auth.is_bot} team_match=${teamMatch}`);
        if (!dryRun && (!teamMatch || !auth.is_bot)) {
          log.error('[weekly-digest] skipped: bot token is not a bot of the allowed workspace');
          return { skipped: 'slack_team_mismatch' };
        }
      } catch (error) {
        log.error(`[weekly-digest] slack auth.test failed: ${error?.code || 'error'}`);
        if (!dryRun) return { skipped: 'slack_auth_failed' };
      }
    }

    const repo = createRepository(env.DB);
    const { summarize } = createGemini({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, fetch: fetchImpl });
    const report = await runWeeklyDigest({
      repo, summarize, dryRun, only: config.only,
      allowedTeamId: env.ALLOWED_SLACK_TEAM_ID,
      now: new Date(event.scheduledTime),
      deliver: (slackUserId, payload) => sendDm(slackUserId, payload, env.SLACK_BOT_TOKEN, fetchImpl),
      // 個別ログに本文は含まれない（status/reason/person_idのみ）
      log: { info: () => {}, error: message => log.error(message) },
    });
    const summary = summarizeReport(report);
    log.info?.(`[weekly-digest] mode=${config.mode} ${JSON.stringify(summary)}`);
    return summary;
  }

  return async function scheduled(event, env, ctx) {
    const task = run(event, env).catch(error => {
      // DB停止などで途中終了しても、送信済みは sending/sent が残るので再実行で二重送信しない
      log.error(`[weekly-digest] aborted: ${error?.name || 'Error'}`);
    });
    if (ctx?.waitUntil) ctx.waitUntil(task); else await task;
    return task;
  };
}
