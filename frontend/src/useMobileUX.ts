import { useEffect, useState } from 'react';

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;
    const update = () => setReduced(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** キーボードで実際に見えている領域に合わせる。ズーム中は書き換えません。 */
export function useMobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const update = () => {
      if (viewport.scale !== 1) { delete root.dataset.keyboard; root.style.removeProperty('--visible-height'); root.style.removeProperty('--visible-top'); return; }
      const editing = document.activeElement?.matches('textarea,input:not([type=checkbox])');
      const keyboard = !!editing && window.innerHeight - viewport.height > 120;
      root.dataset.keyboard = String(keyboard);
      if (keyboard) {
        root.style.setProperty('--visible-height', `${viewport.height}px`);
        root.style.setProperty('--visible-top', `${viewport.offsetTop}px`);
      } else {
        root.style.removeProperty('--visible-height'); root.style.removeProperty('--visible-top');
      }
    };
    viewport.addEventListener('resize', update); viewport.addEventListener('scroll', update);
    document.addEventListener('focusin', update); document.addEventListener('focusout', update);
    update();
    return () => {
      viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update);
      document.removeEventListener('focusin', update); document.removeEventListener('focusout', update);
      delete root.dataset.keyboard; root.style.removeProperty('--visible-height'); root.style.removeProperty('--visible-top');
    };
  }, []);
}
