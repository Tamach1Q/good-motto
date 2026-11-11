// Phase 1 用のモック（実DB・実Gemini・実Slackを呼ばない）。
// 人物・Slack ID・投稿はすべて架空。実在する人の情報をここに書かないこと。
// D1 実装ができたら同じインターフェースの repo に差し替える。

export const MOCK_TEAM_ID = 'T00000MOCK';

/** people テーブル（docs/auth/slack-oidc-v1.md §5）と同じ項目名の架空データ。 */
export const mockPeople = [
  { id: '00000000-0000-4000-8000-000000000001', slack_team_id: MOCK_TEAM_ID, slack_user_id: 'U00000MOCK1', display_name: '田中', feedback_opt_in: 1 },
  { id: '00000000-0000-4000-8000-000000000002', slack_team_id: MOCK_TEAM_ID, slack_user_id: 'U00000MOCK2', display_name: '佐藤', feedback_opt_in: 1 },
  { id: '00000000-0000-4000-8000-000000000003', slack_team_id: MOCK_TEAM_ID, slack_user_id: 'U00000MOCK3', display_name: '鈴木', feedback_opt_in: 0 },
  { id: '00000000-0000-4000-8000-000000000004', slack_team_id: MOCK_TEAM_ID, slack_user_id: 'U00000MOCK4', display_name: '高橋', feedback_opt_in: 1 },
  { id: '00000000-0000-4000-8000-000000000005', slack_team_id: 'T00OTHERWS', slack_user_id: 'U00000MOCK5', display_name: '伊藤', feedback_opt_in: 1 },
];
const [TANAKA, SATO, SUZUKI, , ITO] = mockPeople.map(p => p.id);
const author = n => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

/** 対象週 week（targetWeek() の戻り値）の月曜からd日後10時(JST)に収まる架空の投稿。 */
export function mockPosts(week) {
  const dayOf = d => new Date(week.from.getTime() + d * 24 * 60 * 60 * 1000 + 10 * 60 * 60 * 1000).toISOString();
  const post = (id, authorN, target, sentiment, text, d) =>
    ({ id, author_person_id: author(authorN), target_type: 'person', target_id: target, sentiment, text, created_at: dayOf(d) });
  return [
    // 田中: 独立した投稿者3人 → 送信対象
    post('post_m01', 1, TANAKA, 'good', '共用スペースの片付けを率先してやってくれて助かった', 1),
    post('post_m02', 2, TANAKA, 'good', '困っていたら声をかけてくれた', 2),
    post('post_m03', 3, TANAKA, 'motto', '夜遅くの通話の声がもう少し小さいと嬉しい', 3),
    post('post_m04', 3, TANAKA, 'good', 'ゴミ出しありがとう', 4),
    // 佐藤: 投稿者2人 → 保留
    post('post_m05', 1, SATO, 'good', '発表資料がわかりやすかった', 2),
    post('post_m06', 2, SATO, 'motto', '集合時間を守ってほしい', 5),
    // 鈴木: 受信に未同意 → 送信しない
    post('post_m07', 1, SUZUKI, 'good', '手伝ってくれてありがとう', 1),
    post('post_m08', 2, SUZUKI, 'good', '洗濯物を取り込んでくれた', 2),
    post('post_m09', 3, SUZUKI, 'motto', '鍵を閉め忘れないで', 3),
    // 伊藤: 別ワークスペース → 送信しない
    post('post_m10', 1, ITO, 'good', '道具を貸してくれた', 1),
    post('post_m11', 2, ITO, 'good', '掃除当番を代わってくれた', 2),
    post('post_m12', 3, ITO, 'good', '相談に乗ってくれた', 3),
    // 高橋: 投稿なし → 対象外
  ];
}

/** インメモリ repo。deliveries を外から渡せば永続化（CLIのファイル保存）にも使える。 */
export function createMemoryRepo({ people = mockPeople, posts = [], deliveries = {} } = {}) {
  const key = (personId, weekKey) => `${weekKey}:${personId}`;
  return {
    deliveries,
    async listPersonPosts({ from, to }) {
      return posts.filter(p => {
        const t = new Date(p.created_at).getTime();
        return p.target_type === 'person' && t >= from.getTime() && t < to.getTime();
      });
    },
    async getRecipient(personId) { return people.find(p => p.id === personId) || null; },
    async listDisplayNames() { return people.map(p => p.display_name); },
    async getDelivery(personId, weekKey) { return deliveries[key(personId, weekKey)] || null; },
    // 提案中の D1 実装と同じく、allowedTeamId が渡されたら受信同意・チームも claim の条件にする
    async claimDelivery(personId, weekKey, { allowedTeamId } = {}) {
      const current = deliveries[key(personId, weekKey)];
      if (current && current.status !== 'failed') return false;
      if (allowedTeamId) {
        const person = people.find(p => p.id === personId);
        if (!person || person.slack_team_id !== allowedTeamId || !(person.feedback_opt_in === 1 || person.feedback_opt_in === true)) return false;
      }
      deliveries[key(personId, weekKey)] = { status: 'sending', attempts: (current?.attempts || 0) + 1, updated_at: new Date().toISOString() };
      return true;
    },
    async finishDelivery(personId, weekKey, result) {
      const current = deliveries[key(personId, weekKey)] || {};
      deliveries[key(personId, weekKey)] = { ...current, ...result, updated_at: new Date().toISOString() };
    },
  };
}

/** ダミー要約。原文を一切使わず、件数の有無だけで定型文を作る（数字や固有の出来事は含めない）。 */
export async function mockSummarize({ good, motto }) {
  return {
    good: good.length ? '周囲への気配りや手助けが、感謝の声として届いています。' : '',
    motto: motto.length ? '生活のちょっとした配慮について、提案が届いています。少し意識してみると、より過ごしやすくなりそうです。' : '',
    needs_review: false,
  };
}
