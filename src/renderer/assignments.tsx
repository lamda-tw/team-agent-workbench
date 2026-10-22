import React, { useMemo, useState } from 'react';
import ReactMarkdown from './math-markdown';
import remarkGfm from 'remark-gfm';
import { ClipboardList, Plus, RefreshCw } from 'lucide-react';
import { AssignmentLifecycle } from './assignment-lifecycle';
import { assignmentInScope, assignmentStatuses, assignmentViewItems, type AssignmentUpload, type AssignmentView, type AssignmentMember, type ProjectAssignment } from '../shared/assignments';
import type { AgentSession, Project } from '../shared/types';
import type { SharedContent } from '../shared/content';
import { contentAliasKey, projectResultTitle, resultTitle } from '../shared/content';
import { missingContentIndexMessage } from '../shared/content-index';
import { rankConclusions } from '../core/conclusion-matcher';

const api = window.workbench;
const fileSize = (size: number) => size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`;
export function AssignmentsPanel({ project, admin, username, items, loading, loadError, refresh, start, sessions, aliases }: {
  project: Project; admin: boolean; username: string; items: ProjectAssignment[]; loading: boolean; loadError: string;
  refresh: () => Promise<void>; start: (task: ProjectAssignment) => void; sessions: AgentSession[]; aliases: Record<string, string>;
}) {
  const [view, setView] = useState<AssignmentView>('mine');
  const [selected, setSelected] = useState(''), [scope, setScope] = useState<'active' | 'all' | 'deleted'>('active');
  const [creating, setCreating] = useState(false), [requestId, setRequestId] = useState(''), [title, setTitle] = useState(''), [description, setDescription] = useState(''), [acceptance, setAcceptance] = useState(''), [assignee, setAssignee] = useState('');
  const [members, setMembers] = useState<AssignmentMember[]>([]), [content, setContent] = useState<SharedContent[]>([]), [referenceIds, setReferenceIds] = useState<string[]>([]), [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [catalogMissing, setCatalogMissing] = useState(false);
  const [uploads, setUploads] = useState<AssignmentUpload[]>([]), [uploadIds, setUploadIds] = useState<string[]>([]), [referenceFiles, setReferenceFiles] = useState<Record<string, string[]>>({});
  const selectedFiles = [...uploads.filter(file => uploadIds.includes(file.id)), ...content.filter(item => referenceIds.includes(item.id)).flatMap(item => [...(item.kind === 'file' ? [{ name: item.path.split('/').at(-1) || item.title, sha256: item.sha256 }] : []), ...(item.attachments || []).filter(file => !referenceFiles[item.id] || referenceFiles[item.id].includes(file.sha256))])];
  const fileCount = new Set(selectedFiles.map(file => JSON.stringify([file.name, file.sha256]))).size;
  const pickFiles = async () => {
    setBusy(true); setError(''); try { const files = await api.call<AssignmentUpload[]>('assignment.files.pick', { projectId: project.id, taskId: requestId }); setUploads(files); setUploadIds(current => [...new Set([...current, ...files.filter(file => !uploads.some(previous => previous.id === file.id)).map(file => file.id)])]); } catch (error: any) { setError(error.message); } finally { setBusy(false); }
  };
  const download = async (taskId: string, fileId: string) => { setBusy(true); setError(''); try { await api.call('assignment.file.download', { projectId: project.id, taskId, fileId }); } catch (error: any) { setError(error.message); } finally { setBusy(false); } };
  const displayTitle = (item: SharedContent) => item.kind === 'file' ? resultTitle('共享文件', aliases[contentAliasKey(project.id, item.id)] || item.title) : projectResultTitle(item, aliases[contentAliasKey(project.id, item.id)]);
  const ranked = useMemo(() => rankConclusions(content.map(item => ({ id: item.id, projectId: project.id, title: item.title, titleAlias: aliases[contentAliasKey(project.id, item.id)], content: item.description, sources: [], version: item.revision, updatedAt: item.updatedAt })), `${title}\n${description}`, 8), [content, title, description, project.id, aliases]);
  const recommended = new Map(ranked.map((item, index) => [item.conclusion.id, { index, reasons: item.reasons.join('；') }]));
  const candidates = content.filter(item => `${displayTitle(item)} ${item.title} ${item.description} ${item.author}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a, b) => (recommended.get(a.id)?.index ?? 999) - (recommended.get(b.id)?.index ?? 999));
  const viewItems = assignmentViewItems(items, username, admin, view);
  const visible = viewItems.filter(task => assignmentInScope(task, scope));
  const task = visible.find(item => item.id === selected) || visible[0];
  const localSession = (value: ProjectAssignment) => sessions.find(session => session.assignment?.id === value.id && !session.closedAt);
  const loadChoices = async () => {
    const people = await api.call<AssignmentMember[]>('assignment.members', { projectId: project.id });
    let results: SharedContent[] = [], missingCatalog = false;
    try { results = await api.call<SharedContent[]>('content.list', { projectId: project.id }); }
    catch (reason: any) { if (reason?.message !== missingContentIndexMessage) throw reason; missingCatalog = true; }
    return { people, results: results.filter(item => ['contribution', 'file'].includes(item.kind)), missingCatalog };
  };
  const beginCreate = async () => {
    setBusy(true); setError('');
    try {
      const { people, results, missingCatalog } = await loadChoices();
      setMembers(people); setContent(results); setCatalogMissing(missingCatalog); setRequestId(crypto.randomUUID()); setTitle(''); setDescription(''); setAcceptance(''); setAssignee(''); setReferenceIds([]); setSearch(''); setUploads([]); setUploadIds([]); setReferenceFiles({}); setCreating(true);
    } catch (error: any) { setError(error.message); } finally { setBusy(false); }
  };
  const reloadChoices = async () => {
    setBusy(true); setError('');
    try {
      const { people, results, missingCatalog } = await loadChoices();
      setMembers(people); setContent(results); setCatalogMissing(missingCatalog); setReferenceIds([]); setUploads([]); setUploadIds([]); setReferenceFiles({}); setRequestId(crypto.randomUUID()); if (!people.some(item => item.username === assignee)) setAssignee('');
    } catch (error: any) { setError(error.message); } finally { setBusy(false); }
  };
  const create = async () => {
    setBusy(true); setError('');
    try {
      const saved = await api.call<ProjectAssignment>('assignment.create', { projectId: project.id, task: { id: requestId, title, description, acceptance, assignee, uploadIds, references: content.filter(item => referenceIds.includes(item.id)).map(item => ({ id: item.id, revision: item.revision, attachmentHashes: referenceFiles[item.id] || item.attachments?.map(file => file.sha256) || [] })) } });
      setSelected(saved.id); setView('sent'); setScope('active'); setCreating(false); await refresh();
    } catch (error: any) { setError(error.message); } finally { setBusy(false); }
  };
  return <div className="workspace-page assignments-page">
    <div className="page-title"><div><span className="eyebrow">PROJECT TASKS</span><h1>{admin ? '项目任务' : '我的任务'} · {project.name}</h1><p className="muted small">{admin ? '把任务分配给自己或组内成员，分别查看自己的待办与派发进展。' : '查看分配给你的任务，带着任务说明和关联成果开始工作。'}</p></div><div className="row"><button className="secondary" disabled={busy || loading} onClick={() => void refresh()}><RefreshCw size={14}/>刷新任务</button>{admin && <button className="primary" disabled={busy} onClick={() => void beginCreate()}><Plus size={14}/>派发任务</button>}</div></div>
    {(loadError || error && !creating) && <div className="inline-error" role="alert">{loadError || error}</div>}
    <div className="assignment-toolbar">
      {admin ? <nav className="assignment-views" aria-label="任务归属">{([['mine', '我负责的'], ['sent', '我派发的'], ['team', '全组任务']] as const).map(([key, label]) => <button key={key} aria-pressed={view === key} onClick={() => { setView(key); setSelected(''); }}><span>{label}</span><span className="assignment-count">{assignmentViewItems(items, username, admin, key).filter(item => assignmentInScope(item, scope)).length}</span></button>)}</nav> : <span className="assignment-list-caption">分配给我的任务</span>}
      <label className="assignment-status-filter"><span>状态</span><select aria-label="任务范围" value={scope} onChange={event => { setScope(event.target.value as typeof scope); setSelected(''); }}><option value="active">待办任务（{viewItems.filter(item => assignmentInScope(item, 'active')).length}）</option><option value="all">全部状态（{viewItems.filter(item => assignmentInScope(item, 'all')).length}）</option>{admin && <option value="deleted">已删除（{viewItems.filter(item => assignmentInScope(item, 'deleted')).length}）</option>}</select></label>
    </div>
    {loading && !items.length && <p role="status">正在读取任务…</p>}
    <div className="content-library assignment-library"><div className="content-cards">{visible.map(item => <article key={item.id} className={'content-card ' + (task?.id === item.id ? 'selected' : '')}><button className="content-card-summary" onClick={() => setSelected(item.id)}><span className={'badge ' + (item.status === 'completed' ? 'done' : item.status === 'in_progress' ? 'running' : '')}>{assignmentStatuses[item.status]}</span><b>{item.title}</b><small>负责人：{item.assigneeName} · 派发人：{item.createdBy}</small><p>{item.description.slice(0, 120)}</p><small>{item.references.length} 条关联成果 · {item.files?.length || 0} 个文件 · {new Date(item.createdAt).toLocaleString()}</small></button></article>)}{!visible.length && !loading && <div className="page-empty"><ClipboardList size={36}/><h2>{scope === 'deleted' ? '暂无已删除任务' : admin && view !== 'mine' ? '当前列表暂无任务' : '暂无分配给你的任务'}</h2><p>{scope === 'deleted' ? '删除后的任务可在这里恢复；查看历史任务无需删除。' : admin ? '点击“派发任务”，可选择自己或其他组内成员。' : '组管理员派发后会显示在这里，你也可以自行新建工作会话。'}</p></div>}</div>
      <section className="content-detail assignment-detail">{task ? <><span className="content-category-badge">{assignmentStatuses[task.status]}</span><h2>{task.title}</h2><p className="muted small">负责人：{task.assigneeName}（{task.assignee}） · 派发人：{task.createdBy}</p><h3>任务目标与工作范围</h3><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{task.description}</ReactMarkdown></div><h3>验收要求</h3><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{task.acceptance || '尚未填写，可与派发人确认。'}</ReactMarkdown></div><h3>关联成果（{task.references.length}）</h3><p className="muted small">以下保留派发时的内容版本。开始工作时，会带入会话并保存到“个人成果库”。</p><div className="assignment-references">{task.references.map(reference => <details key={reference.id}><summary>{reference.kind === 'file' ? resultTitle('共享文件', reference.title) : projectResultTitle(reference)} <small>v{reference.revision} · {reference.author}</small></summary><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{reference.content}</ReactMarkdown></div></details>)}</div>{!task.references.length && <p className="muted small">派发人未附关联成果。</p>}{!!task.files?.length && <section aria-label="任务关联文件"><h3>关联文件（{task.files.length}）</h3><p className="muted small">文件保留派发时的版本，开始工作时自动加入会话。</p>{task.files.map(file => <div className="row assignment-file" key={file.id}><span><b>{file.name}</b><small>{fileSize(file.size)} · 来自：{file.source}</small></span><button className="secondary compact" disabled={busy} onClick={() => void download(task.id, file.id)}>下载附件</button></div>)}</section>}<AssignmentLifecycle key={task.id + ':' + task.revision} task={task} admin={admin} username={username} projectId={project.id} refresh={refresh} start={() => start(task)} hasSession={!!localSession(task)} download={id => download(task.id, id)}/></> : <p className="muted">选择任务查看详情。</p>}</section>
    </div>
    {creating && <div className="modal-backdrop"><section className="modal wide assignment-create-modal" role="dialog" aria-modal="true" aria-labelledby="assignment-create-title"><header><h2 id="assignment-create-title">派发任务</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={() => setCreating(false)}>×</button></header><div className="modal-body">
      {error && <div className="inline-error" role="alert">{error}</div>}
      <div className="form-grid"><label className="field">负责人<select aria-label="任务负责人" disabled={busy} value={assignee} onChange={event => setAssignee(event.target.value)}><option value="">请选择本组成员</option>{members.map(item => <option value={item.username} key={item.username}>{item.name}（{item.username}）{item.username === username ? ' · 我自己' : ''}</option>)}</select><button className="text-button" type="button" disabled={busy || !members.some(item => item.username === username)} onClick={() => setAssignee(username)}>分配给自己</button></label><label className="field">任务标题<input aria-label="任务标题" maxLength={200} value={title} onChange={event => setTitle(event.target.value)}/></label></div>
      <label className="field">任务目标与工作范围<textarea aria-label="任务目标与工作范围" rows={4} maxLength={12000} placeholder="说明需要完成什么、从哪里开始、有哪些约束。" value={description} onChange={event => setDescription(event.target.value)}/></label><label className="field">验收要求（可选）<textarea aria-label="任务验收要求" rows={2} maxLength={6000} value={acceptance} onChange={event => setAcceptance(event.target.value)} placeholder="例如：提交验证结果，说明样本覆盖及未解决问题。"/></label>
      <div className="row"><h3>关联共享成果和文件（已选 {referenceIds.length}/20）</h3><span className="spacer"/><button className="text-button" disabled={busy} onClick={() => void reloadChoices()}>刷新成员和成果</button></div>{catalogMissing && <p className="muted small">团队成果清单不存在，这次不能引用已有成果，仍可直接派发。</p>}<p className="muted small">填写任务后，会优先显示文字相关的候选成果；勾选的内容将随任务交给成员。勾选成果时会一并带上它的附件，可逐个取消。刷新会清空成果和附件选择，便于重新核对版本。</p><input aria-label="搜索任务关联成果" placeholder="搜索成果名称、内容或作者" value={search} onChange={event => setSearch(event.target.value)}/>
      <div className="assignment-choices">{candidates.map(item => <div className="assignment-choice" key={item.id}><label className="check-row"><input type="checkbox" aria-label={`关联成果：${displayTitle(item)}`} checked={referenceIds.includes(item.id)} disabled={busy || !referenceIds.includes(item.id) && referenceIds.length >= 20} onChange={event => setReferenceIds(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))}/><span><b>{displayTitle(item)}</b><small>v{item.revision} · {item.author}{recommended.has(item.id) ? ' · 与任务相关：' + recommended.get(item.id)!.reasons : ''}</small></span></label>{referenceIds.includes(item.id) && !!item.attachments?.length && <div className="assignment-reference-files">{item.attachments.map(file => <label className="check-row" key={file.name + file.sha256}><input type="checkbox" disabled={busy} aria-label={`关联文件：${file.name}`} checked={!referenceFiles[item.id] || referenceFiles[item.id].includes(file.sha256)} onChange={event => { const current = referenceFiles[item.id] || item.attachments!.map(file => file.sha256); setReferenceFiles({ ...referenceFiles, [item.id]: event.target.checked ? [...new Set([...current, file.sha256])] : current.filter(hash => hash !== file.sha256) }); }}/><span>{file.name} · {fileSize(file.size)}</span></label>)}</div>}<details><summary>{item.kind === 'file' ? '文件说明' : '阅读成果'}</summary><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.description}</ReactMarkdown></div></details></div>)}</div>{!candidates.length && <p className="muted small">暂无匹配的共享成果，可以先派发任务。</p>}
      <section aria-label="上传任务附件"><div className="row"><h3>另外附文件</h3><button className="secondary" disabled={busy} onClick={() => void pickFiles()}>选择本地文件</button></div><p className="muted small">确认派发时上传。任务文件只对负责人和本组管理员可见；相同权限下的相同内容只存一份。</p>{uploads.map(file => <label className="check-row" key={file.id}><input type="checkbox" aria-label={`上传附件：${file.name}`} disabled={busy} checked={uploadIds.includes(file.id)} onChange={event => setUploadIds(current => event.target.checked ? [...current, file.id] : current.filter(id => id !== file.id))}/><span>{file.name} · {fileSize(file.size)}</span></label>)}<p className={fileCount > 30 ? 'inline-error' : 'muted small'}>共选择 {fileCount} 个文件，单个任务最多 30 个，每个不超过 2 GB。</p></section>
    </div><footer><button className="secondary" disabled={busy} onClick={() => setCreating(false)}>取消</button><button className="primary" disabled={busy || fileCount > 30 || !assignee || !title.trim() || !description.trim()} onClick={() => void create()}>{busy ? '正在上传并派发…' : '确认派发'}</button></footer></section></div>}

  </div>;
}
