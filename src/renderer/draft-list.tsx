import { resultLabelTitle } from '../shared/result-labels';
import React, { useState } from 'react';
import { ChevronRight, FileArchive, Trash2 } from 'lucide-react';
import type { AgentSession, Draft, Transfer } from '../shared/types';
import { isProjectOrganizationDraft } from '../shared/project-organization';
import { OrganizationTags } from './organization-tags';
import { contributionStatus } from '../shared/contribution-status';
import { draftDeleteBatchLimit, type DraftDeleteResult } from '../shared/draft-delete';
import { DraftBulkDeleteDialog } from './draft-delete';

export function draftIsPreserved(draft: Draft) {
  return !!draft.mergeCompletedAt || !!draft.submitted || !!draft.artifacts?.some(item => item.submitted) || !!draft.personalSavedIds?.length;
}

function relatedTransfers(draft: Draft, transfers: Transfer[]) {
  const ids = new Set([draft.submitted, ...(draft.artifacts || []).map(item => item.submitted)].filter((id): id is string => !!id));
  return transfers.filter(item => ids.has(item.id));
}

function taskStatus(draft: Draft, transfers: Transfer[]) {
  if (draft.mergeCompletedAt && draft.conclusionMergeProjectId && !draft.mergeResultPath) return '已保存到个人成果库';
  if (draft.mergeCompletedAt && !draft.conclusionMergeProjectId) return '已保存到团队成果库';
  const related = relatedTransfers(draft, transfers);
  if (draft.personalSavedIds?.length && !draft.submitted) return `已保存 ${draft.personalSavedIds.length} 项个人成果`;
  if (draftIsPreserved(draft)) {
    if (related.some(item => item.status === 'error')) return '上传未完成';
    if (related.some(item => item.status === 'running')) return '正在上传';
    if (related.some(item => item.status === 'queued')) return '等待上传';
    if (related.length && related.every(item => item.status === 'done')) return '已上传';
    return '上传状态待核对';
  }
  return contributionStatus(draft);
}

function statusTone(draft: Draft, transfers: Transfer[]) {
  const status = taskStatus(draft, transfers);
  if (/失败|未完成/.test(status)) return 'error';
  if (/正在|整理中|融合中|处理中/.test(status)) return 'running';
  if (/已上传|已保存|已确认/.test(status)) return 'done';
  return 'queued';
}

function taskKind(draft: Draft) {
  if (draft.conclusionMergeProjectId) return '合并成果';
  if (draft.mergeProjectId) return '团队成果合并';
  if (draft.preparationScope === 'incremental') return '增量整理';
  if (draft.preparationScope === 'full') return '整理对话';
  return '会话成果整理';
}

export function DraftTaskList({ drafts, sessions, transfers, open, remove, removeMany }: { drafts: Draft[]; sessions: AgentSession[]; transfers: Transfer[]; open: (draft: Draft) => void; remove?: (draft: Draft) => void; removeMany?: (ids: string[]) => Promise<DraftDeleteResult> }) {
  const [selecting, setSelecting] = useState(false), [selectedIds, setSelectedIds] = useState<string[]>([]), [pending, setPending] = useState<Draft[]>();
  const ordered = [...drafts].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const selected = ordered.filter(draft => selectedIds.includes(draft.id)), firstBatch = ordered.slice(0, draftDeleteBatchLimit);
  return <>{removeMany && <div className="draft-list-toolbar">
    <button className="secondary" onClick={() => { setSelecting(!selecting); setSelectedIds([]); }}>{selecting ? '取消多选' : '批量删除记录'}</button>
    {selecting && <><label className="check-row"><input type="checkbox" aria-label="全选整理记录" checked={!!firstBatch.length && firstBatch.every(draft => selectedIds.includes(draft.id))} onChange={event => setSelectedIds(event.target.checked ? firstBatch.map(draft => draft.id) : [])}/><span>{ordered.length > draftDeleteBatchLimit ? `选择前 ${draftDeleteBatchLimit} 条` : '全选当前列表'}</span></label><span className="muted small">已选 {selected.length} 条</span><button className="primary danger" disabled={!selected.length} onClick={() => setPending(structuredClone(selected))}>删除选中的 {selected.length} 条记录</button></>}
  </div>}<section className="draft-task-list" aria-label="成果整理任务列表">
    {ordered.map(draft => {
      const source = sessions.find(session => session.id === draft.sessionId), status = taskStatus(draft, transfers), preserved = draftIsPreserved(draft);
      const projectName = draft.binding?.project.name || source?.binding?.project.name || '本机项目';
      const profile = isProjectOrganizationDraft(draft), fields = profile ? draft.artifacts?.[0]?.fields : undefined;
      const resultCount = draft.artifacts?.length || draft.mergeSources?.length || (draft.body ? 1 : 0);
      const label = profile ? projectName : resultLabelTitle(draft.titleAlias || draft.title);
      return <article className={'draft-task-card' + (selecting ? ' selecting' : '') + (selecting && selectedIds.includes(draft.id) ? ' selected' : '')} data-draft-id={draft.id} key={draft.id}>
        {selecting && <label className="draft-task-selection"><input type="checkbox" aria-label={`选择整理记录：${label}`} checked={selectedIds.includes(draft.id)} disabled={!selectedIds.includes(draft.id) && selected.length >= draftDeleteBatchLimit} onChange={event => setSelectedIds(ids => event.target.checked ? [...new Set([...ids, draft.id])] : ids.filter(id => id !== draft.id))}/></label>}
        <button className="draft-task-open" aria-label={`查看整理任务：${label}`} onClick={() => open(draft)}>
          <span className="draft-task-icon"><FileArchive size={21}/></span>
          <span className="draft-task-body">
            <span className="draft-task-badges"><span className="content-category-badge">{profile ? '项目整理' : taskKind(draft)}</span><span className={'badge ' + statusTone(draft, transfers)}>{status}</span>{preserved && <span className="draft-preserved">成果已单独保存</span>}</span>
            <b>{label}</b>
            {profile && fields?.sentence && <span className="draft-task-sentence">{fields.sentence}</span>}
            {profile && <OrganizationTags technologies={fields?.technologies || ''} achievements={fields?.achievements || ''} />}
            <span className="draft-task-meta"><span>来源：{source?.title || '原会话记录'}</span>{!profile && <span>项目：{projectName}</span>}{draft.preparationScope === 'incremental' && draft.snapshot && <span>新增 {draft.snapshot.messageCount} 条消息</span>}{!profile && resultCount > 0 && <span>{resultCount} 项内容</span>}</span>
            <small>创建于 {new Date(draft.createdAt).toLocaleString()}{draft.generationFinishedAt ? ` · 最近完成 ${new Date(draft.generationFinishedAt).toLocaleString()}` : ''}</small>
          </span>
          <ChevronRight size={18}/>
        </button>
        {remove && !selecting && <button className="text-button danger draft-task-delete" aria-label={`删除整理记录：${label}`} onClick={() => remove(draft)}><Trash2 size={13}/>删除记录</button>}
      </article>;
    })}
  </section>{pending && removeMany && <DraftBulkDeleteDialog drafts={pending} close={() => setPending(undefined)} remove={async ids => {
    const result = await removeMany(ids); setSelectedIds(result.failures.map(item => item.id));
    if (!result.failures.length) setSelecting(false);
    return result;
  }}/>}</>;
}
