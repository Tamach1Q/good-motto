import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

export const AO = '00000000-0000-4000-8000-000000000001';
export const MIDORI = '00000000-0000-4000-8000-000000000002';
export const SORA = '00000000-0000-4000-8000-000000000003';

export async function applySql(db, file) {
  const sql = await readFile(new URL(file, import.meta.url), 'utf8');
  const statements = sql.split(';').map(value => value.trim()).filter(Boolean);
  await db.batch(statements.map(statement => db.prepare(statement)));
}

export async function createD1(t, { migrate = true, seed = true } = {}) {
  const mf = new Miniflare({ ...convertV4MiniflareOptions({ cf: false, modules: true, script: 'export default { fetch() { return new Response(null); } };',
    compatibilityDate: '2026-11-04', d1Databases: { DB: 'gm002-tests' } }), enableDevRegistry: false });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  if (migrate) await applySql(db, '../../migrations/0001_post_data.sql');
  if (migrate && seed) await applySql(db, '../../seeds/development.sql');
  return db;
}

export async function resetD1(db) {
  await db.batch(['DELETE FROM slack_digest_deliveries', 'DELETE FROM posts', 'DELETE FROM people']
    .map(sql => db.prepare(sql)));
  await applySql(db, '../../seeds/development.sql');
}

export function addPost(db, { id = crypto.randomUUID(), author = AO, type = 'place', target = 'kitchen', sentiment = 'good', text = '架空の投稿', at }) {
  return db.prepare(`INSERT INTO posts (id, author_person_id, target_type, target_id, sentiment, text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, author, type, target, sentiment, text, new Date(at).toISOString()).run();
}
