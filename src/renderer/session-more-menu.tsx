import React, { useEffect, useRef } from 'react';
import { Ellipsis } from 'lucide-react';

export function SessionMoreMenu({ label = '更多会话操作', children }: { label?: string; children: React.ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (menu.current?.open && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return <details className="session-more" ref={menu}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false; }}
    onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); }
    }}>
    <summary role="button" aria-label={label} title={label}><Ellipsis size={18}/></summary>
    <div className="session-more-actions" onClick={event => {
      const button = (event.target as Element).closest('button');
      if (button && !button.disabled && menu.current) menu.current.open = false;
    }}>{children}</div>
  </details>;
}
