import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { analysis, counts, createMockPeople, places } from './api/mock-data.mjs';

const SESSION_COOKIE = '__Host-gm_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' };
const ERRORS = {
  400: ['INVALID_REQUEST', '入力を確認してください'],
  401: ['UNAUTHORIZED', '有効な認証情報が必要です'],
  403: ['FORBIDDEN', 'この操作は許可されていません'],
  404: ['NOT_FOUND', '対象が見つかりません'],
  500: ['INTERNAL_ERROR', '処理に失敗しました'],
  503: ['SERVICE_UNAVAILABLE', 'ローカル開発用モックは無効です'],
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

export function createApp() {
  const app = new Hono();
  const people = createMockPeople();
  const sessions = new Map();

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    // ENVだけを誤設定しても公開ホストではモックを有効にしない。
    const hostname = new URL(c.req.url).hostname;
    if (c.env?.ENV !== 'development' || !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
      return errorResponse(c, 503);
    }
    await next();
  });

  const requireUser = async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const session = sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) sessions.delete(token);
      throw new ApiError(401);
    }
    c.set('person', people.find(person => person.person_id === session.personId));
    c.set('sessionToken', token);
    await next();
  };

  const requireOrigin = async (c, next) => {
    const allowed = c.env.ALLOWED_ORIGIN;
    if (!allowed || allowed === '*' || c.req.header('Origin') !== allowed) throw new ApiError(403);
    await next();
  };

  const requireTerms = async (c, next) => {
    if (!c.get('person').terms_accepted) throw new ApiError(403);
    await next();
  };

  app.get('/api/v1/auth/slack/login', c => {
    const mockUser = c.req.query('mock_user') ?? 'accepted';
    if (!['accepted', 'pending'].includes(mockUser)) throw new ApiError(400);
    const person = people[mockUser === 'pending' ? 1 : 0];
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    sessions.set(token, { personId: person.person_id, expiresAt: Date.now() + SESSION_SECONDS * 1000 });
    setCookie(c, SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_SECONDS });
    return c.redirect('/', 302);
  });

  // モックログインはloginで完結。OIDCコードの交換・セッション発行はしない。
  app.get('/api/v1/auth/slack/callback', c => c.redirect('/', 302));

  app.get('/api/v1/me', requireUser, c => c.json(c.get('person')));

  app.patch('/api/v1/me/preferences', requireUser, requireOrigin, async c => {
    const body = await jsonObject(c);
    if (typeof body.terms_accepted !== 'boolean' || typeof body.feedback_opt_in !== 'boolean') throw new ApiError(400);
    const person = c.get('person');
    if (person.terms_accepted && !body.terms_accepted) throw new ApiError(400);
    if (!body.terms_accepted && body.feedback_opt_in) throw new ApiError(403);
    person.terms_accepted = body.terms_accepted;
    person.feedback_opt_in = body.feedback_opt_in;
    return c.json(person);
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
    // 投稿者・投稿日時はクライアントから受け取らない。モックでは保存自体を行わない。
    if (['author_person_id', 'author_id', 'person_id', 'user_id', 'created_at'].some(key => Object.hasOwn(body, key))) throw new ApiError(400);
    if (!['good', 'motto'].includes(body.sentiment) || !['person', 'place'].includes(body.target_type) || typeof body.target_id !== 'string' || !body.target_id) throw new ApiError(400);
    if (body.target_type === 'place') {
      if (!places.some(place => place.id === body.target_id)) throw new ApiError(404);
    } else {
      const target = people.find(person => person.person_id === body.target_id);
      if (!target) throw new ApiError(404);
      if (!target.terms_accepted || !target.feedback_opt_in) throw new ApiError(403);
    }
    return c.json({ post_id: crypto.randomUUID(), status: 'created' }, 201);
  });

  app.get('/api/v1/places', requireUser, c => c.json({ places }));

  app.get('/api/v1/people', requireUser, c => {
    const query = c.req.query('query')?.trim();
    if (!query) throw new ApiError(400);
    return c.json({ people: people
      .filter(person => person.terms_accepted && person.feedback_opt_in && person.display_name.includes(query))
      .map(person => ({ id: person.person_id, name: person.display_name })) });
  });

  app.get('/api/v1/places/:id/counts', c => {
    const key = c.env.M5_DEVICE_KEY;
    if (!key || c.req.header('Authorization') !== `Bearer ${key}`) throw new ApiError(401);
    const id = c.req.param('id');
    if (!Object.hasOwn(counts, id)) throw new ApiError(404);
    return c.json(counts[id]);
  });

  app.notFound(c => errorResponse(c, 404));
  // 例外メッセージやリクエスト本文はログにも応答にも含めない。
  app.onError((error, c) => errorResponse(c, error instanceof ApiError ? error.status : 500));
  return app;
}

export default createApp();
