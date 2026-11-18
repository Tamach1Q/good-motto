import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import App from '../src/App';
import type { Api } from '../src/types';

function makeApi(): Api {
  return {
    me: vi.fn(), preferences: vi.fn(), logout: vi.fn(),
    analyze: vi.fn().mockResolvedValue({ sentiment: 'good', target_type: 'unknown', target_id: null, target_label: null }),
    people: vi.fn().mockResolvedValue([{ id: 'p1', name: '田中' }]),
    places: vi.fn().mockResolvedValue([{ id: 'kitchen', name: '共用キッチン' }]),
    post: vi.fn().mockResolvedValue({ post_id: 'post1', status: 'created' }),
  };
}

it('チェックなしで分類し、Good/Mottoで表情が切り替わる', async () => {
  const user = userEvent.setup(), api = makeApi();
  const { container } = render(<App api={api} demo />);
  expect(container.querySelector('.face')).toHaveAttribute('data-expression', 'neutral');
  await user.type(screen.getByLabelText('メモの本文'), 'ありがとう');
  await user.click(screen.getByRole('button', { name: 'AIで分類する' }));
  await screen.findByRole('heading', { name: '投稿内容を確認' });
  expect(container.querySelector('.face')).toHaveAttribute('data-expression', 'good');
  await user.click(screen.getByRole('button', { name: 'Motto' }));
  expect(container.querySelector('.face')).toHaveAttribute('data-expression', 'motto');
  expect(screen.getByRole('button', { name: '投稿を試す' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: /対象を選ぶ/ }));
  await user.click(screen.getByRole('button', { name: '場所' }));
  expect(screen.queryByRole('combobox', { name: 'Slackの名前で検索' })).not.toBeInTheDocument();
  await user.click(await screen.findByRole('option', { name: /共用キッチン/ }));
  await user.click(screen.getByRole('button', { name: '投稿を試す' }));
  await screen.findByRole('heading', { name: '投稿を試しました' });
  expect(container.querySelector('.face')).toHaveAttribute('data-expression', 'neutral');
  expect(api.post).toHaveBeenCalledWith({ text: 'ありがとう', sentiment: 'motto', target_type: 'place', target_id: 'kitchen' });
});

it('終了確認で取り消せて、終了した場合は下書きも削除し、APIを呼ばない', async () => {
  const api = makeApi(), user = userEvent.setup(); render(<App api={api} demo />);
  await user.type(screen.getByLabelText('メモの本文'), 'まだ送らない');
  await user.click(screen.getByLabelText('設定'));
  await user.click(screen.getByRole('checkbox', { name: /下書きを保存/ }));
  await user.click(screen.getByLabelText('設定'));
  await user.click(screen.getByRole('button', { name: '投稿せずに終える' }));
  await user.click(screen.getByRole('button', { name: '書き続ける' }));
  expect(screen.getByLabelText('メモの本文')).toHaveValue('まだ送らない');
  await user.click(screen.getByRole('button', { name: '投稿せずに終える' }));
  await user.click(screen.getByRole('button', { name: '消して終了' }));
  await screen.findByRole('heading', { name: '投稿せずに終了しました' });
  await waitFor(() => expect(sessionStorage.getItem('good-motto-draft-v3')).toBeNull());
  expect(api.analyze).not.toHaveBeenCalled(); expect(api.post).not.toHaveBeenCalled();
});
