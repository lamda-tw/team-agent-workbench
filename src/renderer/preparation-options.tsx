import React, { useId, useState } from 'react';
import { X } from 'lucide-react';
import type { AgentSession, PreparationCheckpoint, PreparationScope } from '../shared/types';
import { preparationDelta } from '../shared/preparation-progress';
import { contributionCategoryInfo, type ContributionCategory } from '../shared/content';
import { preparationCategories, resultCategoryBoundaries, type PreparationCategory } from '../shared/result-rules';
import { defaultPreparationDirections, preparationDirectionLimit, selectedPreparationDirections, type PreparationDirections } from '../shared/preparation-directions';

export function PreparationCategoryChoices({ categories, selected, directions, disabled, select, changeDirection }: {
  categories: readonly PreparationCategory[]; selected: PreparationCategory[]; directions: PreparationDirections; disabled: boolean;
  select: (category: PreparationCategory, checked: boolean) => void;
  changeDirection: (category: PreparationCategory, value: string) => void;
}) {
  const prefix = useId();
  return <div className="preparation-category-choices">{categories.map(category => {
    const checked = selected.includes(category), label = contributionCategoryInfo[category].label, fieldId = `${prefix}-${category}`;
    return <div key={category} className={'preparation-category-choice' + (checked ? ' selected' : '')}>
      <label className="preparation-category-toggle"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => select(category, event.target.checked)}/><span>{label}<small>{resultCategoryBoundaries[category].question}</small></span></label>
      {checked && <details className="preparation-direction"><summary>补充整理要求（选填）</summary>
        <label htmlFor={fieldId}>整理方向<span>选填 · 留空使用默认提示词</span></label>
        <textarea id={fieldId} aria-label={`${label}的整理方向`} rows={3} maxLength={preparationDirectionLimit} disabled={disabled} value={directions[category] || ''} placeholder={defaultPreparationDirections[category]} onChange={event => changeDirection(category, event.target.value)}/>
      </details>}
    </div>;
  })}</div>;
}

export function PreparationOptionsModal({ session, baseline, initialDirections, close, started, again = false }: {
  session: AgentSession; baseline?: PreparationCheckpoint; initialDirections?: PreparationDirections; again?: boolean;
  close: () => void; started: (scope: PreparationScope, categories: ContributionCategory[], directions: PreparationDirections) => Promise<void>;
}) {
  const delta = preparationDelta(session, baseline?.snapshot), canIncremental = !!baseline && delta.count > 0;
  const [scope, setScope] = useState<PreparationScope>(canIncremental ? 'incremental' : 'full');
  const [selected, setSelected] = useState<PreparationCategory[]>([...preparationCategories]);
  const [directions, setDirections] = useState<PreparationDirections>(() => ({ ...initialDirections }));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const disabled = busy;
  return <div className="modal-backdrop"><section className="modal preparation-dialog" role="dialog" aria-modal="true" aria-labelledby="preparation-options-title">
    <header><h2 id="preparation-options-title">{again ? '再次整理成果' : '整理成果'}</h2><button className="icon" aria-label="关闭整理选项" disabled={busy} onClick={close}><X size={18}/></button></header>
      <div className="modal-body">
        <p className="preparation-intro">{session.title} · {session.messages.length} 条会话消息</p>
        {(baseline || again) && <fieldset className="preparation-range"><legend>整理范围</legend><div className="preparation-options">
          <label className="preparation-option"><input type="radio" name="preparation-scope" aria-label="增量整理" checked={scope === 'incremental'} disabled={disabled || !canIncremental} onChange={() => setScope('incremental')}/><span><b>只看新增内容</b><small>{canIncremental ? `增量整理 ${delta.count} 条新增或续写消息；不会重新读取完整会话。` : delta.reason}</small></span></label>
          <label className="preparation-option"><input type="radio" name="preparation-scope" aria-label="整理对话" checked={scope === 'full'} disabled={disabled} onChange={() => setScope('full')}/><span><b>整理对话</b><small>读取全部 {session.messages.length} 条消息；已有成果会作为去重参考，并说明没有新成果的原因。</small></span></label>
        </div></fieldset>}
        <section className="preparation-classification" aria-label="整理方面">
          <h3>整理哪些方面</h3>
          <PreparationCategoryChoices categories={preparationCategories} selected={selected} directions={directions} disabled={disabled} select={(category, checked) => setSelected(values => checked ? [...values, category] : values.filter(value => value !== category))} changeDirection={(category, value) => setDirections(values => ({ ...values, [category]: value }))}/>
          {!selected.length && <p className="inline-error" role="alert">请至少选择一个整理方面。</p>}
        </section>
        <p className="muted small">按实际内容整理，不凑齐分类；独立待办逐条保留。没有新成果时会说明原因，由你确认；读取失败会提示重试。</p>
        {error && <div className="inline-error" role="alert">{error}</div>}
      </div>
      <footer><button className="secondary" disabled={busy} onClick={close}>取消</button><button className="primary" disabled={disabled || !selected.length || scope === 'incremental' && !canIncremental} onClick={async () => {
        setBusy(true); setError('');
        try { await started(scope, selected, selectedPreparationDirections(selected, directions)); close(); } catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
      }}>{busy ? '正在创建…' : scope === 'incremental' ? '开始增量整理' : '开始整理对话'}</button></footer>
  </section></div>;
}
