import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from './useMobileUX';

export type Expression = 'neutral' | 'good' | 'motto';
export const THINK_COOLDOWN = 6500;
export const THINK_DURATION = 1200;

/** 元のFigmaの座標・輪郭を維持し、目と口だけを動かします。 */
export default function Face({ expression = 'neutral', typingPulse = 0, isEditing = false }: {
  expression?: Expression; typingPulse?: number; isEditing?: boolean;
}) {
  const reduced = useReducedMotion();
  const [thinking, setThinking] = useState(false);
  const last = useRef(-Infinity);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isEditing || reduced) {
      if (timer.current) clearTimeout(timer.current);
      setThinking(false);
    } else if (typingPulse > 0 && Date.now() - last.current >= THINK_COOLDOWN) {
      last.current = Date.now(); setThinking(true);
      timer.current = setTimeout(() => setThinking(false), THINK_DURATION);
    }
  }, [typingPulse, isEditing, reduced]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const face = thinking ? 'motto' : expression;
  return <div className="face" data-expression={face} data-thinking={thinking} aria-hidden="true">
    <svg width="132" height="84" viewBox="0 0 132 84" fill="none">
      <g className="face-pose">
        <g className="open-eyes" style={{ opacity: face === 'good' ? 0 : 1, transform: `translateX(${face === 'motto' ? 7 : 0}px)` }}>
          <g className="blinking-eyes"><circle cx="34" cy="35" r="5.6" fill="#131313" /><circle cx="98" cy="35" r="5.6" fill="#131313" /></g>
        </g>
        <path className="expression-layer" style={{ opacity: face === 'good' ? 1 : 0 }} d="M28.5 35H39.5M92.5 35H103.5" stroke="#131313" strokeWidth="4" strokeLinecap="round" />
        <g className="thinking-mouth">
          {(['neutral', 'good', 'motto'] as const).map(expression => <path key={expression} className="expression-layer" style={{ opacity: face === expression ? 1 : 0 }}
            d={expression === 'good' ? 'M57 48C63 56 69 56 75 48' : expression === 'motto' ? 'M58 51L74 48' : 'M58 51H74'} stroke="#131313" strokeWidth="4.5" strokeLinecap="round" />)}
        </g>
      </g>
    </svg>
  </div>;
}
