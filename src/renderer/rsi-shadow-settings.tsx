import React, { useEffect, useState } from 'react';
import type { RsiShadowSettings as Settings } from '../shared/rsi';

/** Controls only: shadow results never enter the conversation or notification UI. */
export function RsiShadowSettings({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [value, setValue] = useState<Settings>();
  const [enabled, setEnabled] = useState(false), [dailyCalls, setDailyCalls] = useState(24);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    void window.workbench.call<Settings>('rsi.settings', { projectId }).then(next => {
      if (!active) return;
      setValue(next); setEnabled(next.config.enabled && !next.config.quiet); setDailyCalls(next.config.dailyCalls);
    }, reason => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [projectId]);
  const save = async () => {
    setBusy(true); setError(''); setSaved(false);
    try {
      await window.workbench.call('rsi.shadow.configure', { projectId, config: { enabled, dailyCalls } });
      setSaved(true);
    } catch (reason: any) { setError(reason.message); }
    finally { setBusy(false); }
  };
  return <section aria-label="项目助手设置">
    <h3>项目助手 · {projectName}</h3>
    <p className="muted small">对话完成后在后台分析项目进展，仅保留本机记录，不显示建议、不改变对话。开启后使用个人模型额度。</p>
    {value && <>
      <label className="check-row"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => { setEnabled(event.target.checked); setSaved(false); }}/>开启项目助手（后台运行）</label>
      <label className="field">每日最多调用次数<input type="number" min="1" max="100" value={dailyCalls} disabled={busy} onChange={event => { setDailyCalls(Number(event.target.value)); setSaved(false); }}/></label>
      <p className="muted small">{value.sourceSession ? `使用会话「${value.sourceSession.title}」的模型：${value.sourceSession.model || '尚未选择，暂不分析'}` : '创建工作会话并选择模型后，才会开始分析。'}</p>
      <button className="secondary compact" disabled={busy || !Number.isInteger(dailyCalls) || dailyCalls < 1 || dailyCalls > 100} onClick={() => void save()}>{busy ? '正在保存…' : '保存项目助手设置'}</button>
      {saved && <span className="muted small" role="status"> 已保存</span>}
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
