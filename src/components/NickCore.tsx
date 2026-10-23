import type { CSSProperties } from 'react';

export type CoreState = 'idle' | 'thinking' | 'speaking' | 'offline';

/** NICK's animated "core": a decorative status indicator. State is also shown as text elsewhere. */
export function NickCore({ state = 'idle', size = 32, className = '' }: { state?: CoreState; size?: number; className?: string }) {
  return (
    <span aria-hidden className={`nick-core nick-core--${state} ${className}`} style={{ '--core-size': `${size}px` } as CSSProperties}>
      <span className="nick-core__ring--outer" />
      <span className="nick-core__ring--inner" />
      <span className="nick-core__dot" />
    </span>
  );
}
