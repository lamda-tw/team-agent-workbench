import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Server, Unplug, X } from 'lucide-react';
import type { ConnectionProfile } from '../shared/types';

export function CentralConnectionStatus({ connected, profile, open, setOpen, connect, configure, add, disconnect, message }: {
  connected: boolean; profile?: ConnectionProfile; open: boolean; setOpen: (value: boolean) => void;
  connect: () => void; configure: () => void; add: () => void; disconnect: () => Promise<void>; message?: string;
}) {
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLElement>(null);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const status = connected ? '已连接' : '未连接';
  useEffect(() => { setError(''); }, [connected, profile?.id]);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    const focusOutside = (event: FocusEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape); document.addEventListener('focusin', focusOutside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); document.removeEventListener('focusin', focusOutside); };
  }, [open, setOpen]);
  const act = (action: () => void) => { setOpen(false); action(); };
  const stop = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await disconnect(); }
    catch (reason: any) { setError(reason.message); }
    finally { lock.current = false; setBusy(false); }
  };
  return <div className="central-node-control" ref={root}>
    <button ref={trigger} className="central-node-trigger" type="button" aria-label={'中央节点：' + status} aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? 'central-node-panel' : undefined} onClick={() => setOpen(!open)}>
      <span className={'central-node-dot ' + (connected ? 'is-connected' : 'is-disconnected')} aria-hidden="true"/><span>中央节点 · {status}</span><ChevronDown size={13}/>
    </button>
    {open && <section ref={panel} id="central-node-panel" className="central-node-panel" role="dialog" aria-label="中央节点连接">
      <header><h2>中央节点</h2><button type="button" className="icon" aria-label="关闭连接面板" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={16}/></button></header>
      <div className="central-node-state" role="status"><span className={'central-node-dot ' + (connected ? 'is-connected' : 'is-disconnected')} aria-hidden="true"/>{status}</div>
      <p className="muted small">{connected ? '团队资料自动同步，本机会话照常使用。' : '本地工作可继续，连接后自动同步团队资料。'}</p>
      {profile && <div className="central-node-profile"><Server size={16}/><div><b>{profile.name || '团队中央节点'}</b><span>{profile.host}:{profile.port} · {profile.username}</span></div></div>}
      {(error || message) && <p className="inline-error" role="alert">{error || message}</p>}
      {!connected && <button className="primary central-node-connect" disabled={busy} onClick={() => act(connect)}>{profile ? '重新连接' : '连接中央节点'}</button>}
      <div className="central-node-actions">
        {profile && <button className="text-button" disabled={busy} onClick={() => act(add)}>更换节点</button>}
        {profile && <button className="text-button" disabled={busy} onClick={() => act(configure)}>连接设置</button>}
      </div>
      {connected && <button className="text-button central-node-disconnect" disabled={busy} onClick={() => void stop()}><Unplug size={13}/>{busy ? '正在断开…' : '断开连接'}</button>}
    </section>}
  </div>;
}
