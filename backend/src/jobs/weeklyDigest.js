// Issue #2: 人物向け Good/Motto 週次ブリーフのバッチ処理。
// 外部依存（DB・要約AI・Slack送信）はすべて引数で差し替え可能にし、
// モック（Phase 1）と実サービス（Phase 2）で同じ処理を使う。

import { DeliveryError } from '../slack/client.js';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const MIN_DISTINCT_AUTHORS = 3;
const MAX_SUMMARY_CHARS = 400;

/**
 * 実行時刻 now の直前の「月曜0時(JST)〜翌月曜0時(JST)」を対象週とする。
 * 月曜09:00 JST に実行すると、前週の月〜日が対象になる。
 */
export function targetWeek(now = new Date()) {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const sinceMonday = (jst.getUTCDay() + 6) % 7;
  const thisMondayJst = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() - sinceMonday);
  const to = new Date(thisMondayJst - JST_OFFSET_MS);
  const from = new Date(to.getTime() - 7 * DAY_MS);
  const label = d => new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
  return { key: label(from), from, to, startLabel: label(from), endLabel: label(new Date(to.getTime() - DAY_MS)) };
}

/** Slack に出す本文。plain_text のみでメンション・リンク展開をさせない。 */
export function digestPayload(summary, week) {
  const range = `${week.startLabel.slice(5).replace('-', '/')}〜${week.endLabel.slice(5).replace('-', '/')}`;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: '🌱 今週のGood / Motto' } },
    { type: 'context', elements: [{ type: 'plain_text', text: `${range} に届いた声をまとめました` }] },
  ];
  if (summary.good) blocks.push({ type: 'section', text: { type: 'plain_text', text: `🌟 Good\n${summary.good}` } });
  if (summary.motto) blocks.push({ type: 'section', text: { type: 'plain_text', text: `🌿 Motto\n${summary.motto}` } });
  blocks.push({ type: 'context', elements: [{ type: 'plain_text', text: '投稿の原文や投稿者は表示していません。' }] });
  const text = ['今週のGood / Motto', summary.good && `Good: ${summary.good}`, summary.motto && `Motto: ${summary.motto}`].filter(Boolean).join('\n');
  return { text, blocks, mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false };
}

const normalize = s => s.replace(/[\s、。，．,.!！?？「」『』"'（）()]/g, '');

/**
 * 要約が原文・他人の名前を含んでいないか検査する。
 * 原文の連続12文字（短い投稿は全文）が要約に現れたら「原文転送」とみなす。
 */
export function findLeak(summaryText, posts, forbiddenNames = []) {
  const s = normalize(summaryText);
  for (const name of forbiddenNames) if (name && s.includes(normalize(name))) return 'contains_name';
  for (const post of posts) {
    const t = normalize(post.text);
    if (t.length < 12) { if (t.length >= 6 && s.includes(t)) return 'contains_raw_text'; continue; }
    for (let i = 0; i + 12 <= t.length; i++) if (s.includes(t.slice(i, i + 12))) return 'contains_raw_text';
  }
  return null;
}

// 再識別につながりやすい具体情報（数字・日時・引用）を含む要約は自動送信せず手動確認に回す
const SPECIFIC_DETAIL = /[0-9０-９]|「|」|『|』|"|“|”|号室|曜日|時ごろ|時頃/;

function validateSummary(summary, posts, forbiddenNames) {
  if (!summary || typeof summary !== 'object') return 'summary_invalid';
  for (const key of ['good', 'motto']) {
    if (summary[key] != null && typeof summary[key] !== 'string') return 'summary_invalid';
    if ((summary[key] || '').length > MAX_SUMMARY_CHARS) return 'summary_too_long';
  }
  if (!summary.good?.trim() && !summary.motto?.trim()) return 'summary_empty';
  const text = `${summary.good || ''}\n${summary.motto || ''}`;
  const leak = findLeak(text, posts, forbiddenNames);
  if (leak) return leak;
  if (summary.needs_review === true || SPECIFIC_DETAIL.test(text)) return 'needs_manual_review';
  return null;
}

const optedIn = recipient => recipient.feedback_opt_in === 1 || recipient.feedback_opt_in === true;

/** 送信対象として不適格な理由を返す（適格なら null）。 */
function recipientProblem(recipient, allowedTeamId) {
  if (!recipient) return 'unknown_person';
  if (recipient.slack_team_id !== allowedTeamId) return 'workspace_not_allowed';
  if (!optedIn(recipient)) return 'no_consent';
  if (!recipient.slack_user_id) return 'no_slack_id';
  return null;
}

/** 送信しなかった claim を failed に戻す。戻せなくても sending のまま残るだけで、再送はされない。 */
async function releaseClaim(repo, personId, weekKey, reason, log) {
  try { await repo.finishDelivery(personId, weekKey, { status: 'failed', error: reason }); } catch (error) {
    log.error?.(`[weekly-digest] could not release claim person=${personId}: ${error?.name || 'Error'}`);
  }
}

/**
 * 週次バッチ本体。項目名は docs/auth/slack-oidc-v1.md §5 の D1 スキーマに合わせる。
 * 匿名性チェック（独立投稿者数・原文一致・具体情報）は暫定の防御であり、匿名性を保証するものではない。
 * @param {object} deps
 * @param {object} deps.repo       listPersonPosts / getRecipient / listDisplayNames / getDelivery / claimDelivery / finishDelivery
 * @param {Function} deps.summarize ({ good: string[], motto: string[] }) => Promise<{good, motto, needs_review?}>
 * @param {string} deps.allowedTeamId ALLOWED_SLACK_TEAM_ID。これと一致するワークスペースの人だけに送る
 * @param {Function} [deps.deliver] (slackUserId, payload) => Promise<{channel, ts}>（dryRun時は不要）
 * @param {boolean} [deps.dryRun=true] 送信も送信履歴の記録もしない
 * @param {string[]} [deps.only]   対象人物IDを限定（テスト送信用）
 */
export async function runWeeklyDigest({
  repo, summarize, deliver, allowedTeamId, now = new Date(), dryRun = true, only, minAuthors = MIN_DISTINCT_AUTHORS, log = console,
}) {
  if (!allowedTeamId) throw new Error('allowedTeamId (ALLOWED_SLACK_TEAM_ID) is required');
  if (!dryRun && typeof deliver !== 'function') throw new Error('deliver is required when dryRun=false');
  const week = targetWeek(now);
  const posts = (await repo.listPersonPosts({ from: week.from, to: week.to })).filter(p => p.target_type === 'person');
  const byPerson = new Map();
  for (const post of posts) {
    if (!byPerson.has(post.target_id)) byPerson.set(post.target_id, []);
    byPerson.get(post.target_id).push(post);
  }
  const allNames = await repo.listDisplayNames();
  const results = [];
  const record = (personId, status, extra = {}) => {
    results.push({ person_id: personId, status, ...extra });
    log.info?.(`[weekly-digest] week=${week.key} person=${personId} status=${status}${extra.reason ? ` reason=${extra.reason}` : ''}`);
  };

  for (const [personId, personPosts] of byPerson) {
    if (only && !only.includes(personId)) continue;
    const recipient = await repo.getRecipient(personId);
    const ineligible = recipientProblem(recipient, allowedTeamId);
    if (ineligible) { record(personId, 'skipped', { reason: ineligible }); continue; }
    // 自分自身への投稿は独立した声として数えない
    const independent = personPosts.filter(p => p.author_person_id !== personId);
    const authors = new Set(independent.map(p => p.author_person_id)).size;
    if (authors < minAuthors) { record(personId, 'held', { reason: 'insufficient_authors', authors }); continue; }

    const existing = await repo.getDelivery(personId, week.key);
    if (existing && existing.status !== 'failed') {
      record(personId, 'skipped', { reason: existing.status === 'sent' ? 'already_sent' : `previous_${existing.status}` });
      continue;
    }

    // AIへは本文と Good/Motto だけを渡す（投稿者IDや日時は渡さない）
    const input = {
      good: independent.filter(p => p.sentiment === 'good').map(p => p.text),
      motto: independent.filter(p => p.sentiment === 'motto').map(p => p.text),
    };
    let summary;
    try { summary = await summarize(input); } catch (error) {
      log.error?.(`[weekly-digest] summarize failed person=${personId}: ${error?.message}`);
      record(personId, 'failed', { reason: 'summarize_failed' }); continue;
    }
    const forbidden = allNames.filter(name => name !== recipient.display_name);
    const problem = validateSummary(summary, independent, forbidden);
    if (problem) { record(personId, 'held', { reason: problem }); continue; }
    const payload = digestPayload({ good: summary.good?.trim(), motto: summary.motto?.trim() }, week);

    if (dryRun) { record(personId, 'dry_run', { authors, preview: payload.text }); continue; }

    // 送信前に「送信中」を確保し、並行実行・再実行での二重送信を防ぐ。
    // allowedTeamId を渡すので、対応した repo は同意・チームを claim の DB 条件にも含められる。
    if (!(await repo.claimDelivery(personId, week.key, { allowedTeamId }))) {
      // claim できなかった理由が同意撤回なら、それを記録する（送信はしない）
      const why = recipientProblem(await repo.getRecipient(personId).catch(() => null), allowedTeamId);
      record(personId, 'skipped', { reason: why ? `${why}_before_send` : 'already_claimed' });
      continue;
    }

    // 要約中に同意撤回・チーム変更・Slack ID 変更があり得るため、送信直前に受信者を取り直して再検証する。
    // （この確認と送信の間のごく短い競合は残る。完全な保証ではない）
    let current;
    try { current = await repo.getRecipient(personId); } catch (error) {
      await releaseClaim(repo, personId, week.key, 'recipient_recheck_failed', log);
      record(personId, 'failed', { reason: 'recipient_recheck_failed' });
      continue;
    }
    const nowIneligible = recipientProblem(current, allowedTeamId);
    if (nowIneligible) {
      await releaseClaim(repo, personId, week.key, nowIneligible, log);
      record(personId, 'skipped', { reason: `${nowIneligible}_before_send` });
      continue;
    }
    let sent;
    try {
      sent = await deliver(current.slack_user_id, payload);
    } catch (error) {
      const code = error instanceof DeliveryError ? error.code : 'unexpected_error';
      // 結果不明は自動再送しない（Slackで到着を確認してから手動で failed に戻す）
      const status = code === 'delivery_unknown' ? 'unknown' : 'failed';
      await repo.finishDelivery(personId, week.key, { status, error: code });
      log.error?.(`[weekly-digest] deliver ${status} person=${personId} error=${code}`);
      record(personId, status, { reason: code, ...(error?.retryAfter ? { retry_after: error.retryAfter } : {}) });
      continue;
    }
    // 送信は成功済み。ここで記録に失敗しても failed にはしない（再送の原因になるため）
    try {
      await repo.finishDelivery(personId, week.key, { status: 'sent', ts: sent.ts, channel: sent.channel });
      record(personId, 'sent', { authors });
    } catch (error) {
      log.error?.(`[weekly-digest] sent but failed to record person=${personId}: ${error?.message}`);
      // 'sending' のまま残れば再実行でもスキップされる。可能なら unknown（要手動照合）に更新を試みる
      await repo.finishDelivery(personId, week.key, { status: 'unknown', error: 'record_failed' }).catch(() => {});
      record(personId, 'unknown', { reason: 'record_failed' });
    }
  }
  return { week: week.key, dry_run: dryRun, results };
}
