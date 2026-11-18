import { useEffect, useState, type CSSProperties } from 'react';
import { useReducedMotion } from './useMobileUX';

/** 成功画面のマウント時だけ一回。音・ループ・入力ブロックなし。 */
export default function Confetti() {
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(true);
  useEffect(() => { const timer = setTimeout(() => setVisible(false), 1700); return () => clearTimeout(timer); }, []);
  if (reduced || !visible) return null;
  return <div className="confetti" aria-hidden="true" data-testid="confetti">{Array.from({ length: 18 }, (_, i) => {
    const angle = (i / 17) * Math.PI;
    return <i key={i} style={{ '--x': `${Math.cos(angle) * (85 + i % 3 * 24)}px`, '--y': `${-Math.sin(angle) * (100 + i % 4 * 20)}px`, '--spin': `${(i % 2 ? 1 : -1) * (120 + i * 19)}deg`, '--delay': `${i % 3 * 25}ms`, background: i % 3 ? '#131313' : '#b3b3b3' } as CSSProperties} />;
  })}</div>;
}
