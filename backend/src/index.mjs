import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { analysis } from './api/mock-data.mjs';
import { createRepository, DatabaseUnavailable } from './data/repository.mjs';

const SESSION_COOKIE = '__Host-gm_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' };
const ERRORS = {
  400: ['INVALID_REQUEST', '入力を確認してください'],
  401: ['UNAUTHORIZED', '有効な認証情報が必要です'],
  403: ['FORBIDDEN', 'この操作は許可されていません'],
  404: ['NOT_FOUND', '対象が見つかりません'],
  500: ['INTERNAL_ERROR', '処理に失敗しました'],
  503: ['SERVICE_UNAVAILABLE', 'サービスを利用できません'],
};

class ApiError extends Error {
  constructor(status) {
    super(ERRORS[status][0]);
    this.status = status;
  }
}

function errorResponse(c, status) {
  const [code, message] = ERRORS[status];
  return c.json({ error: { code, message } }, status);
}

async function jsonObject(c) {
  let body;
  try {
    body = await c.req.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new ApiError(400);
    throw error;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400);
  return body;
}

function validateText(text) {
  if (typeof text !== 'string') throw new ApiError(400);
  const length = Array.from(text.trim()).length;
  if (length < 1 || length > 500) throw new ApiError(400);
}

function publicPerson(person) {
  return { person_id: person.id, display_name: person.display_name,
    terms_accepted: person.terms_accepted_at !== null, feedback_opt_in: person.feedback_opt_in === 1 };
}

export function createApp({ now = () => new Date() } = {}) {
  const app = new Hono();
  const sessions = new Map();

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    // ENVだけを誤設定しても公開ホストではモックを有効にしない。
    const hostname = new URL(c.req.url).hostname;
    if (c.env?.ENV !== 'development' || !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
      return errorResponse(c, 503);
    }
    const repo = createRepository(c.env?.DB, { now });
    await repo.checkReady();
    c.set('repo', repo);
    await next();
  });

  const requireUser = async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const session = sessions.get(token);
    if (!session || session.expiresAt <= now().getTime()) {
      if (session) sessions.delete(token);
      throw new ApiError(401);
    }
    const person = await c.get('repo').getPerson(session.personId);
    if (!person) throw new ApiError(401);
    c.set('person', person);
    c.set('sessionToken', token);
    await next();
  };

  const requireOrigin = async (c, next) => {
    const allowed = c.env.ALLOWED_ORIGIN;
    if (!allowed || allowed === '*' || c.req.header('Origin') !== allowed) throw new ApiError(403);
    await next();
  };

  const requireTerms = async (c, next) => {
    if (c.get('person').terms_accepted_at === null) throw new ApiError(403);
    await next();
  };

  app.get('/api/v1/auth/slack/login', async c => {
    const mockUser = c.req.query('mock_user') ?? 'accepted';
    if (!['accepted', 'pending'].includes(mockUser)) throw new ApiError(400);
    const personId = mockUser === 'pending' ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001';
    if (!await c.get('repo').getPerson(personId)) throw new ApiError(503);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    sessions.set(token, { personId, expiresAt: now().getTime() + SESSION_SECONDS * 1000 });
    setCookie(c, SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_SECONDS });
    return c.redirect('/', 302);
  });

  // モックログインはloginで完結。OIDCコードの交換・セッション発行はしない。
  app.get('/api/v1/auth/slack/callback', c => c.redirect('/', 302));

  app.get('/api/v1/me', requireUser, c => c.json(publicPerson(c.get('person'))));

  app.patch('/api/v1/me/preferences', requireUser, requireOrigin, async c => {
    const body = await jsonObject(c);
    if (typeof body.terms_accepted !== 'boolean' || typeof body.feedback_opt_in !== 'boolean') throw new ApiError(400);
    const person = c.get('person');
    if (person.terms_accepted_at !== null && !body.terms_accepted) throw new ApiError(400);
    if (!body.terms_accepted && body.feedback_opt_in) throw new ApiError(403);
    const updated = await c.get('repo').updatePreferences(person.id, body);
    return c.json(publicPerson(updated));
  });

  app.post('/api/v1/auth/logout', requireUser, requireOrigin, c => {
    sessions.delete(c.get('sessionToken'));
    setCookie(c, SESSION_COOKIE, '', { ...COOKIE_OPTIONS, maxAge: 0 });
    return c.body(null, 204);
  });

  app.post('/api/v1/posts/analyze', requireUser, requireOrigin, requireTerms, async c => {
    const body = await jsonObject(c);
    validateText(body.text);
    return c.json(analysis);
  });

  app.post('/api/v1/posts', requireUser, requireOrigin, requireTerms, async c => {
    const body = await jsonObject(c);
    validateText(body.text);
    // 投稿者・投稿日時はクライアントから受け取らない。
    if (['author_person_id', 'author_id', 'person_id', 'user_id', 'created_at'].some(key => Object.hasOwn(body, key))) throw new ApiError(400);
    if (!['good', 'motto'].includes(body.sentiment) || !['person', 'place'].includes(body.target_type) || typeof body.target_id !== 'string' || !body.target_id) throw new ApiError(400);
    const repo = c.get('repo');
    if (body.target_type === 'place') {
      if (!await repo.getPlace(body.target_id)) throw new ApiError(404);
    } else {
      const target = await repo.getPerson(body.target_id);
      if (!target) throw new ApiError(404);
      if (target.slack_team_id !== c.get('person').slack_team_id || target.terms_accepted_at === null || !target.feedback_opt_in) throw new ApiError(403);
    }
    const id = crypto.randomUUID();
    const saved = await repo.insertPost({ ...body, id, author_person_id: c.get('person').id,
      text: body.text.trim(), teamId: c.get('person').slack_team_id });
    if (!saved) throw new ApiError(403);
    return c.json({ post_id: id, status: 'created' }, 201);
  });

  app.get('/api/v1/places', requireUser, async c => c.json({ places: await c.get('repo').listPlaces() }));

  app.get('/api/v1/people', requireUser, async c => {
    const query = c.req.query('query')?.trim();
    if (!query) throw new ApiError(400);
    return c.json({ people: await c.get('repo').listPeople(c.get('person').slack_team_id, query) });
  });

  app.get('/api/v1/places/:id/counts', async c => {
    const key = c.env.M5_DEVICE_KEY;
    if (!key || c.req.header('Authorization') !== `Bearer ${key}`) throw new ApiError(401);
    const id = c.req.param('id');
    const repo = c.get('repo');
    if (!await repo.getPlace(id)) throw new ApiError(404);
    return c.json(await repo.getPlaceCounts(id));
  });

  app.notFound(c => errorResponse(c, 404));
  // 例外メッセージやリクエスト本文はログにも応答にも含めない。
  app.onError((error, c) => errorResponse(c, error instanceof ApiError ? error.status : error instanceof DatabaseUnavailable ? 503 : 500));
  return app;
}

export default createApp();
