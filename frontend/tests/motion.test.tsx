import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import Face, { THINK_COOLDOWN, THINK_DURATION } from '../src/Face';
import Confetti from '../src/Confetti';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it('入力中の表情は短く、連続入力しても間隔を空ける', () => {
  vi.useFakeTimers();
  const { container, rerender } = render(<Face isEditing typingPulse={1} />);
  const face = () => container.querySelector('.face');
  expect(face()).toHaveAttribute('data-thinking', 'true');
  act(() => vi.advanceTimersByTime(THINK_DURATION));
  expect(face()).toHaveAttribute('data-thinking', 'false');
  rerender(<Face isEditing typingPulse={2} />);
  expect(face()).toHaveAttribute('data-thinking', 'false');
  act(() => vi.advanceTimersByTime(THINK_COOLDOWN));
  rerender(<Face isEditing typingPulse={3} />);
  expect(face()).toHaveAttribute('data-thinking', 'true');
  rerender(<Face isEditing={false} typingPulse={3} />);
  expect(face()).toHaveAttribute('data-thinking', 'false');
});
it('紙吹雪は一度表示して消える', () => {
  vi.useFakeTimers(); render(<Confetti />);
  expect(screen.getByTestId('confetti')).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1700));
  expect(screen.queryByTestId('confetti')).not.toBeInTheDocument();
});
it('動きを減らす設定では口の動きと紙吹雪を出さない', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const { container } = render(<><Face isEditing typingPulse={1} /><Confetti /></>);
  expect(container.querySelector('.face')).toHaveAttribute('data-thinking', 'false');
  expect(screen.queryByTestId('confetti')).not.toBeInTheDocument();
});
