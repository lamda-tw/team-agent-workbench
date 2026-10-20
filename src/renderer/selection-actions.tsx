import React, { useEffect, useRef, useState } from 'react';

export function SelectionActions({ sessionId, add, fork, children }: {
  sessionId: string; add?: (text: string) => void; fork?: (text: string) => void; children: React.ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ text: string; x: number; y: number }>();
  useEffect(() => {
    setSelection(undefined);
    const capture = () => {
      const selected = window.getSelection();
      if (!selected || selected.isCollapsed || !root.current?.contains(selected.anchorNode) || !root.current.contains(selected.focusNode)) { setSelection(undefined); return; }
      if (selected.anchorNode?.parentElement?.closest('textarea,input,button,[role=toolbar]')) return;
      const text = selected.toString();
      if (!text.trim() || text.length > 128 * 1024) { setSelection(undefined); return; }
      const rect = selected.getRangeAt(0).getBoundingClientRect();
      setSelection({ text, x: Math.max(8, Math.min(rect.left, window.innerWidth - 280)), y: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 46)) });
    };
    const clear = () => setSelection(undefined);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
    document.addEventListener('selectionchange', capture);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', clear);
    window.addEventListener('scroll', clear, true);
    return () => { document.removeEventListener('selectionchange', capture); document.removeEventListener('keydown', escape); window.removeEventListener('resize', clear); window.removeEventListener('scroll', clear, true); };
  }, [sessionId]);
  const act = (callback: (text: string) => void) => {
    if (!selection) return;
    const text = selection.text; setSelection(undefined); window.getSelection()?.removeAllRanges(); callback(text);
  };
  return <div className="selection-content" ref={root}>{children}
    {selection && (add || fork) && <div className="selection-actions" role="toolbar" aria-label="选中文字操作" style={{ left: selection.x, top: selection.y }} onPointerDown={event => event.preventDefault()}>
      {add && <button type="button" onClick={() => act(add)}>添加到会话</button>}
      {fork && <button type="button" onClick={() => act(fork)}>在子会话中提问</button>}
    </div>}
  </div>;
}
