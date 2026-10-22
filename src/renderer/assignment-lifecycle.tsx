import React, { useState } from 'react';
import ReactMarkdown from './math-markdown';
import remarkGfm from 'remark-gfm';
import { assignmentEventLabels, type AssignmentStatusChange, type AssignmentUpload, type ProjectAssignment } from '../shared/assignments';
import { projectResultTitle, type SharedContent } from '../shared/content';
import { missingContentIndexMessage } from '../shared/content-index';

const labels = { pending_review: '提交验收', completed: '确认完成', in_progress: '退回继续工作', cancelled: '取消任务', deleted: '删除任务', restored: '恢复任务', purged: '彻底删除' };
type Action = keyof typeof labels;
type Props = { task: ProjectAssignment; admin: boolean; username: string; projectId: string; refresh: () => Promise<void>; start: () => void; hasSession: boolean; download: (fileId: string) => Promise<void> };

export function AssignmentLifecycle({ task, admin, username, projectId, refresh, start, hasSession, download }: Props) {
  const [action, setAction] = useState<Action>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [summary, setSummary] = useState(''), [reason, setReason] = useState(''), [confirmedTitle, setConfirmedTitle] = useState('');
  const [choices, setChoices] = useState<SharedContent[]>([]), [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [uploads, setUploads] = useState<AssignmentUpload[]>([]), [uploadIds, setUploadIds] = useState<string[]>([]), [selectionId, setSelectionId] = useState('');
  const own = task.assignee === username, terminal = ['completed', 'cancelled'].includes(task.status);
  const self = own && admin && task.createdBy === username;
  const submitting = action === 'pending_review' || action === 'completed' && task.status === 'in_progress';
  const reasonRequired = action === 'cancelled' || action === 'in_progress';
  const chosen = choices.filter(item => referenceIds.includes(item.id));
  const fileCount = new Set([...uploads.filter(file => uploadIds.includes(file.id)), ...chosen.flatMap(item => [...(item.kind === 'file' ? [{ name: item.path.split('/').at(-1), sha256: item.sha256 }] : []), ...(item.attachments || [])])].map(file => JSON.stringify([file.name, file.sha256]))).size;
  const begin = async (next: Action) => {
    setAction(next); setError(''); setSummary(''); setReason(''); setConfirmedTitle(''); setChoices([]); setReferenceIds([]); setUploads([]); setUploadIds([]); setSelectionId(crypto.randomUUID());
    if (next === 'pending_review' || next === 'completed' && task.status === 'in_progress') {
      setBusy(true);
      try { setChoices((await window.workbench.call<SharedContent[]>('content.list', { projectId })).filter(item => ['contribution', 'file'].includes(item.kind))); }
      catch (e: any) { if (e?.message === missingContentIndexMessage) setChoices([]); else setError('关联成果暂未加载：' + e.message); }
      finally { setBusy(false); }
    }
  };
  const pick = async () => {
    setBusy(true); setError('');
    try {
      const files = await window.workbench.call<AssignmentUpload[]>('assignment.files.pick', { projectId, taskId: task.id, selectionId });
      setUploadIds(current => [...new Set([...current, ...files.filter(file => !uploads.some(previous => previous.id === file.id)).map(file => file.id)])]); setUploads(files);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (!action) return; setBusy(true); setError('');
    try {
      const change: AssignmentStatusChange = { id: task.id, revision: task.revision, status: action, reason, ...(submitting ? { selectionId, submission: { summary, references: chosen.map(({ id, revision }) => ({ id, revision })), uploadIds } } : {}) };
      await window.workbench.call('assignment.status', { projectId, change });
      setAction(undefined); await refresh();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const lastEvent = task.history?.at(-1);
  return <>
    {lastEvent?.note && <p className="assignment-decision"><b>{assignmentEventLabels[lastEvent.action] || lastEvent.action}：</b>{lastEvent.note}</p>}
    {!!task.submissions?.length && <section aria-label="任务验收结果"><h3>验收结果</h3>{[...task.submissions].reverse().map((item, index) => <details key={task.submissions!.length - index} open={index === 0}>
      <summary>第 {task.submissions!.length - index} 次提交 · {item.submittedBy} · {new Date(item.submittedAt).toLocaleString()}</summary>
      <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.summary}</ReactMarkdown></div>
      {item.references.map(reference => <details key={reference.id}><summary>{reference.kind === 'file' ? '【共享文件】 ' + reference.title : projectResultTitle(reference)} · v{reference.revision}</summary><div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{reference.content}</ReactMarkdown></div></details>)}
      {item.files.map(file => <div className="row assignment-file" key={file.id}><span>{file.name}</span><button className="secondary compact" disabled={busy} onClick={() => void download(file.id)}>下载验收附件</button></div>)}
    </details>)}</section>}
    {!!task.history?.length && <details><summary>操作记录（{task.history.length}）</summary>{task.history.map((event, index) => <p key={index}>{assignmentEventLabels[event.action] || event.action} · {event.by} · {new Date(event.at).toLocaleString()}{event.note ? '：' + event.note : ''}</p>)}</details>}
    {task.deletedAt && <p className="muted small">已由 {task.deletedBy} 删除，恢复后仍为原来的结束状态。</p>}
    {!action && error && <p className="inline-error" role="alert">{error}</p>}
    <div className="row assignment-actions">
      {!task.deletedAt && <>
        {own && ['assigned', 'in_progress'].includes(task.status) && <button className="primary" disabled={busy} onClick={start}>{hasSession ? '继续工作' : '开始工作'}</button>}
        {own && task.status === 'in_progress' && <button className="secondary" disabled={busy} onClick={() => void begin(self ? 'completed' : 'pending_review')}>{self ? '确认完成' : '提交验收'}</button>}
        {admin && task.status === 'pending_review' && <><button className="primary" disabled={busy} onClick={() => void begin('completed')}>验收通过</button><button className="secondary" disabled={busy} onClick={() => void begin('in_progress')}>退回继续工作</button></>}
        {admin && !terminal && <button className="secondary danger" disabled={busy} onClick={() => void begin('cancelled')}>取消任务</button>}
        {admin && terminal && <button className="secondary danger" disabled={busy} onClick={() => void begin('deleted')}>删除任务</button>}
      </>}
      {admin && task.deletedAt && <><button className="secondary" disabled={busy} onClick={() => void begin('restored')}>恢复任务</button><button className="secondary danger" disabled={busy} onClick={() => void begin('purged')}>彻底删除</button></>}
    </div>
    {action && <div className="modal-backdrop"><section className="modal wide" role="dialog" aria-modal="true" aria-labelledby="assignment-action-title">
      <header><h2 id="assignment-action-title">{labels[action]}？</h2></header><div className="modal-body"><h3>{task.title}</h3>
        {submitting && <>
          <p className="muted small">以任务目标和验收要求为准。探索得到有依据的否定结论也可以完成；未完成的部分请明确说明。</p>
          <p>验收要求：{task.acceptance || '未单独填写，请按任务目标核对；不明确时先与派发人确认。'}</p>
          <label className="field">结果说明<textarea aria-label="任务结果说明" rows={5} maxLength={6000} value={summary} disabled={busy} onChange={e => setSummary(e.target.value)} placeholder="完成了什么、依据是什么、还有哪些限制。"/></label>
          <details><summary>关联成果或共享文件（可选，已选 {referenceIds.length}/20）</summary><div className="assignment-choices">{choices.map(item => <label className="check-row" key={item.id}><input type="checkbox" disabled={busy || !referenceIds.includes(item.id) && referenceIds.length >= 20} checked={referenceIds.includes(item.id)} onChange={e => setReferenceIds(current => e.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))}/><span>{item.kind === 'file' ? '【共享文件】 ' + item.title : projectResultTitle(item)} · v{item.revision}</span></label>)}</div><p className="muted small">所选内容及其附件保留本次提交时的版本，不会上传整个 Session。</p></details>
          <button className="secondary" disabled={busy} onClick={() => void pick()}>添加验收附件</button>
          {uploads.map(file => <label className="check-row" key={file.id}><input type="checkbox" disabled={busy} checked={uploadIds.includes(file.id)} onChange={e => setUploadIds(current => e.target.checked ? [...current, file.id] : current.filter(id => id !== file.id))}/><span>{file.name}</span></label>)}
          {fileCount > 30 && <p className="inline-error">一次验收最多关联 30 个文件。</p>}
        </>}
        {action === 'completed' && !submitting && <p>确认已达到任务目标和验收要求。通过后任务变为“已完成”，记录本次验收人。</p>}
        {(reasonRequired || action === 'completed' && !submitting) && <label className="field">{action === 'cancelled' ? '取消原因' : action === 'in_progress' ? '退回原因' : '验收意见（可选）'}<textarea aria-label="任务处理说明" rows={3} maxLength={6000} value={reason} disabled={busy} onChange={e => setReason(e.target.value)}/></label>}
        {action === 'cancelled' && <p>任务不再继续，不计为完成。不会停止正在运行的会话。</p>}
        {action === 'deleted' && <p>任务将从双方正常列表移入“已删除”，组管理员可恢复。任务记录和附件暂时保留。</p>}
        {action === 'restored' && <p>恢复任务记录和附件，保留原来的“已完成”或“已取消”状态，不重新开始工作。</p>}
        {action === 'purged' && <><p className="inline-error">任务记录和验收记录将永久删除，不能恢复。仅解除此任务的附件关联，仍被其他任务使用的文件会保留。</p><label className="field">输入任务标题确认<input aria-label="彻底删除任务标题" value={confirmedTitle} disabled={busy} onChange={e => setConfirmedTitle(e.target.value)}/></label></>}
        <p className="muted small">已有 Session、对话、项目成果和已带入会话的文件不受影响。</p>
        {error && <p className="inline-error" role="alert">{error}</p>}
      </div><footer><button className="secondary" disabled={busy} onClick={() => setAction(undefined)}>返回</button><button className={action === 'purged' ? 'primary danger' : 'primary'} disabled={busy || submitting && (!summary.trim() || fileCount > 30) || reasonRequired && !reason.trim() || action === 'purged' && confirmedTitle !== task.title} onClick={() => void submit()}>{busy ? '正在提交…' : labels[action]}</button></footer>
    </section></div>}
  </>;
}
