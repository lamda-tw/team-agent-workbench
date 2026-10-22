import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

export function CopyTextButton({ text, label, caption = false }: { text: string; label: string; caption?: boolean }) {
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const pending = useRef(false), revision = useRef(0);
  useEffect(() => { revision.current++; setState('idle'); return () => { revision.current++; }; }, [text]);
  const copy = async () => {
    if (pending.current) return;
    pending.current = true; const current = revision.current; setState('copying');
    try { await window.workbench.call('copy', text); if (current === revision.current) setState('copied'); }
    catch { if (current === revision.current) setState('error'); }
    finally { pending.current = false; }
  };
  return <span className="conversation-copy"><button type="button" className="conversation-copy-button" aria-label={label} title={label} disabled={state === 'copying'} onClick={() => void copy()}>{state === 'copied' ? <Check size={14}/> : <Copy size={14}/>}<span>{state === 'copied' ? '已复制' : state === 'copying' ? '复制中…' : caption ? '复制' : ''}</span></button>{state === 'copied' && <span className="conversation-sr-only" role="status">已复制</span>}{state === 'error' && <span className="conversation-copy-error" role="alert">复制失败，请重试</span>}</span>;
}
