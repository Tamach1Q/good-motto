import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { analysis } from './api/mock-data.mjs';
import { createRepository, DatabaseUnavailable } from './data/repository.mjs';
import { createGemini, GeminiError } from './ai/gemini.mjs';
import { AuthError, authorizationUrl, createSlackOidc } from './auth/slack-oidc.mjs';
import { SESSION_COOKIE, STATE_COOKIE, SESSION_SECONDS, STATE_SECONDS, COOKIE_OPTIONS, randomToken, hashToken } from './auth/tokens.mjs';

const ERRORS = {
  400: ['INVALID_REQUEST', '入力を確認してください'],
  401: ['UNAUTHORIZED', '有効な認証情報が必要です'],
  403: ['FORBIDDEN', 'この操作は許可されていません'],
  404: ['NOT_FOUND', '対象が見つかりません'],
  429: ['RATE_LIMITED', '時間をおいてお試しください'],
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

export function createApp({ now = () => new Date(), fetch: fetchImpl = globalThis.fetch } = {}) {
  const app = new Hono();
  const slack = createSlackOidc({ fetch: fetchImpl, now });

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    // ENVだけを誤設定しても公開ホストではモックを有効にしない。
    const hostname = new URL(c.req.url).hostname;
    const development = c.env?.ENV === 'development' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
    const oidc = ['production', 'staging'].includes(c.env?.ENV);
    if (!development && !oidc) return errorResponse(c, 503);
    if (oidc && ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_REDIRECT_URI', 'ALLOWED_SLACK_TEAM_ID', 'ALLOWED_ORIGIN']
      .some(key => typeof c.env[key] !== 'string' || !c.env[key].trim() || c.env[key] === '*')) return errorResponse(c, 503);
    c.set('oidc', oidc);
    const repo = createRepository(c.env?.DB, { now });
    await repo.checkReady();
    c.set('repo', repo);
    await next();
  });

  const requireUser = async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token || !/^[0-9a-f]{64}$/.test(token)) throw new ApiError(401);
    const hash = await hashToken(token);
    const person = await c.get('repo').getSessionPerson(hash);
    if (!person) throw new ApiError(401);
    if (c.get('oidc') && person.slack_team_id !== c.env.ALLOWED_SLACK_TEAM_ID) throw new ApiError(403);
    c.set('person', person);
    c.set('sessionHash', hash);
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

  async function issueSession(c, personId) {
    const token = randomToken();
    await c.get('repo').saveSession(await hashToken(token), personId, now().getTime() + SESSION_SECONDS * 1000);
    setCookie(c, SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: SESSION_SECONDS });
    return c.redirect('/', 302);
  }

  app.get('/api/v1/auth/slack/login', async c => {
    const repo = c.get('repo');
    await repo.cleanupAuth();
    if (c.get('oidc')) {
      const state = randomToken();
      const nonce = randomToken();
      await repo.saveState(await hashToken(state), nonce, now().getTime() + STATE_SECONDS * 1000);
      setCookie(c, STATE_COOKIE, state, { ...COOKIE_OPTIONS, maxAge: STATE_SECONDS });
      return c.redirect(authorizationUrl(c.env, state, nonce), 302);
    }
    const mockUser = c.req.query('mock_user') ?? 'accepted';
    if (!['accepted', 'pending'].includes(mockUser)) throw new ApiError(400);
    const personId = mockUser === 'pending' ? '00000000-0000-4000-8000-000000000002' : '00000000-0000-4000-8000-000000000001';
    if (!await repo.getPerson(personId)) throw new ApiError(503);
    return issueSession(c, personId);
  });

  app.get('/api/v1/auth/slack/callback', async c => {
    // ローカルモックはこれまでどおりloginだけで完結する。
    if (!c.get('oidc')) return c.redirect('/', 302);
    const state = c.req.query('state');
    if (!state || !/^[0-9a-f]{64}$/.test(state) || getCookie(c, STATE_COOKIE) !== state) throw new ApiError(401);
    setCookie(c, STATE_COOKIE, '', { ...COOKIE_OPTIONS, maxAge: 0 });
    const consumed = await c.get('repo').consumeState(await hashToken(state));
    if (!consumed || c.req.query('error') !== undefined || !c.req.query('code')) throw new ApiError(401);
    const identity = await slack.authenticate(c.env, c.req.query('code'), consumed.nonce);
    const person = await c.get('repo').upsertSlackPerson(identity);
    return issueSession(c, person.id);
  });

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

  app.post('/api/v1/auth/logout', requireUser, requireOrigin, async c => {
    await c.get('repo').deleteSession(c.get('sessionHash'));
    setCookie(c, SESSION_COOKIE, '', { ...COOKIE_OPTIONS, maxAge: 0 });
    return c.body(null, 204);
  });

  app.post('/api/v1/posts/analyze', requireUser, requireOrigin, requireTerms, async c => {
    const body = await jsonObject(c);
    validateText(body.text);
    const apiKey = c.env.GEMINI_API_KEY;
    const model = c.env.GEMINI_MODEL;
    if (!apiKey && !model && !c.get('oidc')) return c.json(analysis);
    if (!apiKey || !model) throw new ApiError(503);
    const gemini = createGemini({ apiKey, model, fetch: fetchImpl });
    return c.json(await gemini.analyze({ text: body.text, places: await c.get('repo').listPlaces() }));
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
  app.onError((error, c) => errorResponse(c, error instanceof ApiError || error instanceof GeminiError || error instanceof AuthError ? error.status : error instanceof DatabaseUnavailable ? 503 : 500));
  return app;
}

export default createApp();
