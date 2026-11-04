// D1の例外にはSQL・バインド値が含まれ得るため、HTTP側には詳細を渡さない。
export class DatabaseUnavailable extends Error {
  constructor() { super('Database unavailable'); }
}

export function sevenCalendarDaysStart(now) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() - 6) - 9 * 60 * 60 * 1000);
}

export function createRepository(db, { now = () => new Date() } = {}) {
  const query = async (sql, values = [], method = 'all') => {
    try {
      if (!db?.prepare) throw new DatabaseUnavailable();
      return await db.prepare(sql).bind(...values)[method]();
    } catch {
      throw new DatabaseUnavailable();
    }
  };
  const first = (sql, values) => query(sql, values, 'first');
  const rows = async (sql, values) => (await query(sql, values)).results;
  const person = id => first('SELECT * FROM people WHERE id = ?', [id]);

  return {
    // 未設定・未マイグレーション・故障時はログインも含め成功扱いにしない。
    async checkReady() {
      await rows('SELECT 1 FROM people, places, posts, slack_digest_deliveries, sessions, oauth_states LIMIT 0');
    },
    async cleanupAuth() {
      await query('DELETE FROM oauth_states WHERE expires_at <= ?', [now().getTime()], 'run');
      await query('DELETE FROM sessions WHERE expires_at <= ?', [now().getTime()], 'run');
    },
    saveState: (hash, nonce, expiresAt) => query('INSERT INTO oauth_states (state_hash, nonce, expires_at) VALUES (?, ?, ?)',
      [hash, nonce, expiresAt], 'run'),
    // DELETE RETURNINGは単一SQL。並行callbackでもnonceを取得できるのは一度だけ。
    consumeState: hash => first('DELETE FROM oauth_states WHERE state_hash = ? AND expires_at > ? RETURNING nonce', [hash, now().getTime()]),
    saveSession: (hash, personId, expiresAt) => query('INSERT INTO sessions (token_hash, person_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
      [hash, personId, expiresAt, now().getTime()], 'run'),
    getSessionPerson: hash => first(`SELECT people.* FROM sessions JOIN people ON people.id = sessions.person_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?`, [hash, now().getTime()]),
    deleteSession: hash => query('DELETE FROM sessions WHERE token_hash = ?', [hash], 'run'),
    upsertSlackPerson: ({ teamId, userId, displayName }) => first(`INSERT INTO people
      (id, slack_team_id, slack_user_id, display_name, terms_accepted_at, feedback_opt_in, created_at)
      VALUES (?, ?, ?, ?, NULL, 0, ?)
      ON CONFLICT (slack_team_id, slack_user_id) DO UPDATE SET display_name = excluded.display_name RETURNING *`,
    [crypto.randomUUID(), teamId, userId, displayName, now().getTime()]),
    getPerson: person,
    async updatePreferences(id, { terms_accepted, feedback_opt_in }) {
      return first(`UPDATE people SET
        terms_accepted_at = CASE WHEN ? THEN COALESCE(terms_accepted_at, ?) ELSE terms_accepted_at END,
        feedback_opt_in = ? WHERE id = ? RETURNING *`,
      [Number(terms_accepted), now().getTime(), Number(feedback_opt_in), id]);
    },
    listPeople(teamId, search) {
      // LIKEのワイルドカードとESCAPE自身も、文字として検索する。
      const literal = search.replace(/[\\%_]/g, value => `\\${value}`);
      return rows(`SELECT id, display_name AS name FROM people
        WHERE slack_team_id = ? AND feedback_opt_in = 1 AND terms_accepted_at IS NOT NULL
        AND display_name LIKE ? ESCAPE '\\' ORDER BY id`, [teamId, `%${literal}%`]);
    },
    listPlaces: () => rows('SELECT id, name FROM places ORDER BY id'),
    getPlace: id => first('SELECT id, name FROM places WHERE id = ?', [id]),
    async insertPost({ id, author_person_id, target_type, target_id, sentiment, text, teamId }) {
      // 対象の確認後に受信同意が撤回されても、INSERT時点の値で拒否する。
      const result = await query(`INSERT INTO posts
        (id, author_person_id, target_type, target_id, sentiment, text, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE
        (? = 'place' AND EXISTS (SELECT 1 FROM places WHERE id = ?)) OR
        (? = 'person' AND EXISTS (SELECT 1 FROM people WHERE id = ? AND slack_team_id = ?
          AND terms_accepted_at IS NOT NULL AND feedback_opt_in = 1))`,
      [id, author_person_id, target_type, target_id, sentiment, text, now().toISOString(),
        target_type, target_id, target_type, target_id, teamId], 'run');
      return result.meta.changes === 1;
    },
    async getPlaceCounts(id) {
      const at = now();
      const counts = await first(`SELECT
        COALESCE(SUM(sentiment = 'good'), 0) AS good_count,
        COALESCE(SUM(sentiment = 'motto'), 0) AS motto_count
        FROM posts WHERE target_type = 'place' AND target_id = ? AND created_at >= ? AND created_at <= ?`,
      [id, sevenCalendarDaysStart(at).toISOString(), at.toISOString()]);
      return { place_id: id, period_days: 7, ...counts, updated_at: at.toISOString() };
    },
    listPersonPosts({ from, to }) {
      return rows(`SELECT id, author_person_id, target_type, target_id, sentiment, text, created_at
        FROM posts WHERE target_type = 'person' AND created_at >= ? AND created_at < ? ORDER BY created_at, id`,
      [from.toISOString(), to.toISOString()]);
    },
    getRecipient: id => first(`SELECT id, slack_team_id, slack_user_id, display_name, feedback_opt_in
      FROM people WHERE id = ?`, [id]),
    async listDisplayNames() {
      return (await rows('SELECT display_name FROM people ORDER BY id')).map(row => row.display_name);
    },
    getDelivery: (personId, weekKey) => first('SELECT * FROM slack_digest_deliveries WHERE person_id = ? AND week_key = ?', [personId, weekKey]),
    async claimDelivery(personId, weekKey) {
      const result = await query(`INSERT INTO slack_digest_deliveries (person_id, week_key, status, attempts, updated_at)
        VALUES (?, ?, 'sending', 1, ?)
        ON CONFLICT (person_id, week_key) DO UPDATE SET
          status = 'sending', attempts = slack_digest_deliveries.attempts + 1,
          slack_ts = NULL, slack_channel = NULL, error = NULL, updated_at = excluded.updated_at
        WHERE slack_digest_deliveries.status = 'failed'`, [personId, weekKey, now().getTime()], 'run');
      return result.meta.changes === 1;
    },
    async finishDelivery(personId, weekKey, { status, ts, channel, error }) {
      if (!['sent', 'failed', 'unknown'].includes(status)) throw new TypeError('Invalid delivery status');
      await query(`UPDATE slack_digest_deliveries SET status = ?, slack_ts = ?, slack_channel = ?, error = ?, updated_at = ?
        WHERE person_id = ? AND week_key = ?`, [status, ts ?? null, channel ?? null, error ?? null, now().getTime(), personId, weekKey], 'run');
    },
  };
}
