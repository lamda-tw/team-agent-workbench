import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ExternalLink, RefreshCw, X } from 'lucide-react';
import type { AgentSession } from '../shared/types';
import type { CursorNativeSettings, CursorSettingKind } from '../shared/cursor-native-settings';

const titles = { model: '模型', mode: '模式', permission: '执行权限' };
export function CursorNativeSettingsControls({ session }: { session: AgentSession }) {
  const [open,setOpen]=useState<CursorSettingKind>(),[catalog,setCatalog]=useState<CursorNativeSettings>(),[loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const root=useRef<HTMLDivElement>(null),sequence=useRef(0);
  const actual=session.cursorSettings,connected=session.desktopSyncState==='connected',pending=actual?.pending;
  useEffect(()=>{const dismiss=(event:MouseEvent)=>{if(!root.current?.contains(event.target as Node)){sequence.current++;setOpen(undefined);}};const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){sequence.current++;setOpen(undefined);}};document.addEventListener('mousedown',dismiss);document.addEventListener('keydown',key);return()=>{sequence.current++;document.removeEventListener('mousedown',dismiss);document.removeEventListener('keydown',key);};},[]);
  const call=(extra:object)=>window.workbench.call<CursorNativeSettings>('session.cursorNative.settings',{id:session.id,...extra});
  const refresh=async(kind:CursorSettingKind)=>{const n=++sequence.current;setOpen(kind);setLoading(true);setError('');try{const result=await call({kind});if(n===sequence.current)setCatalog(result);}catch(e:any){if(n===sequence.current)setError(e.message);}finally{if(n===sequence.current)setLoading(false);}};
  const apply=async(value:string)=>{if(!open||!catalog)return;setSaving(true);setError('');try{await call({kind:open,value,revision:catalog.revision});setOpen(undefined);}catch(e:any){setError(e.message);}finally{setSaving(false);}};
  const focus=()=>{setError('');void window.workbench.call('session.cursorNative.focus',{id:session.id}).catch(e=>setError(e.message));};
  return <div className="cursor-native-settings" ref={root}>
    <div className="cursor-native-settings-controls">{(['mode','model','permission'] as const).map(kind=><button key={kind} className="composer-setting" aria-label={`Cursor ${titles[kind]}`} aria-expanded={open===kind} disabled={saving||!connected||!!pending} title={!connected?'连接 Cursor 后读取实际设置':actual?.[kind]?.description||titles[kind]} onClick={()=>open===kind?setOpen(undefined):void refresh(kind)}><span>{actual?.[kind]?.label||titles[kind]+'待确认'}</span><ChevronDown size={12}/></button>)}
      <button className="composer-setting" title="在原生会话中选择 Skill、MCP 和参考文件；两端共用" onClick={focus}>在 Cursor 中打开<ExternalLink size={12}/></button>
    </div>
    {open&&<section className="composer-popover" role="dialog" aria-label={`Cursor ${titles[open]}`}><header><strong>{titles[open]}</strong><span className="spacer"/><button className="icon" aria-label="刷新原生设置" disabled={loading||saving} onClick={()=>void refresh(open)}><RefreshCw size={13}/></button><button className="icon" aria-label="关闭原生设置" onClick={()=>setOpen(undefined)}><X size={14}/></button></header>
      {open==='permission'&&<p className="muted small">使用 Cursor 的运行权限设置，可能影响其他会话。原生确认仍需你处理。</p>}
      {loading?<p className="muted small">正在读取 Cursor…</p>:<div role="group" aria-label="原生可用选项">{catalog?.[open]?.options.map(option=><button key={option.id} className="setting-option" disabled={saving||option.disabled||catalog.state!=='ready'} aria-pressed={actual?.[open]?.id===option.id} onClick={()=>void apply(option.id)}><span>{option.label}{option.description&&<small>{option.description}</small>}</span>{actual?.[open]?.id===option.id&&<Check size={14}/>}</button>)}</div>}
      {!loading&&catalog?.state==='unavailable'&&<p className="inline-error">{catalog.error}</p>}
      {error&&<p className="inline-error" role="alert">{error}</p>}
    </section>}
    {pending&&<div className="cursor-native-settings-pending" role="status"><span>{pending.state==='waiting'?`等待本轮结束后切换${titles[pending.kind]}：${pending.label}`:pending.state==='confirming'?`正在确认${titles[pending.kind]}，如有确认窗口请在 Cursor 中处理`:pending.error}</span><button className="text-button" disabled={saving} onClick={()=>{setSaving(true);void call({cancel:true}).catch(e=>setError(e.message)).finally(()=>setSaving(false));}}>{pending.state==='waiting'?'取消更改':'沿用 Cursor 当前设置'}</button></div>}
    {!pending&&(!connected||actual?.state==='unavailable')&&<span className="muted small">{!connected?'连接 Cursor 后同步设置':'设置待确认；新消息会等待'}</span>}
    {!open&&error&&<span className="inline-error" role="alert">{error}</span>}
  </div>;
}
