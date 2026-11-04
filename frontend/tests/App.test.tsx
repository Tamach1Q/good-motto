import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { ApiError } from '../src/api';
import TargetPicker from '../src/TargetPicker';
import type { Api, Person } from '../src/types';

function makeApi(): Api {
  return {
    me: vi.fn().mockResolvedValue({ person_id: 'self', display_name: '利用者', terms_accepted: true, feedback_opt_in: false }),
    preferences: vi.fn().mockImplementation(input => Promise.resolve({ person_id: 'self', display_name: '利用者', ...input })),
    logout: vi.fn().mockResolvedValue(undefined),
    analyze: vi.fn().mockResolvedValue({ sentiment: 'motto', target_type: 'person', target_id: 'ai-guessed-id', target_label: '田中さん' }),
    people: vi.fn().mockResolvedValue([{ id: 'person_001', name: '田中 太郎' }, { id: 'person_003', name: '田中 太郎' }]),
    places: vi.fn().mockResolvedValue([{ id: 'kitchen', name: '共用キッチン' }]),
    post: vi.fn().mockResolvedValue({ post_id: 'post_001', status: 'created' }),
  };
}
async function review(api: Api) {
  const user = userEvent.setup(); render(<App api={api} demo={false} />);
  await screen.findByLabelText('メモの本文');
  expect(screen.getByRole('button', { name: /内容を確認する/ })).toBeDisabled();
  await user.type(screen.getByLabelText('メモの本文'), '最後まで話を聞いてほしかった');
  await user.click(screen.getByRole('checkbox', { name: /このタブに下書き/ }));
  await user.click(screen.getByRole('button', { name: /内容を確認する/ }));
  await screen.findByRole('heading', { name: '投稿内容を確認' });
  return user;
}

describe('投稿の流れ', () => {
  it('初期状態では保存せず、保存を選んだ時だけ記録し、オフで削除する', async () => {
    sessionStorage.setItem('good-motto-draft-v1', '古い自動保存');
    const user = userEvent.setup(); const { unmount } = render(<App api={makeApi()} />);
    expect(screen.getByLabelText('メモの本文')).toHaveValue('');
    expect(sessionStorage.getItem('good-motto-draft-v1')).toBeNull();
    await user.type(screen.getByLabelText('メモの本文'), '保存は選択制');
    expect(sessionStorage.getItem('good-motto-draft-v2')).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: /このタブに下書き/ }));
    expect(sessionStorage.getItem('good-motto-draft-v2')).toBe('保存は選択制');
    unmount(); render(<App api={makeApi()} />);
    expect(screen.getByLabelText('メモの本文')).toHaveValue('保存は選択制');
    await user.click(screen.getByRole('checkbox', { name: /このタブに下書き/ }));
    expect(sessionStorage.getItem('good-motto-draft-v2')).toBeNull();
    expect(screen.getByLabelText('メモの本文')).toHaveValue('保存は選択制');
  });
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
    expect(sessionStorage.getItem('good-motto-draft-v2')).toBeNull();
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
    expect(sessionStorage.getItem('good-motto-draft-v2')).toBe('最後まで話を聞いてほしかった');
  });
  it('分析エラーでは確認画面へ進まず、再試行用に入力を維持する', async () => {
    const api = makeApi(); api.analyze = vi.fn().mockRejectedValue(new Error('分類できませんでした'));
    const user = userEvent.setup(); render(<App api={api} />);
    await user.type(screen.getByLabelText('メモの本文'), '入力したメモ');
    await user.click(screen.getByRole('checkbox', { name: /本文をサーバー経由/ }));
    await user.click(screen.getByRole('button', { name: /内容を確認する/ }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('メモの本文')).toHaveValue('入力したメモ');
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('ログインと利用設定', () => {
  it('未ログインなら入力を表示せずSlackログインへ誘導する', async () => {
    const api = makeApi(); api.me = vi.fn().mockRejectedValue(new ApiError('未ログイン', 401));
    render(<App api={api} demo={false} />);
    expect(await screen.findByRole('link', { name: 'Slackでログインする' })).toHaveAttribute('href', '/api/v1/auth/slack/login');
    expect(screen.queryByLabelText('メモの本文')).not.toBeInTheDocument();
    expect(api.analyze).not.toHaveBeenCalled();
  });
  it('利用同意をサーバーに保存し、DM受信は初期オフ、設定から撤回できる', async () => {
    const api = makeApi(); api.me = vi.fn().mockResolvedValue({ person_id: 'self', display_name: '利用者', terms_accepted: false, feedback_opt_in: false });
    const user = userEvent.setup(); render(<App api={api} demo={false} />);
    await screen.findByRole('heading', { name: '利用設定' });
    expect(screen.getByRole('checkbox', { name: /週次レポート/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: '設定を保存する' })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /サービスの利用に同意/ }));
    await user.click(screen.getByRole('checkbox', { name: /週次レポート/ }));
    await user.click(screen.getByRole('button', { name: '設定を保存する' }));
    await screen.findByLabelText('メモの本文');
    expect(api.preferences).toHaveBeenLastCalledWith({ terms_accepted: true, feedback_opt_in: true });
    expect(screen.queryByRole('link', { name: /ログイン/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '利用設定' }));
    await user.click(screen.getByRole('checkbox', { name: /週次レポート/ }));
    await user.click(screen.getByRole('button', { name: '設定を保存する' }));
    expect(api.preferences).toHaveBeenLastCalledWith({ terms_accepted: true, feedback_opt_in: false });
  });
  it('分析中にセッションが切れたらログイン画面に戻り、再確認後に本文を復元する', async () => {
    const api = makeApi(); api.analyze = vi.fn().mockRejectedValue(new ApiError('期限切れ', 401));
    const user = userEvent.setup(); render(<App api={api} demo={false} />);
    await user.type(await screen.findByLabelText('メモの本文'), '保持するメモ');
    await user.click(screen.getByRole('button', { name: /内容を確認する/ }));
    await screen.findByRole('link', { name: 'Slackでログインする' });
    await user.click(screen.getByRole('button', { name: 'ログイン状態を再確認' }));
    expect(await screen.findByLabelText('メモの本文')).toHaveValue('保持するメモ');
    expect(api.post).not.toHaveBeenCalled();
  });
  it('403で利用同意が必要な状態になった場合は同意画面へ戻す', async () => {
    const api = makeApi();
    vi.mocked(api.me).mockResolvedValueOnce({ person_id: 'self', display_name: '利用者', terms_accepted: true, feedback_opt_in: false }).mockResolvedValue({ person_id: 'self', display_name: '利用者', terms_accepted: false, feedback_opt_in: false });
    api.analyze = vi.fn().mockRejectedValue(new ApiError('利用同意が必要', 403));
    const user = userEvent.setup(); render(<App api={api} demo={false} />);
    await user.type(await screen.findByLabelText('メモの本文'), 'メモ');
    await user.click(screen.getByRole('button', { name: /内容を確認する/ }));
    await screen.findByRole('heading', { name: '利用設定' });
    expect(api.post).not.toHaveBeenCalled();
  });
  it('ログアウトに成功したら本文と保存済み下書きを消す', async () => {
    const api = makeApi(), user = userEvent.setup(); render(<App api={api} demo={false} />);
    await user.type(await screen.findByLabelText('メモの本文'), '下書き');
    await user.click(screen.getByRole('checkbox', { name: /このタブに下書き/ }));
    await user.click(screen.getByRole('button', { name: 'ログアウト' }));
    await screen.findByRole('link', { name: 'Slackでログインする' });
    expect(api.logout).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('good-motto-draft-v2')).toBeNull();
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
