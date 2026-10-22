import { isPersonalBinding } from '../shared/personal-workspace';
import { destinationLabel as projectDestinationLabel } from '../shared/submission';
import { canonicalCategory } from '../shared/result-model';
import { PreparationReview, type PreparationReviewHandle } from './preparation-review';
import { resultLabelTitle } from '../shared/result-labels';
import React, { useEffect, useState, useRef } from 'react';
import { Check, LoaderCircle, ArrowLeft, Square, Trash2 } from 'lucide-react';
import ReactMarkdown from './math-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentSession, Draft, Transfer, Project } from '../shared/types';
import { contributionCategoryInfo, materialCategories, titleSubject, type ContributionCategory } from '../shared/content';
import { useAutosave } from './autosave';
import { DraftAttachments, draftLevelArtifact } from './attachments';
const api = window.workbench;
export { contributionStatus as draftStatus } from '../shared/contribution-status';
import { contributionStatus as draftStatus } from '../shared/contribution-status';
import { preparationErrorMessage } from '../shared/preparation-error';
import { preparationCheckpoint } from '../shared/preparation-progress';
import { isEmptyPreparation } from '../shared/preparation-review';
import { PreparationOptionsModal } from './preparation-options';
import { EmptyPreparationReview } from './preparation-empty';
import { DraftDeleteDialog } from './draft-delete';
import { RequestCard, isQuestionRequest } from './request-card';
import { CliConnectionNotice } from './cli-connection-notice';
export function DraftEditor({ draft, projects = [], session, sourceTitle, sourceSession, transfers, run, notice, close, reorganized, returnToList = false, viewShared, viewConclusion }: { draft: Draft; projects?: Project[]; session?: AgentSession; sourceTitle?: string; sourceSession?: AgentSession; transfers: Transfer[]; run: <T>(fn: () => Promise<T>) => Promise<T | undefined>; notice: (s: string) => void; close: () => void; reorganized: (draft: Draft) => void; returnToList?: boolean; viewShared: (projectId: string, path: string) => void; viewConclusion: (projectId: string, id: string) => void }) {
  const uploadLabel = draft.binding ? `提交到 ${projectDestinationLabel(draft.binding.project, projects)}` : '提交到团队';
  const reviewRef = useRef<PreparationReviewHandle>(null);
  const [busy, setBusy] = useState(false), [submitted, setSubmitted] = useState(false), [expanded, setExpanded] = useState(false);
  const [editingMerge, setEditingMerge] = useState(false);
  const [confirmDuplicateTodos, setConfirmDuplicateTodos] = useState(false);
  const needsTodoConfirmation = (draft.mergeSources?.length || 0) > 1 && canonicalCategory(draft.resultCategory) === 'todo';
  const mergeBlocked = needsTodoConfirmation && !confirmDuplicateTodos;
  useEffect(() => setConfirmDuplicateTodos(false), [draft.id, draft.generationFinishedAt]);
  const [replaceIds, setReplaceIds] = useState<string[]>(draft.mergeReplacementIds || []);
  const [leaving, setLeaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [choosingScope, setChoosingScope] = useState(false);
  const [showRepo, setShowRepo] = useState(!!draft.repoUrlOverride);
  const [renaming, setRenaming] = useState<{ artifactId?: string; title: string }>();
  const [now, setNow] = useState(Date.now());
  const generating = draft.generation === 'running', ready = draft.generation === 'ready', isMerge = !!draft.mergeSources?.length, isLocalMerge = !!draft.conclusionMergeProjectId;
  const categories = draft.resultRules?.categories || draft.requestedCategories || materialCategories;
  const artifacts = draft.artifacts || [], selectedArtifacts = artifacts.filter(item => item.selected);
  const selectedIds = artifacts.length ? selectedArtifacts.map(item => item.id) : draft.body.trim() ? [draft.id] : [];
  const unsavedIds = selectedIds.filter(id => !draft.personalSavedIds?.includes(id));
  const empty = isEmptyPreparation(draft);
  const attachmentEntries = artifacts.length ? selectedArtifacts.flatMap(item => item.attachments || []) : draft.attachments || [];
  const attachmentCount = new Set(attachmentEntries.filter(entry => entry.selected).map(entry => draft.files.find(file => file.id === entry.fileId)?.sha256).filter(Boolean)).size;
  const transfer = transfers.find(item => item.id === draft.submitted);
  const batchStatus = draft.restored && draft.submitted ? '已恢复，共享状态待核对' : transfers.some(item => item.status === 'error') ? '上传未完成' : transfers.length && transfers.every(item => item.status === 'done') ? '上传成功' : transfers.some(item => item.status === 'running') ? '上传中' : '等待上传';
  const uploaded = !!draft.submitted || artifacts.some(item => !!item.submitted), locked = busy || leaving || submitted || uploaded;
  const editor = useAutosave('draft-supplement:' + draft.id, { supplement: draft.supplement || '', repoUrlOverride: draft.repoUrlOverride || '' }, value => api.call('draft.supplement', { id: draft.id, ...value }));
  const mergeEditor = useAutosave('content-merge:' + draft.id + ':' + (draft.generationFinishedAt || 'pending') + ':' + (draft.resultCategory || ''), { title: resultLabelTitle(draft.title), body: draft.body }, value => api.call('content.merge.save', { id: draft.id, ...value }));
  const changeCategory = (category: ContributionCategory, artifactId?: string) => void run(async () => {
    setBusy(true); try { if (isMerge) await mergeEditor.flush(); await api.call('draft.category', { id: draft.id, category, artifactId }); } finally { setBusy(false); }
  });
  const value = editor.value, repoUrl = value.repoUrlOverride.trim() || draft.repoUrl || '';
  const change = (patch: Partial<typeof value>) => editor.change({ ...value, ...patch });
  const back = () => void run(async () => {
    setLeaving(true);
    try {
      await reviewRef.current?.flush(); await (isMerge ? mergeEditor.flush() : editor.flush());
      close();
    } finally { setLeaving(false); }
  });
  const stop = () => void run(async () => {
    setLeaving(true);
    try {
      await api.call('draft.cancel', { id: draft.id });
      await reviewRef.current?.flush(); await editor.flush();
      notice('已停止整理，现有内容已保留');
      close();
    } finally { setLeaving(false); }
  });
  useEffect(() => { setNow(Date.now()); if (!generating) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [generating, draft.generationStartedAt]);
  useEffect(() => { if (ready) setShowRepo(!!draft.repoUrlOverride); }, [draft.repoUrl, ready]);
  useEffect(() => { setReplaceIds(draft.mergeReplacementIds || []); }, [draft.id]);
  const elapsed = Math.max(0, Math.floor((now - Date.parse(draft.generationStartedAt || draft.createdAt)) / 1000));
  const chooseScope = () => setChoosingScope(true);
  const backLabel = returnToList ? '返回成果整理' : isLocalMerge ? '返回个人成果库' : isMerge ? '返回团队成果库' : sourceTitle ? `返回“${sourceTitle}”` : '返回原会话';
  const selectedDestination = draft.destinations?.find(item => item.path === draft.target);
  const destinationLabel = generating ? '识别中…' : ready && draft.target ? selectedDestination?.id === 'default' ? '我的成果（自动选择）' : `${selectedDestination?.description || '项目成果'}（自动选择）` : '尚未确定';
  const visibleBody = draft.body.replace(/^#\s+(.+)\r?\n+/u, (full, heading) => heading.trim() === draft.title.trim() ? '' : full);
  const status = draft.mergeCompletedAt ? isLocalMerge ? draft.mergeResultPath ? '处理结果已提交团队' : '处理结果已保存到个人成果库' : '语义合并已提交团队' : generating ? session?.approvals.length ? session.approvals.some(isQuestionRequest) ? '有问题需要你回答' : '需要你确认一项操作' : isLocalMerge ? '正在按要求处理…' : isMerge ? '正在进行语义融合…' : '正在整理…' : ready ? empty ? draft.emptyResult?.confirmedAt ? '已确认本次无需保留' : '本次未生成新成果，请核对原因' : isLocalMerge ? '处理草稿已生成，可保存个人或提交团队' : isMerge ? draft.personalSavedIds?.includes(draft.id) ? '已保存个人成果，可继续提交团队' : '融合草稿已生成，可保存个人或提交团队' : draft.personalSavedIds?.length ? '已保存个人成果，可继续提交团队' : '整理草稿已生成，请选择保存位置' : draft.generation === 'error' ? isLocalMerge ? '处理失败，可重试' : isMerge ? '语义融合失败，可重试' : '整理失败，可重试' : '已停止，可重新整理';
  return <div className="draft-editor">
    <div className="draft-editor-heading"><button className="text-button draft-back" title={generating ? '返回不会停止整理' : undefined} disabled={leaving} onClick={back}><ArrowLeft size={15}/><span>{leaving ? '正在返回…' : backLabel}</span></button><span className="spacer"/><button className="secondary compact" disabled={leaving} onClick={back}>关闭</button>{generating && <><span className="muted small">返回后仍会继续整理</span><button className="secondary compact" disabled={leaving} onClick={stop}><Square size={12}/>停止整理</button></>}{<button className="secondary compact danger" disabled={busy || leaving} onClick={() => setConfirmingDelete(true)}><Trash2 size={13}/>删除整理记录</button>}</div>
    {draft.restored && <p className="muted small">已恢复整理结果；原 Session 留在原电脑，不会自动继续运行。</p>}
    <section className="preparation-summary" aria-label="成果整理进度">
      <div className="preparation-status" aria-live="polite" aria-label="整理状态">{generating && <LoaderCircle size={17} className="spin"/>}<strong>{isLocalMerge && draft.mergeResultPath ? batchStatus : draft.mergeCompletedAt ? status : draft.submitted ? batchStatus : status}</strong>{generating && <span className="muted small" aria-label="整理已用时间">{elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`}</span>}{!draft.restored && sourceSession && !generating && !isMerge && ready && <button className="secondary compact" disabled={busy || leaving} onClick={chooseScope}>再次整理</button>}{draft.organizationEdited && !isMerge && <span className="muted small">旧版项目概览；可再次整理为分类成果</span>}{!draft.restored && !locked && !generating && !draft.submitted && !draft.mergeCompletedAt && (isMerge || !ready) && <button className="text-button" onClick={() => void run(() => { notice(''); return api.call('draft.retry', { id: draft.id }); })}>{draft.generation === 'error' ? '重试' : isLocalMerge ? '重新处理' : isMerge ? '重新进行语义融合' : '重新整理'}</button>}</div>
      <p className="muted small preparation-source">{isMerge ? `${isLocalMerge ? '合并' : '融合'} ${draft.mergeSources!.length} 条${isLocalMerge ? '成果' : '团队成果'}；使用“${sourceTitle || '工作会话'}”完成整理，不会写入原对话` : <>来自“{sourceTitle || '原工作会话'}”{draft.snapshot ? `，${draft.preparationScope === 'incremental' ? `增量整理了 ${draft.snapshot.messageCount} 条新增或续写消息` : '整理对话'}，采用截至 ${new Date(draft.snapshot.capturedAt).toLocaleString()} 的内容` : ''}</>}</p>
      {draft.generationError && <div className="inline-error" role="alert">{preparationErrorMessage(draft.generationError)}</div>}
      <CliConnectionNotice value={session?.cliConnection} provider={session?.provider}/>
      {generating && session?.approvals.map(a => <RequestCard key={a.id} request={a} onAnswer={(option, answers) => void run(() => api.call('session.answer', { id: session.id, requestId: a.id, option, answers }))}/>)}
    </section>

    {empty && <EmptyPreparationReview draft={draft} busy={busy || leaving} viewConclusion={viewConclusion} confirm={() => void run(async () => { setBusy(true); try { await api.call('draft.confirmEmpty', { id: draft.id }); notice('已确认本次无需保留，整理结果已记录'); } finally { setBusy(false); } })}/>}
    {isMerge && draft.body && <section className="semantic-merge-review" aria-label={isLocalMerge ? '预处理结果' : '语义合并结果'}><div className="merge-source-list"><b>{isLocalMerge ? '本次处理的成果' : '本次融合来源'}</b>{draft.mergeSources!.map(source => <span key={source.id}>{resultLabelTitle(source.title)} · {source.author} · v{source.revision}</span>)}</div>{isLocalMerge && draft.conclusionMergeInstruction && <div className="callout"><div><b>你的处理要求</b><small>{draft.conclusionMergeInstruction}</small></div></div>}{draft.resultCategory && <label className="field">类别<select aria-label="合并成果类别" disabled title="合并结果保持来源分类" value={draft.resultCategory} onChange={event => changeCategory(event.target.value as ContributionCategory)}>{categories.map(category => <option key={category} value={category}>{contributionCategoryInfo[category].label}</option>)}</select></label>}<label className="field">{isLocalMerge ? '结果标题' : '合并后标题'}<input aria-label={isLocalMerge ? '结果标题' : '合并后标题'} disabled={locked || !!draft.mergeReplacementIds} value={mergeEditor.value.title} onChange={e => mergeEditor.change({ ...mergeEditor.value, title: e.target.value })}/></label><div className="result-reading-toolbar"><b>{isLocalMerge ? '预处理结果内容' : '融合后的项目文档'}</b>{!locked && !draft.mergeReplacementIds && <button className="secondary compact" onClick={() => setEditingMerge(!editingMerge)}>{editingMerge ? '完成编辑，查看排版' : '编辑内容'}</button>}</div>{editingMerge && !locked && !draft.mergeReplacementIds ? <label className="field">修改内容<textarea aria-label={isLocalMerge ? '预处理结果内容' : '融合后的项目文档'} rows={16} value={mergeEditor.value.body} onChange={e => mergeEditor.change({ ...mergeEditor.value, body: e.target.value })}/></label> : <div className="markdown result-reading" aria-label={isLocalMerge ? '预处理结果内容' : '融合后的项目文档'}><ReactMarkdown remarkPlugins={[remarkGfm]}>{mergeEditor.value.body}</ReactMarkdown></div>}{!locked && mergeEditor.status !== '已保存' && <div className="row small muted" role="status"><span>{mergeEditor.status}</span>{mergeEditor.status.startsWith('保存失败') && <button className="text-button" onClick={mergeEditor.retry}>重试保存</button>}</div>}{ready && <DraftAttachments draft={draft} artifact={draftLevelArtifact(draft)} locked={locked || !!draft.mergeReplacementIds} run={run}/>}{draft.resultSourceDetails && <details className="content-provenance"><summary>来源详情</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{draft.resultSourceDetails}</pre></details>}<details className="merge-safety"><summary>{isLocalMerge ? '保存说明' : '合并保存规则'}</summary><p>{isLocalMerge ? '保存个人成果时会核对来源版本；保存成功后，仅把勾选的个人来源移入历史。' : '保存个人副本不会改变团队来源；提交团队时会核对来源版本，提交成功后仅把勾选的来源移入历史。'}</p></details></section>}
    {isMerge && uploaded && <div className="row"><span>{resultLabelTitle(draft.titleAlias || draft.title)}{draft.titleAlias ? '（本地名称）' : ''}</span><button className="text-button" disabled={busy || leaving} onClick={() => setRenaming({ title: draft.titleAlias || titleSubject(draft.title) })}>修改名称</button></div>}
    {needsTodoConfirmation && ready && !uploaded && <label className="check-row"><input type="checkbox" checked={confirmDuplicateTodos} disabled={locked} onChange={event => setConfirmDuplicateTodos(event.target.checked)}/>这些待办是同一事项的重复记录，合并后不会遗漏独立事项</label>}
    {isMerge && ready && !uploaded && <fieldset className="merge-replacement-choice" disabled={locked || !!draft.mergeReplacementIds}>
      <legend>将哪些来源移入历史（可选）</legend>
      <p className="muted small">{draft.mergeReplacementIds ? '保存请求已发出；重试时沿用本次选择。' : `${isLocalMerge ? '保存个人成果时' : '提交团队时'}，勾选的来源会移入历史。新成果仍记录全部来源；想继续使用某条来源时，请勿勾选。`}</p>
      {draft.mergeSources!.map(source => <label className="check-row" key={source.id}>
        <input type="checkbox" checked={replaceIds.includes(source.id)} onChange={event => setReplaceIds(current => event.target.checked ? [...current, source.id] : current.filter(id => id !== source.id))}/>
        <span>{resultLabelTitle(source.title)} · v{source.revision}</span>
      </label>)}
    </fieldset>}
    {!isMerge && artifacts.length > 0 ? <PreparationReview ref={reviewRef} draft={draft} locked={locked || !ready} run={run} transfers={transfers} viewShared={viewShared}/> : !isMerge && draft.body && <section className="contribution-result" aria-label="整理结果">
      {!ready && !draft.submitted && <p className="muted small">以下是上次整理的内容</p>}
      <div className="row"><h2>{resultLabelTitle(draft.titleAlias || draft.title)}</h2><button className="text-button" disabled={!ready || busy || leaving} onClick={() => setRenaming({ title: draft.titleAlias || titleSubject(draft.title) })}>修改名称</button></div>
      {repoUrl && <p className="repository-reference">相关仓库：<a href={repoUrl} onClick={e => { e.preventDefault(); void run(() => api.call('open.link', repoUrl)); }}>{repoUrl}</a></p>}
      <div className={'generated-preview markdown ' + (!expanded && visibleBody.length > 800 ? 'collapsed' : '')} aria-label="整理说明"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:/.test(href)) void run(() => api.call('open.link', href)); }}>{children}</a>, img: ({ alt }) => <span>[图片：{alt || '附件'}]</span> }}>{visibleBody}</ReactMarkdown></div>
      {visibleBody.length > 800 && <button className="text-button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起详情' : '展开详情'}</button>}
      {(ready || !!draft.attachments?.length) && <DraftAttachments draft={draft} artifact={draftLevelArtifact(draft)} locked={locked || !ready} run={run}/>}
    </section>}
    {!empty && !isMerge && (ready || draft.body) && !locked && <details className="repository-correction" open={showRepo} onToggle={e => setShowRepo(e.currentTarget.open)}><summary>仓库与代码版本（可选）</summary><label className="field">相关 GitHub 仓库<input aria-label="GitHub 仓库链接" placeholder={draft.repoUrl || 'https://github.com/owner/repository'} value={value.repoUrlOverride} onChange={e => change({ repoUrlOverride: e.target.value })}/></label>{draft.git && <><label className="check-row"><input type="checkbox" aria-label="记录当前代码版本" checked={!!draft.includeGit} onChange={e => void run(() => api.call('draft.git', { id: draft.id, include: e.target.checked }))}/>记录当前代码版本（不会上传代码）</label><p className="muted small git-version">{draft.git.branch} · {draft.git.commit?.slice(0, 12) || '无提交'} · {draft.git.dirty ? '有未提交改动' : '无未提交改动'}</p></>}</details>}
    {!isMerge && !artifacts.length && transfer?.status === 'error' && <div className="inline-error" role="alert">上传失败：{transfer.error}<div className="row"><button className="secondary" onClick={() => void run(() => api.call('transfer.retry', { id: transfer.id }))}>重试原上传</button><button className="secondary" onClick={() => void run(async () => { await api.call('draft.revise', { id: draft.id }); notice('修订草稿已创建，可在上方草稿列表选择并补充后上传'); })}>生成修订草稿</button></div></div>}
    {!empty && !isMerge && <label className="field contribution-supplement">补充说明（可选）<textarea rows={2} aria-label="补充说明（可选）" placeholder="只有需要补充或更正时填写" disabled={locked} value={value.supplement} onChange={e => change({ supplement: e.target.value })}/></label>}
    {!empty && !isMerge && !locked && editor.status !== '已保存' && <div className="row small muted" role="status"><span>{editor.status}</span>{editor.status.startsWith('保存失败') && <button className="text-button" onClick={editor.retry}>重试保存</button>}</div>}
    {!isPersonalBinding(draft.binding) && !empty && !isMerge && !artifacts.length && <div className="upload-destination" aria-label="上传位置" title={ready ? draft.target : undefined}><span>上传位置</span>{draft.binding ? <b>{draft.binding.project.name} / {destinationLabel}</b> : <b>未绑定项目，无法上传</b>}</div>}
    {empty ? <div className="draft-actions"><button className="secondary back-action" disabled={busy || leaving} onClick={back}>{backLabel}</button></div> : isMerge ? (<>
      <div className="draft-actions">
        <button className="secondary back-action" disabled={leaving} onClick={back}>{backLabel}</button>
        <span className="spacer"/>
        {!isLocalMerge && ready && <button className="primary" disabled={busy || leaving || mergeBlocked || !!draft.personalSavedIds?.includes(draft.id)} onClick={() => void run(async () => {
          setBusy(true);
          try {
            if (!draft.mergeCompletedAt) await mergeEditor.flush();
            const result = await api.call<{ id: string }>('content.merge.personal', { id: draft.id, confirmDuplicateTodos });
            notice('融合结果已保存到个人成果库；团队来源保持原状');
            viewConclusion(draft.mergeProjectId!, result.id);
          } finally { setBusy(false); }
        })}><Check size={15}/>{draft.personalSavedIds?.includes(draft.id) ? '已保存到个人成果库' : '保存到个人成果库'}</button>}
        {isLocalMerge && ready && !draft.mergeCompletedAt && <button className="primary" disabled={busy || leaving || mergeBlocked || !mergeEditor.value.title.trim() || !mergeEditor.value.body.trim()} onClick={() => void run(async () => {
          setBusy(true);
          try {
            await mergeEditor.flush();
            await api.call('conclusion.merge.submit', { id: draft.id, confirmDuplicateTodos });
            setSubmitted(true);
            notice('已开始提交团队成果；个人来源保持原状，上传完成后项目组成员可见');
          } finally { setBusy(false); }
        })}><Check size={15}/>{busy ? '正在提交…' : uploadLabel}</button>}
        {draft.mergeCompletedAt && draft.mergeResultId && isLocalMerge ? <button className="primary" onClick={() => viewConclusion(draft.conclusionMergeProjectId!, draft.mergeResultId!)}>查看个人成果</button> :
          draft.mergeCompletedAt && isLocalMerge && draft.mergeResultPath && transfer?.status === 'done' ? <button className="primary" onClick={() => viewShared(draft.binding!.project.id, draft.mergeResultPath!)}>查看团队成果</button> :
          draft.mergeCompletedAt && draft.mergeProjectId && draft.mergeResultPath ? <button className="primary" onClick={() => viewShared(draft.mergeProjectId!, draft.mergeResultPath!)}>查看团队成果</button> :
          draft.mergeCompletedAt ? null : <button className="primary" disabled={busy || leaving || mergeBlocked || !ready || !mergeEditor.value.title.trim() || !mergeEditor.value.body.trim()} onClick={() => void run(async () => {
            setBusy(true);
            try {
              await mergeEditor.flush();
              if (isLocalMerge) {
                const result = await api.call<{ id: string }>('conclusion.merge.commit', { id: draft.id, replaceIds, confirmDuplicateTodos });
                setSubmitted(true);
                notice(replaceIds.length ? `已保存到个人成果库，${replaceIds.length} 条个人来源移入历史` : '已保存到个人成果库，来源仍可继续使用');
                viewConclusion(draft.conclusionMergeProjectId!, result.id);
              } else {
                const result = await api.call<{ path: string }>('content.merge.commit', { id: draft.id, replaceIds, confirmDuplicateTodos });
                setSubmitted(true);
                notice(replaceIds.length ? `已提交为团队成果，${replaceIds.length} 条团队来源移入历史` : '已提交为团队成果，来源仍可继续使用');
                viewShared(draft.mergeProjectId!, result.path);
              }
            } finally { setBusy(false); }
          })}><Check size={15}/>{busy ? '正在保存…' : isLocalMerge ? '保存到个人成果库' : uploadLabel}</button>}
      </div>
      {isLocalMerge && draft.mergeResultPath && transfer?.status === 'error' && <div className="inline-error" role="alert">团队成果上传失败：{transfer.error}<button className="secondary compact" onClick={() => void run(() => api.call('transfer.retry', { id: transfer.id }))}>重试上传</button></div>}
      </>
    ) : (
      <div className="draft-actions">
        <button className="secondary back-action" disabled={leaving} onClick={back}>{backLabel}</button>
        <span className="spacer"/>
        {ready && !!draft.binding && <button className="primary" disabled={busy || leaving || !unsavedIds.length} onClick={() => void run(async () => {
          setBusy(true);
          try {
            if (!draft.submitted) await reviewRef.current?.flush(); await editor.flush();
            await api.call('draft.personal.save', { id: draft.id, artifactIds: selectedIds });
            notice(`已将 ${unsavedIds.length} 项成果保存到个人成果库；团队成员暂不可见`);
          } finally { setBusy(false); }
        })}><Check size={15}/>{unsavedIds.length ? `保存到个人成果库${unsavedIds.length > 1 ? `（${unsavedIds.length} 项）` : ''}` : '已保存到个人成果库'}</button>}
        {isPersonalBinding(draft.binding) ? <span className="muted small">保存在本机；迁入团队项目后可提交团队。</span> : !draft.submitted && !submitted ? <button className="primary" disabled={busy || leaving || !ready || !selectedIds.length || !draft.binding} onClick={() => void run(async () => {
          setBusy(true);
          try {
            await reviewRef.current?.flush(); await editor.flush();
            await api.call('draft.submit', { id: draft.id });
            setSubmitted(true);
            notice(`已开始提交 ${selectedIds.length} 项成果到团队`);
          } finally { setBusy(false); }
        })}><Check size={15}/>{busy ? '正在提交…' : `${uploadLabel}${selectedIds.length > 1 ? `（${selectedIds.length} 项）` : ''}`}</button> :
          <span className="green row"><Check size={17}/>{transfers.some(item => item.status === 'error') ? '部分上传失败，可在对应成果中重试' : transfers.length && transfers.every(item => item.status === 'done') ? '团队提交已完成，可查看团队成果' : '正在提交团队成果'}</span>}
        {!artifacts.length && transfer?.status === 'done' && <button className="primary compact" onClick={() => viewShared(transfer.binding.project.id, transfer.target)}>查看团队成果</button>}
      </div>
    )}
    {renaming && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="rename-result-title"><header><h2 id="rename-result-title">修改成果名称</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={() => setRenaming(undefined)}>×</button></header><div className="modal-body"><label className="field">成果名称<input autoFocus aria-label="成果名称" maxLength={120} value={renaming.title} onChange={e => setRenaming({ ...renaming, title: e.target.value })}/></label><p className="muted small">{uploaded ? '只修改本机显示名称，已上传的成果包和共享区标题保持不变。' : draft.personalSavedIds?.includes(renaming.artifactId || draft.id) ? '只修改整理草稿；已保存的个人成果请在个人成果库单独改名。' : '修改后保存个人成果或提交团队时将使用新名称。'}</p></div><footer><button className="secondary" disabled={busy} onClick={() => setRenaming(undefined)}>取消</button><button className="primary" disabled={busy || !renaming.title.trim()} onClick={() => void run(async () => { setBusy(true); try { await api.call('draft.renameResult', { id: draft.id, artifactId: renaming.artifactId, title: renaming.title }); setRenaming(undefined); notice(uploaded ? '本地名称已保存，远端未修改' : '成果名称已保存'); } finally { setBusy(false); } })}>保存名称</button></footer></section></div>}
    {confirmingDelete && <DraftDeleteDialog draft={draft} close={() => setConfirmingDelete(false)} remove={async () => { if (!uploaded && !draft.mergeCompletedAt) await reviewRef.current?.flush(); await (isMerge ? mergeEditor.flush() : editor.flush()); await api.call('draft.delete', { id: draft.id }); notice('整理记录已删除，已保存成果和增量进度保留'); close(); }}/>}
    {choosingScope && sourceSession && <PreparationOptionsModal initialDirections={draft.preparationDirections} session={sourceSession} baseline={preparationCheckpoint(sourceSession, [draft])} again close={() => setChoosingScope(false)} started={async (scope, categories, directions) => { if (!uploaded && !empty) await reviewRef.current?.flush(); await editor.flush(); const next = await api.call<Draft>('draft.reorganize', { id: draft.id, scope, categories, directions }); notice(`已创建${scope === 'incremental' ? '增量' : '全量'}整理任务，原任务已保留`); reorganized(next); }}/>}
  </div>;
}
