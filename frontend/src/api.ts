import type { Analysis, Api, Person, Place, PostResult } from './types';

export class ApiError extends Error {
  constructor(message: string, public status = 0, public code = 'NETWORK_ERROR') { super(message); }
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
const string = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
function invalid(): never { throw new ApiError('応答を読み取れませんでした。時間をおいて再度お試しください。', 502, 'INVALID_RESPONSE'); }

export function createHttpApi(base = ''): Api {
  const root = `${base.replace(/\/$/, '')}/api/v1`;
  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (init.signal?.aborted) controller.abort();
    else init.signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    try {
      const res = await fetch(root + path, {
        ...init, credentials: 'include', signal: controller.signal,
        headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      });
      let data: unknown;
      try { data = await res.json(); } catch { if (res.ok) invalid(); }
      if (!res.ok) {
        const code = record(data) && record(data.error) && string(data.error.code) ? data.error.code : 'HTTP_ERROR';
        const message = res.status === 401 || res.status === 403 ? 'ログイン状態やアクセス権を確認してください。'
          : res.status === 429 ? '少し時間をおいて、もう一度お試しください。'
          : res.status >= 500 ? '接続先で問題が発生しています。時間をおいてお試しください。'
          : record(data) && record(data.error) && string(data.error.message) ? data.error.message : '入力内容を確認してください。';
        throw new ApiError(message, res.status, code);
      }
      return data;
    } catch (e) {
      if (timedOut) throw new ApiError('応答に時間がかかっています。', 0, 'TIMEOUT');
      if (e instanceof ApiError || (e instanceof Error && e.name === 'AbortError')) throw e;
      throw new ApiError('接続できませんでした。通信状態を確認してください。');
    } finally { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }
  }
  return {
    async analyze(text, signal) {
      const d = await request('/posts/analyze', { method: 'POST', body: JSON.stringify({ text }), signal });
      if (!record(d) || !['good', 'motto'].includes(String(d.sentiment)) || !['person', 'place', 'unknown'].includes(String(d.target_type)) || !(d.target_id === null || string(d.target_id)) || !(d.target_label == null || typeof d.target_label === 'string')) invalid();
      return d as unknown as Analysis;
    },
    async people(query, signal) {
      const d = await request(`/people?query=${encodeURIComponent(query)}`, { signal });
      if (!record(d) || !Array.isArray(d.people)) invalid();
      return d.people.map((p: unknown): Person => {
        if (!record(p) || !string(p.id) || !string(p.name)) invalid();
        return { id: p.id, name: p.name, ...(string(p.username) ? { username: p.username } : {}), ...(string(p.avatar_url) && p.avatar_url.startsWith('https://') ? { avatar_url: p.avatar_url } : {}), ...(string(p.workspace_label) ? { workspace_label: p.workspace_label } : {}) };
      });
    },
    async places(signal) {
      const d = await request('/places', { signal });
      if (!record(d) || !Array.isArray(d.places)) invalid();
      return d.places.map((p: unknown): Place => { if (!record(p) || !string(p.id) || !string(p.name)) invalid(); return { id: p.id, name: p.name }; });
    },
    async post(input, signal) {
      const d = await request('/posts', { method: 'POST', body: JSON.stringify(input), signal });
      if (!record(d) || !string(d.post_id) || d.status !== 'created') invalid();
      return d as unknown as PostResult;
    },
  };
}

const demoPeople: Person[] = [
  { id: 'person_001', name: '田中 太郎' },
  { id: 'person_002', name: '山田 花子' },
  { id: 'person_003', name: '田中 太郎' },
  { id: 'person_004', name: '佐藤 葵' },
];
const demoPlaces: Place[] = [{ id: 'kitchen', name: '共用キッチン' }, { id: 'laundry', name: '洗濯室' }, { id: 'classroom', name: '教室' }];
async function wait(signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 450);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export const demoApi: Api = {
  async analyze(text, signal) {
    await wait(signal);
    const place = demoPlaces.find(p => text.includes(p.name));
    return { sentiment: /ありがとう|助か|うれし|嬉し|よかった/.test(text) ? 'good' : 'motto', target_type: place ? 'place' : 'unknown', target_id: place?.id ?? null, target_label: place?.name ?? null };
  },
  async people(query, signal) { await wait(signal); return demoPeople.filter(p => p.name.toLowerCase().includes(query.normalize('NFKC').trim().toLowerCase())); },
  async places(signal) { await wait(signal); return demoPlaces; },
  async post(_input, signal) { await wait(signal); return { post_id: 'demo-post', status: 'created' }; },
};
export const isDemo = import.meta.env.VITE_API_MODE !== 'live';
export const api = isDemo ? demoApi : createHttpApi(import.meta.env.VITE_API_BASE_URL ?? '');
export const errorMessage = (e: unknown) => e instanceof Error ? e.message : '処理に失敗しました。もう一度お試しください。';

export type DemoScenario = 'normal' | 'analyze-error' | 'unclassifiable' | 'people-error' | 'places-error' | 'post-error';
/** UIのデモ用。HTTP契約を変更せず、失敗は共通エラーとして扱います。 */
export function createDemoApi(scenario: DemoScenario): Api {
  const fail = async (message: string, signal?: AbortSignal): Promise<never> => { await wait(signal); throw new ApiError(message, 503, 'SERVICE_UNAVAILABLE'); };
  return {
    ...demoApi,
    analyze: (text, signal) => scenario === 'analyze-error' ? fail('分析できませんでした。もう一度お試しください。', signal)
      : scenario === 'unclassifiable' ? fail('内容を分類できませんでした。メモを見直して、もう一度お試しください。', signal) : demoApi.analyze(text, signal),
    people: (query, signal) => scenario === 'people-error' ? fail('メンバーを取得できませんでした。', signal) : demoApi.people(query, signal),
    places: signal => scenario === 'places-error' ? fail('場所を取得できませんでした。', signal) : demoApi.places(signal),
    post: (input, signal) => scenario === 'post-error' ? fail('投稿を保存できませんでした。', signal) : demoApi.post(input, signal),
  };
}
