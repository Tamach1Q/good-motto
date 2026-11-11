import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../src/api';

afterEach(() => vi.unstubAllGlobals());
describe('API契約v1との接続', () => {
  it('本人照会・設定保存・204ログアウトに同じCookie通信を使う', async () => {
    const user = { person_id: 'self', display_name: '田中', terms_accepted: true, feedback_opt_in: false };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(user))).mockResolvedValueOnce(new Response(JSON.stringify(user))).mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch); const api = createHttpApi();
    expect(await api.me()).toEqual(user);
    await api.preferences({ terms_accepted: true, feedback_opt_in: false });
    await api.logout();
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/v1/me', expect.objectContaining({ credentials: 'include' }));
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/v1/me/preferences', expect.objectContaining({ method: 'PATCH', body: '{"terms_accepted":true,"feedback_opt_in":false}' }));
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/v1/auth/logout', expect.objectContaining({ method: 'POST', credentials: 'include' }));
  });
  it('人物検索を符号化して送信し、Cookie認証を含める', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ people: [{ id: 'p1', name: '田中' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await createHttpApi().people('田 中')).toEqual([{ id: 'p1', name: '田中' }]);
    expect(fetch).toHaveBeenCalledWith('/api/v1/people?query=%E7%94%B0%20%E4%B8%AD', expect.objectContaining({ credentials: 'include' }));
  });
  it('投稿JSONに契約外のキーや投稿者情報を加えない', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ post_id: 'post_001', status: 'created' }), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    const body = { text: 'メモ', sentiment: 'motto' as const, target_type: 'place' as const, target_id: 'kitchen' };
    await createHttpApi('https://example.test').post(body);
    expect(fetch).toHaveBeenCalledWith('https://example.test/api/v1/posts', expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }));
  });
  it('不正な分類結果と未認証レスポンスを成功扱いしない', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ sentiment: null }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'ログインが必要' } }), { status: 401 })));
    await expect(createHttpApi().analyze('メモ')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(createHttpApi().post({ text: 'メモ', sentiment: 'good', target_type: 'person', target_id: 'p' })).rejects.toMatchObject({ status: 401 });
  });
});

describe('投稿と検索の通信失敗', () => {
  const input = { text: 'メモ', sentiment: 'good' as const, target_type: 'person' as const, target_id: 'p' };
  it.each([401, 403, 429, 503])('HTTP %sを投稿・検索の失敗として返す', async status => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('{}', { status }))));
    const api = createHttpApi();
    await expect(api.people('田')).rejects.toMatchObject({ status });
    await expect(api.post(input)).rejects.toMatchObject({ status });
  });
  it.each(['people', 'post'] as const)('%sの切断・タイムアウトを区別する', async method => {
    const api = createHttpApi();
    const request = () => method === 'people' ? api.people('田') : api.post(input);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(request()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })));
      const rejection = expect(request()).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(20000);
      await rejection;
    } finally { vi.useRealTimers(); }
  });
});
