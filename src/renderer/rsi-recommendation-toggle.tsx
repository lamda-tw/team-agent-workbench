import React, { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { RsiShadowSettings } from '../shared/rsi';
import type { WorkbenchAPI } from '../shared/types';

export function RsiRecommendationToggle({ projectId, projectName, call, open, pending = 0 }: { projectId: string; projectName: string; call: WorkbenchAPI['call']; open?: () => void; pending?: number }) {
  const [config, setConfig] = useState<RsiShadowSettings['config']>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const locked = useRef(false), alive = useRef(false);
  const load = async () => {
    setError('');
    try { const value = await call<RsiShadowSettings>('rsi.settings', { projectId }); if (alive.current) setConfig(value.config); }
    catch (reason: any) { if (alive.current) setError(reason.message); }
  };
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [projectId, call]);
  const enabled = !!config?.enabled && !config.quiet;
  const toggle = async () => {
    if (!config || locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const next = await call<RsiShadowSettings['config']>('rsi.shadow.configure', { projectId, config: { enabled: !enabled, dailyCalls: config.dailyCalls } });
      if (alive.current) setConfig(next);
    } catch (reason: any) { if (alive.current) setError(reason.message); }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="project-ai-control">
    <div className="project-ai-row">{open ? <button type="button" className="project-ai-label-button" aria-label={'查看AI推荐：' + projectName} onClick={open}><Sparkles size={12}/>AI推荐{pending > 0 && <span className="project-ai-pending">{pending}</span>}</button> : <span className="project-ai-label"><Sparkles size={12}/>AI推荐</span>}<button type="button" role="switch" className="project-ai-switch" aria-label={'AI推荐：' + projectName} aria-checked={enabled} disabled={!config || busy} title={busy ? '正在保存' : enabled ? '关闭本项目的后台分析' : '开启本项目的后台分析，使用个人模型额度'} onClick={() => void toggle()}><span/></button></div>
    {error && <div className="inline-error" role="alert">{error}{!config && <button className="text-button" onClick={() => void load()}>重试</button>}</div>}
  </div>;
}
