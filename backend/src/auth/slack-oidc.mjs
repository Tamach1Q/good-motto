import { createLocalJWKSet, jwtVerify } from 'jose';

export class AuthError extends Error {
  constructor(status = 401) {
    super('Authentication failed');
    this.status = status;
  }
}

const TEAM = 'https://slack.com/team_id';
const USER = 'https://slack.com/user_id';
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

export function authorizationUrl(env, state, nonce) {
  const url = new URL('https://slack.com/openid/connect/authorize');
  url.search = new URLSearchParams({ response_type: 'code', scope: 'openid profile',
    client_id: env.SLACK_CLIENT_ID, state, nonce, redirect_uri: env.SLACK_REDIRECT_URI,
    team: env.ALLOWED_SLACK_TEAM_ID }).toString();
  return url.toString();
}

export function createSlackOidc({ fetch: fetchImpl, now }) {
  async function slackJson(url, options = {}) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new AuthError(503));
        controller.abort();
      }, 10_000);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const response = await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
        if (response.status >= 500 || response.status === 429) throw new AuthError(503);
        if (!response.ok) throw new AuthError();
        let data;
        try {
          data = await response.json();
        } catch (error) {
          if (error instanceof SyntaxError) throw new AuthError();
          throw error;
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AuthError();
        return data;
      })()]);
    } catch (error) {
      // fetchの例外やSlackの応答には認可コード・秘密値が含まれ得る。
      throw new AuthError(error instanceof AuthError ? error.status : 503);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async authenticate(env, code, nonce) {
      const token = await slackJson('https://slack.com/api/openid.connect.token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: env.SLACK_CLIENT_ID, client_secret: env.SLACK_CLIENT_SECRET,
          code, redirect_uri: env.SLACK_REDIRECT_URI, grant_type: 'authorization_code' }).toString(),
      });
      if (token.ok !== true || !nonempty(token.id_token)) throw new AuthError();
      const jwks = await slackJson('https://slack.com/openid/connect/keys');
      let claims;
      try {
        ({ payload: claims } = await jwtVerify(token.id_token, createLocalJWKSet(jwks), {
          algorithms: ['RS256'], issuer: 'https://slack.com', audience: env.SLACK_CLIENT_ID,
          requiredClaims: ['iss', 'aud', 'exp', 'sub', 'nonce'], currentDate: now(),
        }));
      } catch {
        throw new AuthError();
      }
      if (claims.nonce !== nonce || !nonempty(claims.sub) || !nonempty(claims[USER]) ||
          claims.sub !== claims[USER] || !nonempty(claims[TEAM])) throw new AuthError();
      // 複数audienceの場合も、このクライアントへの発行であることを確認する。
      if ((claims.azp !== undefined && claims.azp !== env.SLACK_CLIENT_ID) ||
          (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== env.SLACK_CLIENT_ID)) throw new AuthError();
      if (claims[TEAM] !== env.ALLOWED_SLACK_TEAM_ID) throw new AuthError(403);
      let name = claims.name;
      if (!nonempty(name)) {
        if (!nonempty(token.access_token)) throw new AuthError();
        const info = await slackJson('https://slack.com/api/openid.connect.userInfo', {
          method: 'POST', headers: { Authorization: `Bearer ${token.access_token}` },
        });
        if (info.ok !== true || info.sub !== claims.sub || info[USER] !== claims[USER] ||
            info[TEAM] !== claims[TEAM] || !nonempty(info.name)) throw new AuthError();
        name = info.name;
      }
      // トークンやメールなど、人物作成に不要な値は呼び出し元へ渡さない。
      return { teamId: claims[TEAM], userId: claims[USER], displayName: name };
    },
  };
}
