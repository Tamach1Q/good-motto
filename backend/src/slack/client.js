// Slack Web API の最小クライアント（依存なし・Node/Workers共通）。
// conversations.open → chat.postMessage で Bot から本人へDMを送る。

export class DeliveryError extends Error {
  constructor(code, status = 502, retryAfter) {
    super(code);
    Object.assign(this, { code, status, retryAfter });
  }
}

const KNOWN_ERRORS = new Set([
  'invalid_auth', 'token_revoked', 'missing_scope', 'account_inactive', 'user_not_found',
  'cannot_dm_bot', 'channel_not_found', 'not_allowed_token_type',
]);

export async function slackCall(method, body, token, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
  } catch { throw new DeliveryError('delivery_unknown'); }
  if (response.status === 429) throw new DeliveryError('slack_rate_limited', 429, response.headers.get('retry-after') || '60');
  if (!response.ok) throw new DeliveryError('delivery_unknown');
  let data;
  try { data = await response.json(); } catch { throw new DeliveryError('delivery_unknown'); }
  if (!data.ok) throw new DeliveryError(KNOWN_ERRORS.has(data.error) ? data.error : 'slack_rejected');
  return data;
}

/**
 * 本人宛てDMを送る。
 * conversations.open の失敗は「未送信」が確実なので通常エラー、
 * chat.postMessage の結果不明は delivery_unknown（自動再送しない）として扱う。
 */
export async function sendDm(slackUserId, payload, token, fetcher = fetch) {
  const conversation = await slackCall('conversations.open', { users: slackUserId }, token, fetcher)
    .catch(error => { throw error.code === 'delivery_unknown' ? new DeliveryError('slack_unreachable') : error; });
  if (!conversation.channel?.id) throw new DeliveryError('slack_rejected');
  const sent = await slackCall('chat.postMessage', { channel: conversation.channel.id, ...payload }, token, fetcher);
  if (!sent.ts || !sent.channel) throw new DeliveryError('delivery_unknown');
  return { channel: sent.channel, ts: sent.ts };
}
