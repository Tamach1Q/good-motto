import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import TargetPicker from '../src/TargetPicker';
import type { Api, Person } from '../src/types';

function makeApi(): Api {
  return {
    analyze: vi.fn().mockResolvedValue({ sentiment: 'motto', target_type: 'person', target_id: 'ai-guessed-id', target_label: '田中さん' }),
    people: vi.fn().mockResolvedValue([{ id: 'person_001', name: '田中 太郎' }, { id: 'person_003', name: '田中 太郎' }]),
    places: vi.fn().mockResolvedValue([{ id: 'kitchen', name: '共用キッチン' }]),
    post: vi.fn().mockResolvedValue({ post_id: 'post_001', status: 'created' }),
  };
}
async function review(api: Api) {
  const user = userEvent.setup(); render(<App api={api} demo={false} />);
  await user.type(screen.getByLabelText('メモの本文'), '最後まで話を聞いてほしかった');
  expect(screen.getByRole('button', { name: /内容を確認する/ })).toBeDisabled();
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: /内容を確認する/ }));
  await screen.findByRole('heading', { name: '投稿内容を確認' });
  return user;
}

describe('投稿の流れ', () => {
  it('AIが人物IDを返しても本人選択までは投稿せず、選んだIDと修正分類を送る', async () => {
    const api = makeApi(), user = await review(api);
    expect(screen.getByRole('button', { name: '投稿する' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /候補：田中さん/ }));
    await user.type(screen.getByRole('combobox'), '田');
    const option = await screen.findByRole('option', { name: /person_003/ });
    await user.click(option);
    await user.click(screen.getByRole('button', { name: /Good.*よかったこと/ }));
    await user.click(screen.getByRole('button', { name: '投稿する' }));
    await screen.findByRole('heading', { name: '投稿しました' });
    expect(api.post).toHaveBeenCalledWith({ text: '最後まで話を聞いてほしかった', sentiment: 'good', target_type: 'person', target_id: 'person_003' });
    expect(sessionStorage.getItem('good-motto-draft-v1')).toBeNull();
  });
  it('投稿失敗で本文を残し、連打による重複リクエストを送らない', async () => {
    const api = makeApi();
    let rejectPost!: (reason: Error) => void;
    api.post = vi.fn().mockImplementation(() => new Promise((_resolve, reject) => { rejectPost = reject; }));
    const user = await review(api);
    await user.click(screen.getByRole('button', { name: /候補：田中さん/ }));
    await user.click(screen.getByRole('button', { name: '場所' }));
    await user.click(await screen.findByRole('option', { name: /共用キッチン/ }));
    const post = screen.getByRole('button', { name: '投稿する' });
    fireEvent.click(post); fireEvent.click(post);
    expect(api.post).toHaveBeenCalledTimes(1);
    rejectPost(new Error('接続できませんでした'));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('本文')).toHaveValue('最後まで話を聞いてほしかった');
    expect(sessionStorage.getItem('good-motto-draft-v1')).toBe('最後まで話を聞いてほしかった');
  });
  it('分析エラーでは確認画面へ進まず、再試行用に入力を維持する', async () => {
    const api = makeApi(); api.analyze = vi.fn().mockRejectedValue(new Error('分類できませんでした'));
    const user = userEvent.setup(); render(<App api={api} />);
    await user.type(screen.getByLabelText('メモの本文'), '入力したメモ');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /内容を確認する/ }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('メモの本文')).toHaveValue('入力したメモ');
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('Slackメンバー検索', () => {
  it('IME変換中は検索せず、確定した漢字1文字で検索する', async () => {
    const api = makeApi(); render(<TargetPicker api={api} initialType="person" onSelect={vi.fn()} onCancel={vi.fn()} />);
    const input = screen.getByRole('combobox');
    fireEvent.compositionStart(input); fireEvent.change(input, { target: { value: 'た' } });
    await new Promise(resolve => setTimeout(resolve, 360));
    expect(api.people).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '田' } }); fireEvent.compositionEnd(input);
    await screen.findAllByRole('option');
    expect(api.people).toHaveBeenCalledWith('田', expect.any(AbortSignal));
  });
  it('遅れて届く古い検索結果を表示しない', async () => {
    const api = makeApi(); const pending = new Map<string, (people: Person[]) => void>();
    api.people = vi.fn().mockImplementation(query => new Promise(resolve => pending.set(query, resolve)));
    render(<TargetPicker api={api} initialType="person" onSelect={vi.fn()} onCancel={vi.fn()} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '田' } });
    await waitFor(() => expect(pending.has('田')).toBe(true));
    fireEvent.change(input, { target: { value: '山' } });
    await waitFor(() => expect(pending.has('山')).toBe(true));
    pending.get('山')!([{ id: 'new', name: '山田' }]);
    await screen.findByRole('option', { name: /山田/ });
    pending.get('田')!([{ id: 'old', name: '田中' }]);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(screen.queryByRole('option', { name: /田中/ })).not.toBeInTheDocument();
  });
  it('候補なし・取得失敗を表示し、再試行できる', async () => {
    const api = makeApi(); api.people = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('通信エラー')).mockResolvedValueOnce([{ id: 'p1', name: '田中' }]);
    const user = userEvent.setup(); render(<TargetPicker api={api} initialType="person" onSelect={vi.fn()} onCancel={vi.fn()} />);
    await user.type(screen.getByRole('combobox'), '髙');
    await screen.findByText('該当するメンバーがいません');
    await user.clear(screen.getByRole('combobox')); await user.type(screen.getByRole('combobox'), '田');
    await screen.findByRole('alert'); await user.click(screen.getByRole('button', { name: '再試行' }));
    await screen.findByRole('option', { name: /田中/ });
  });
});
