import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../src/api';

afterEach(() => vi.unstubAllGlobals());
describe('API契約v1との接続', () => {
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
