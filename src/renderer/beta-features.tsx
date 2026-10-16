import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { BetaFeature, BetaFeatureSettings } from '../shared/types';
import { cursorSharedSessionUnavailable } from '../shared/cursor-session-consistency';

export function betaFeatureStates(features: BetaFeatureSettings = {}) {
  return {
    sessionHandoff: !!features.sessionHandoff,
    subsessions: !!(features.subsessions ?? features.sessionHandoff),
    codexDesktopSync: !!features.codexDesktopSync,
    cursorDesktopSync: !!features.cursorDesktopSync,
  };
}

export function BetaFeaturesModal({ features, close, changed }: { features: BetaFeatureSettings; close: () => void; changed: () => Promise<void> }) {
  const [desired, setDesired] = useState(() => betaFeatureStates(features));
  const [busy, setBusy] = useState<BetaFeature>();
  const [error, setError] = useState('');
  useEffect(() => setDesired(betaFeatureStates(features)), [features.sessionHandoff, features.subsessions, features.codexDesktopSync, features.cursorDesktopSync]);

  const toggle = async (feature: BetaFeature, enabled: boolean) => {
    setDesired(current => ({ ...current, [feature]: enabled }));
    setBusy(feature);
    setError('');
    try {
      await window.workbench.call('beta.set', { feature, enabled });
      await changed();
    } catch (reason: any) {
      setError(reason.message);
      setDesired(betaFeatureStates(features));
    } finally { setBusy(undefined); }
  };

  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="beta-features-title">
    <header><h2 id="beta-features-title">Beta 功能</h2><button className="icon" aria-label="关闭窗口" onClick={close}><X size={19}/></button></header>
    <div className="modal-body">
      <p className="muted small">试用功能可分别开启或关闭，设置只作用于当前团队账号。</p>
      <div className="beta-feature"><div><strong>跨会话引用</strong><span className="badge">Beta</span>
        <p>手动选择同项目其他会话的摘要快照。项目会话日志已默认自动提供，不受此开关影响。</p>
        <p className="muted small">引用个人会话内容后，轨迹自动上传会关闭；如需共享轨迹，请先核对内容再手动上传。</p>
      </div><label className="beta-feature-toggle"><input type="checkbox" role="switch" aria-label="开启跨会话引用" checked={desired.sessionHandoff} disabled={!!busy} onChange={event => void toggle('sessionHandoff', event.target.checked)}/><span>{desired.sessionHandoff ? '已开启' : '未开启'}</span></label></div>
      <div className="beta-feature"><div><strong>Subsession</strong><span className="badge">Beta</span>
        <p>从当前会话派生独立工作会话；子会话回报经你查看和选入后，才会发送给父会话的 AI。</p>
        <p className="muted small">关闭后不能新建 Subsession 或回报；已创建的子会话和已有回报保留。</p>
      </div><label className="beta-feature-toggle"><input type="checkbox" role="switch" aria-label="开启 Subsession" checked={desired.subsessions} disabled={!!busy} onChange={event => void toggle('subsessions', event.target.checked)}/><span>{desired.subsessions ? '已开启' : '未开启'}</span></label></div>
      <div className="beta-feature"><div><strong>Codex 桌面联动</strong><span className="badge">Beta</span>
        <p>新建 Codex 会话时可选择联动。首次发送自动启动或复用后台；需要原生界面时再打开，多条会话保留各自上下文。</p>
        <p className="muted small">当前支持本机网络。关闭后不再新建联动会话，已创建的会话继续保留。</p>
      </div><label className="beta-feature-toggle"><input type="checkbox" role="switch" aria-label="开启 Codex 桌面联动" checked={desired.codexDesktopSync} disabled={!!busy} onChange={event => void toggle('codexDesktopSync',event.target.checked)}/><span>{desired.codexDesktopSync?'已开启':'未开启'}</span></label></div>
      <div className="beta-feature"><div><strong>Cursor 原生联动</strong><span className="badge">Beta</span><p>从“导入 Cursor 会话”关联普通 IDE 当前打开的原生会话。两端使用同一个 Cursor 执行，工作台提交的后续消息会等待前一轮结束。</p><p className="muted small">请保留普通 IDE 窗口；切换会话后，可点击“在 Cursor 中打开”切回已有标签页。模型、模式和权限双向同步，工具及授权在 Cursor 中处理；暂不关联独立的 Agents 窗口。</p></div><label className="beta-feature-toggle"><input type="checkbox" role="switch" aria-label="开启 Cursor 原生联动" checked={desired.cursorDesktopSync} disabled={!!busy} onChange={event => void toggle('cursorDesktopSync',event.target.checked)}/><span>{desired.cursorDesktopSync?'已开启':'未开启'}</span></label></div>
      {error && <div className="inline-error" role="alert">{error}</div>}
    </div><footer><button className="primary" disabled={!!busy} onClick={close}>完成</button></footer>
  </section></div>;
}
