import type { CSSProperties } from 'react';

/**
 * Zamari's signature glowing orb. Purely decorative (aria-hidden).
 * `level` (0–1) makes it pulse with the voice input; `active` speeds it up while thinking.
 */
export function Orb({
  size = 160,
  active = false,
  level = 0,
  className = '',
}: {
  size?: number;
  active?: boolean;
  level?: number;
  className?: string;
}) {
  const style = {
    width: size,
    height: size,
    '--orb-scale': 1 + Math.min(level, 1) * 0.18,
  } as CSSProperties;
  return <div aria-hidden="true" className={`orb ${active ? 'orb-active' : ''} ${className}`} style={style} />;
}
