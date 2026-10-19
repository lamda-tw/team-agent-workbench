import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Draft, DraftArtifact, ProjectConclusion, Transfer } from '../shared/types';
import { contributionCategoryInfo, titleSubject } from '../shared/content';
import { isProjectOrganizationDraft, projectOrganizationFields, projectOrganizationValues } from '../shared/project-organization';
import { OrganizationTags } from './organization-tags';
import { resultCategory } from '../shared/result-model';
import { ResultCategoryDialog } from './result-lifecycle';
import { DraftAttachments } from './attachments';
import { useAutosave } from './autosave';

export interface PreparationReviewHandle { flush: () => Promise<void> }
type Run = <T>(fn: () => Promise<T>) => Promise<T | undefined>;
export const PreparationReview = forwardRef<PreparationReviewHandle, { draft: Draft; locked: boolean; run: Run; transfers: Transfer[]; viewShared: (projectId: string, path: string) => void }>(function PreparationReview({ draft, locked, run, transfers, viewShared }, ref) {
  const [selected, setSelected] = useState(draft.artifacts?.[0]?.id), [classifying, setClassifying] = useState<DraftArtifact>();
  const [existing, setExisting] = useState<ProjectConclusion[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(new Map<string, () => Promise<void>>());
  const flush = async () => { for (const save of pending.current.values()) await save(); };
  useImperativeHandle(ref, () => ({ flush }));
  useEffect(() => { let active = true; if (draft.binding) void window.workbench.call<ProjectConclusion[]>('conclusion.list', { projectId: draft.binding.project.id }).then(items => { if (active) setExisting(items); }, reason => { if (active) setError('读取已有能力失败：' + reason.message); }); return () => { active = false; }; }, [draft.id, draft.personalSavedIds?.join(':')]);
  const item = draft.artifacts?.find(item => item.id === selected) || draft.artifacts?.[0];
  const profile = isProjectOrganizationDraft(draft), projectName = draft.binding?.project.name || '当前项目';
  return <section className="preparation-review" aria-label="检查整理结果">
    <div className="preparation-review-layout"><aside className="preparation-review-list"><div className="muted small">选择要保存的内容 · {draft.artifacts?.length} 条</div>{draft.artifacts?.map(value => <div key={value.id} className={'preparation-review-choice' + (item?.id === value.id ? ' active' : '')}>
      <input type="checkbox" aria-label={`选择成果：${titleSubject(value.title)}`} checked={value.selected} disabled={locked || busy} onChange={event => void run(async () => { await flush(); await window.workbench.call('draft.artifactSelection', { id: draft.id, artifactId: value.id, selected: event.target.checked }); })}/>
      <button type="button" disabled={busy} onClick={() => setSelected(value.id)}><span className="content-category-badge">{profile ? '项目整理' : contributionCategoryInfo[resultCategory(value)!].label}</span><b>{profile ? projectName : titleSubject(value.titleAlias || value.title)}</b>{profile && value.fields?.sentence && <small className="organization-choice-sentence">{value.fields.sentence}</small>}<small>{profile ? '本项目一条' : value.updateTarget ? '更新已有能力' : '新增一条记录'}{draft.personalSavedIds?.includes(value.id) ? ' · 已存个人' : ''}{value.submitted ? ' · 已提交团队' : ''}</small>{profile && <OrganizationTags technologies={value.fields?.technologies || ''} achievements={value.fields?.achievements || ''} />}</button>
    </div>)}</aside>
    {item && <PreparationArtifactEditor key={item.id + ':' + (item.classificationVersion || 0) + ':' + draft.generationFinishedAt} item={item} draft={draft} existing={existing} locked={locked || busy} register={save => pending.current.set(item.id, save)} run={run} classify={async () => { try { await flush(); setError(''); setClassifying(item); } catch (reason: any) { setError(reason.message); } }} transfer={transfers.find(value => value.id === item.submitted)} viewShared={viewShared}/>}
    </div>{error && <div className="inline-error" role="alert">{error}</div>}
    {classifying && <ResultCategoryDialog category={resultCategory(classifying)!} busy={busy} error={error} close={() => setClassifying(undefined)} save={category => { setBusy(true); setError(''); void (async () => { try { await flush(); await window.workbench.call('draft.category', { id: draft.id, artifactId: classifying.id, category }); setClassifying(undefined); } catch (reason: any) { setError(reason.message); } finally { setBusy(false); } })(); }}/>}
  </section>;
});

function PreparationArtifactEditor({ item, draft, existing, locked, register, run, classify, transfer, viewShared }: { item: DraftArtifact; draft: Draft; existing: ProjectConclusion[]; locked: boolean; register: (save: () => Promise<void>) => void; run: Run; classify: () => void; transfer?: Transfer; viewShared: (projectId: string, path: string) => void }) {
  const profile = isProjectOrganizationDraft(draft);
  const editor = useAutosave('artifact:' + draft.id + ':' + item.id + ':' + (item.classificationVersion || 0) + ':' + draft.generationFinishedAt, {
    title: titleSubject(item.title), body: item.body, updateTarget: profile ? null : item.updateTarget || null, organization: profile ? projectOrganizationValues(item.fields) : undefined,
  }, value => window.workbench.call('draft.artifact.edit', profile ? { id: draft.id, artifactId: item.id, organization: value.organization } : { id: draft.id, artifactId: item.id, title: value.title, body: value.body, updateTarget: value.updateTarget }));
  useEffect(() => { register(editor.flush); });
  const targets = existing.filter(value => !value.archived && !value.deletedAt && resultCategory(value) === 'capability');
  const selectedTarget = targets.find(value => value.id === editor.value.updateTarget?.id);
  const organization = editor.value.organization;
  const projectName = draft.binding?.project.name || '当前项目';
  return <div className="preparation-review-content">{profile && organization && <header className="organization-scan"><h2>{projectName}</h2>{organization.sentence && <p>{organization.sentence}</p>}<OrganizationTags technologies={organization.technologies} achievements={organization.achievements} /></header>}<div className="row"><span className="content-category-badge">{profile ? '项目整理' : contributionCategoryInfo[resultCategory(item)!].label}</span>{!profile && <button className="text-button" disabled={locked} onClick={classify}>修改分类</button>}<span className="spacer"/><span className="muted small">{profile ? '旧版项目概览，可编辑或再次整理为分类成果' : '可直接编辑内容'}</span></div>
    {profile && organization && projectOrganizationFields.map(field => <label className="field" key={field.key}>{field.label}<textarea aria-label={field.label} rows={field.rows} maxLength={field.max} disabled={locked} placeholder={field.hint} value={organization[field.key]} onChange={event => editor.change({ ...editor.value, organization: { ...organization, [field.key]: event.target.value } })}/></label>)}
    {!profile && <label className="field">标题<input aria-label="整理成果标题" maxLength={120} value={editor.value.title} disabled={locked} onChange={event => editor.change({ ...editor.value, title: event.target.value })}/></label>}
    {!profile && resultCategory(item) === 'capability' && !!targets.length && <div className="preparation-update-choice"><label className="field">保存个人成果时<select aria-label="已有能力更新目标" disabled={locked || draft.personalSavedIds?.includes(item.id)} value={editor.value.updateTarget?.id || ''} onChange={event => { const target = targets.find(value => value.id === event.target.value); editor.change({ ...editor.value, updateTarget: target ? { scope: 'personal', projectId: draft.binding!.project.id, id: target.id, version: target.version } : null }); }}><option value="">另存为新条目</option>{targets.map(target => <option key={target.id} value={target.id}>更新：{titleSubject(target.title)} · v{target.version}</option>)}</select></label>{selectedTarget && <small>将 v{editor.value.updateTarget!.version} 更新为 v{editor.value.updateTarget!.version + 1}，旧版本保留。提交团队时作为新成果上传。</small>}</div>}
    {draft.personalSavedIds?.includes(item.id) && <p className="muted small">个人库已保存；这里的修改只用于后续团队提交。</p>}
    {!profile && <label className="field">正文<textarea aria-label="整理成果正文" rows={9} disabled={locked} value={editor.value.body} onChange={event => editor.change({ ...editor.value, body: event.target.value })}/></label>}
    {editor.status !== '已保存' && <div className="row muted small" role="status">{editor.status}{editor.status.startsWith('保存失败') && <button className="text-button" onClick={editor.retry}>重试保存</button>}</div>}
    <details className="content-provenance"><summary>查看依据</summary><p>{draft.sourceSessionTitle || '本次冻结的对话与资料'}{draft.snapshot && ` · 截至 ${new Date(draft.snapshot.capturedAt).toLocaleString()}`}</p>{item.sourceDetails && <pre>{item.sourceDetails}</pre>}</details>
    <DraftAttachments draft={draft} artifact={item} locked={locked} run={run}/>
    {transfer && <p className={'badge ' + transfer.status}>{{ queued: '等待上传', running: '上传中', done: '上传成功', error: '上传失败' }[transfer.status]}</p>}
    {transfer?.status === 'error' && <div className="inline-error" role="alert">{transfer.error}<button className="secondary" onClick={() => void run(() => window.workbench.call('transfer.retry', { id: transfer.id }))}>重试上传</button></div>}
    {transfer?.status === 'done' && <button className="secondary" onClick={() => viewShared(transfer.binding.project.id, transfer.target)}>查看上传结果</button>}
  </div>;
}
