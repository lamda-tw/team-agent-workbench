import { matchesTeamHistory, teamHistoryLabels, teamHistoryReason, type TeamHistoryFilter } from '../shared/team-result-history';
import { contentFileNotice } from '../shared/content-files-state';
import { effectiveResultStatus, canonicalCategory, matchesResultCategory, orderedResults, resultCategory, resultDefaultStatus, resultStateLabel, type ResultStatus } from '../shared/result-model';
import { ResultCategoryDialog, ResultHistoryDrawer, ResultStatusSelect } from './result-lifecycle';
import { resultPreview } from '../shared/result-reading';
import { matchesResultLabel, resultLabels, resultLabelTitle } from '../shared/result-labels';
import { ResultCategoryFilter } from './result-category-filter';
import { ResultCard, ResultMoreMenu } from './result-card';
import { resultLineage } from '../shared/result-lineage';
import { teamResultDifference, teamResultDifferenceLabels } from '../shared/team-result-difference';
import { SubmissionDetails } from './submission-details';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityResultActions } from './activity-result-actions';
import { SharedAttachments } from './attachments';
import { SharedContentDeleteDialog, sharedDeleteSelection } from './shared-content-delete';
import ReactMarkdown from './math-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentSession, ConclusionOrganization, ContentUpdate, Draft, Project, ProjectConclusion } from '../shared/types';
import { contributionCategoryInfo, materialCategories, type ContributionCategory, canDeleteSharedContent, contentAliasKey, titleSubject, type ContentDeleteResult, type SharedContent } from '../shared/content';
export function SharedContentLibrary({ project, username, admin, aliases, aliasSaved, attach, attachSessions: candidateSessions, notice, mergeSessions, mergeStarted, focusPath, focusHandled, resultId, returnToUpdates, activity, activityChanged, embedded = false }: { embedded?: boolean; project: Project; username: string; admin: boolean; aliases: Record<string, string>; aliasSaved: () => Promise<void>; attach: (item: SharedContent, sessionIds: string[]) => Promise<void>; attachSessions: AgentSession[]; notice: (text: string) => void; mergeSessions: AgentSession[]; mergeStarted: (draft: Draft) => void; focusPath?: string; focusHandled?: () => void; resultId?: string; returnToUpdates?: () => void; activity?: ContentUpdate; activityChanged?: () => Promise<void> }) {
  const [items, setItems] = useState<SharedContent[]>([]), [history, setHistory] = useState<SharedContent[]>([]), [showHistory, setShowHistory] = useState(false), [search, setSearch] = useState(''), [kind, setKind] = useState('all'), [selected, setSelected] = useState('');
  const [labelFilter, setLabelFilter] = useState('project_goal');
  const [editCategory, setEditCategory] = useState<ContributionCategory>('exploration'), [editStatus, setEditStatus] = useState<ResultStatus>(), [editOwner, setEditOwner] = useState('');
  const [classifying, setClassifying] = useState<SharedContent>(), [historyItem, setHistoryItem] = useState<SharedContent>();
  const [todoFilter, setTodoFilter] = useState('all');
  const [historyFilter, setHistoryFilter] = useState<TeamHistoryFilter>('all');
  const [revealedId, setRevealedId] = useState('');
  const [personal, setPersonal] = useState<ProjectConclusion[]>([]), [showAll, setShowAll] = useState(true), [savingId, setSavingId] = useState('');
  const loadSequence = useRef(0), personalSequence = useRef(0);
  const [editing, setEditing] = useState(false), [title, setTitle] = useState(''), [body, setBody] = useState(''), [repo, setRepo] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [pendingDelete, setPendingDelete] = useState<SharedContent>(), [pendingReap, setPendingReap] = useState(false);
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const [selectingMerge, setSelectingMerge] = useState(false), [mergeSelection, setMergeSelection] = useState<string[]>([]), [mergeSessionId, setMergeSessionId] = useState('');
  const [selectingDelete, setSelectingDelete] = useState(false), [deleteSelection, setDeleteSelection] = useState<string[]>([]), [pendingDeleteMany, setPendingDeleteMany] = useState<SharedContent[]>([]);
  const bulkDeleteRunning = useRef(false);
  const contentScope = useRef(''); contentScope.current = JSON.stringify([project.id, username, admin, resultId]);
  const [attachItem, setAttachItem] = useState<SharedContent>(), [attachSelection, setAttachSelection] = useState<string[]>([]), [attachBusy, setAttachBusy] = useState(false);
  const attachSessions = candidateSessions.filter(session => session.purpose === 'work' && !session.closedAt && session.binding?.project.id === project.id);
  const currentAttachSelection = attachSelection.filter(id => attachSessions.some(session => session.id === id));
  useEffect(() => {
    const available = new Set(attachSessions.map(session => session.id));
    setAttachSelection(current => { const selected = current.filter(id => available.has(id)); return selected.length === current.length ? current : selected; });
  }, [candidateSessions, project.id]);
  const [aliasItem, setAliasItem] = useState<SharedContent>(), [aliasValue, setAliasValue] = useState('');
  const load = async (resetSelection = true) => {
    const scope = contentScope.current, sequence = ++loadSequence.current, localSequence = ++personalSequence.current; setBusy(true); setBackgroundRefreshing(!resetSelection); if (resetSelection) setDeleteSelection([]);
    try {
      const [items, history, personal] = await Promise.all([window.workbench.call<SharedContent[]>('content.list', { projectId: project.id }), window.workbench.call<SharedContent[]>('content.history', { projectId: project.id }).catch(error => { if (/不支持的内容操作/.test(error.message || '')) return [] as SharedContent[]; throw error; }), window.workbench.call<ProjectConclusion[]>('conclusion.list', { projectId: project.id, includeArchived: true })]);
      if (scope !== contentScope.current || sequence !== loadSequence.current) return false;
      setItems(items); setHistory(history); if (localSequence === personalSequence.current) setPersonal(personal); setError(''); return true;
    }
    catch (e: any) { if (scope === contentScope.current && sequence === loadSequence.current) setError(e.message); return false; }
    finally { if (scope === contentScope.current && sequence === loadSequence.current) { setBusy(false); setBackgroundRefreshing(false); } }
  };
  useEffect(() => { setClassifying(undefined); setHistoryItem(undefined); setItems([]); setHistory([]); setShowHistory(false); setPersonal([]); setShowAll(true); setSavingId(''); setSelected(''); setEditing(false); setLabelFilter('all'); setSearch(''); setKind('all'); setSelectingMerge(false); setMergeSelection([]); setAttachItem(undefined); setAttachSelection([]); setPendingDelete(undefined); setAliasItem(undefined); void load(); return () => { loadSequence.current++; personalSequence.current++; }; }, [project.id, username, admin, resultId]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.workbench.subscribe(event => {
      if (event.type !== 'state') return;
      clearTimeout(timer); timer = setTimeout(() => {
        const scope = contentScope.current, sequence = ++personalSequence.current;
        void window.workbench.call<ProjectConclusion[]>('conclusion.list', { projectId: project.id, includeArchived: true }).then(values => { if (scope === contentScope.current && sequence === personalSequence.current) setPersonal(values); }, error => { if (scope === contentScope.current && sequence === personalSequence.current) setError(error.message); });
      }, 150);
    });
    return () => { clearTimeout(timer); unsubscribe(); personalSequence.current++; };
  }, [project.id, username, resultId]);
  useEffect(() => { const timer = setInterval(() => { if (!editing && !busy && !savingId && document.visibilityState === 'visible') void load(false); }, 30000); return () => clearInterval(timer); }, [project.id, username, resultId, editing, busy, savingId]);
  const storePersonal = async (value: SharedContent) => {
    if (savingId || busy) return;
    const scope = contentScope.current; setSavingId(value.id); setError('');
    try {
      const result = await window.workbench.call<ConclusionOrganization>('conclusion.import', { projectId: project.id, contentId: value.id, expectedRevision: value.revision });
      if (scope !== contentScope.current) return;
      // The server has confirmed this copy. Hide that row immediately, even if
      // the following list refresh fails, and leave another expanded row open.
      personalSequence.current++;
      setPersonal(current => [result.conclusion, ...current.filter(item => item.id !== result.conclusion.id)]);
      setSelected(current => current === value.id ? '' : current); setRevealedId(current => current === value.id ? '' : current); const refreshed = await load();
      if (scope !== contentScope.current) return;
      notice(!refreshed ? '已存入个人成果库，列表刷新失败，请点击刷新重试。' : result.action === 'duplicate' ? '个人成果库中已有这条成果。' : '已存入个人成果库；团队原件保留，个人手工修改不会被覆盖。');
    } catch (reason: any) { if (scope === contentScope.current) setError(reason.message); }
    finally { if (scope === contentScope.current) setSavingId(''); }
  };

  useEffect(() => { if (!mergeSessions.some(session => session.id === mergeSessionId)) setMergeSessionId(mergeSessions[0]?.id || ''); }, [mergeSessionId, mergeSessions]);
  useEffect(() => { setSelectingDelete(false); setDeleteSelection([]); setPendingDeleteMany([]); }, [project.id, username, admin, resultId]);
  const item = items.find(i => i.id === (resultId || selected)) || history.find(i => i.id === (resultId || selected));
  const open = (value: SharedContent) => { setSelected(value.id); setRevealedId(current => current === value.id ? current : ''); setEditing(false); setTitle(value.title); setBody(value.description); setRepo(value.repoUrl || ''); setEditCategory(resultCategory(value) || 'exploration'); setEditStatus(effectiveResultStatus(value)); setEditOwner(value.resultOwner || ''); };
  const edit = (value: SharedContent) => { open(value); setEditing(true); };
  useEffect(() => { if (!focusPath) return; const target = items.find(value => value.path === focusPath); if (target) { setLabelFilter('all'); setSearch(''); setKind('all'); setMergeSelection([]); open(target); setRevealedId(target.id); focusHandled?.(); } }, [focusPath, items]);
  // A direct source link may reveal an existing personal copy until it is closed.
  useEffect(() => { if (!selected) setRevealedId(''); }, [selected, project.id, username, admin, resultId]);
  const save = async (action: 'save' | 'delete') => {
    if (!item) return; setBusy(true); setError('');
    try { const savedTitle = title.trim(); await window.workbench.call('content.edit', { projectId: project.id, change: { id: item.id, revision: item.revision, action, title: savedTitle, description: body, repoUrl: repo, ...(item.kind === 'contribution' ? { category: editCategory, resultStatus: item.linkedAssignments?.length ? undefined : editStatus, resultOwner: editOwner } : {}), curate: admin, merge: [] } }); setEditing(false); await load(); notice(action === 'delete' ? '团队成果已删除' : '团队成果已更新'); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const remove = async (value: SharedContent) => {
    setBusy(true); setError('');
    try {
      await window.workbench.call('content.edit', { projectId: project.id, change: { id: value.id, revision: value.revision, action: 'delete', title: value.title, description: value.description, repoUrl: value.repoUrl || '', curate: admin, merge: [] } });
      if (selected === value.id) setSelected(''); setPendingDelete(undefined); await load(); notice(value.supersededBy || value.deletedAt ? '团队历史已删除；未再被引用的会话轨迹、提交文件和附件已清理' : '团队成果已删除；已保存的个人副本保留');
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const reap = async () => {
    setBusy(true); setError('');
    try {
      const result = await window.workbench.call<{ removed: number }>('content.reap', { projectId: project.id });
      setPendingReap(false); await load(); notice(`已清理 ${result.removed} 个未引用文件`);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const startMerge = async () => {
    if (visibleMergeSelection.length < 2 || !mergeSessionId) return; setBusy(true); setError('');
    try { const draft = await window.workbench.call<Draft>('content.merge.prepare', { projectId: project.id, sessionId: mergeSessionId, sourceIds: visibleMergeSelection }); mergeStarted(draft); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  const removeMany = async () => {
    if (bulkDeleteRunning.current || !pendingDeleteMany.length) return;
    const scope = contentScope.current;
    bulkDeleteRunning.current = true; setBusy(true); setError('');
    try {
      const result = await window.workbench.call<ContentDeleteResult>('content.deleteMany', { projectId: project.id, selections: pendingDeleteMany.map(({ id, revision }) => ({ id, revision })) });
      if (scope !== contentScope.current) { notice(`${project.name}：已删除 ${result.deletedIds.length} 项，未完成 ${result.remaining.length} 项`); return; }
      setPendingDeleteMany([]);
      if (result.deletedIds.includes(selected)) setSelected('');
      setItems(current => current.filter(item => !result.deletedIds.includes(item.id)));
      const refreshed = await load();
      if (scope !== contentScope.current) return;
      setDeleteSelection(result.remaining.map(item => item.id)); setSelectingDelete(!!result.remaining.length);
      const summary = `已删除 ${result.deletedIds.length} 项，未完成 ${result.remaining.length} 项`;
      if (result.error || !refreshed) setError(summary + '。' + (result.uncertainId ? '其中 1 项无法确认是否删除，请先刷新核对。' : '') + (result.error || '列表刷新失败，请重新刷新核对。'));
      notice(summary + '；个人副本和已发送的对话内容保留');
    } catch (e: any) { if (scope === contentScope.current) setError(e.message); }
    finally { bulkDeleteRunning.current = false; if (scope === contentScope.current) setBusy(false); }
  };
  const toggleMerge = (id: string, checked: boolean) => { const value = items.find(item => item.id === id); if (checked && value && mergeSelection.length && resultCategory(value) !== mergeCategory) { setError('只能合并同一分类的成果'); return; } setMergeSelection(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id)); };
  const toggleAttach = (id: string, checked: boolean) => setAttachSelection(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id));
  const completeAttach = async () => {
    if (!attachItem || !currentAttachSelection.length) return;
    setAttachBusy(true); setError('');
    try { await attach(attachItem, currentAttachSelection); setAttachItem(undefined); setAttachSelection([]); }
    catch (e: any) { setError(e.message); }
    finally { setAttachBusy(false); }
  };
  const categoryLabel = (value: SharedContent) => (resultCategory(value) ? contributionCategoryInfo[resultCategory(value)!].label : '') || (value.kind === 'trajectory' ? '会话轨迹' : value.kind === 'file' ? '共享文件' : '未分类');
  const alias = (value: SharedContent) => aliases[contentAliasKey(project.id, value.id)] || '';
  const displayTitle = (value: SharedContent) => titleSubject(resultLabelTitle(value.title, alias(value)));
  const differences = Object.fromEntries(items.map(value => [value.id, teamResultDifference(value, personal)]));
  const visibleItems = (showHistory ? history.filter(value => matchesTeamHistory(value, historyFilter)) : showAll ? items : items.filter(value => differences[value.id] || value.id === revealedId));
  const matching = visibleItems.filter(i => (kind === 'all' || i.kind === kind) && [displayTitle(i), i.title, categoryLabel(i), i.description, i.author, i.repoUrl || '', i.createdAt, i.updatedAt, new Date(i.updatedAt).toLocaleDateString()].join(' ').toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const availableKinds = (['contribution', 'file', 'trajectory'] as const).filter(value => visibleItems.some(item => item.kind === value) || kind === value);
  const filtered = orderedResults(matching.filter(i => matchesResultCategory(i, labelFilter) && (labelFilter !== 'todo' || todoFilter === 'all' || (todoFilter === 'completed' ? effectiveResultStatus(i) === 'completed' : !['completed', 'cancelled'].includes(effectiveResultStatus(i) || 'pending')))));
  const mergeCategory = resultCategory(items.find(value => mergeSelection.includes(value.id)) || { title: '', category: labelFilter });
  const visibleMergeSelection = mergeSelection.filter(id => filtered.some(value => value.id === id && value.kind === 'contribution'));
  const hasFilters = search || kind !== 'all' || labelFilter !== 'all' || showHistory && historyFilter !== 'all';
  const deletion = sharedDeleteSelection(filtered, deleteSelection, username, admin);
  const updateMetadata = async (value: SharedContent, category?: ContributionCategory, status?: ResultStatus) => {
    setBusy(true); setError('');
    try { await window.workbench.call('content.edit', { projectId: project.id, change: { id: value.id, revision: value.revision, action: 'save', title: category && !status ? `【${contributionCategoryInfo[category].label}】 ${titleSubject(value.title)}` : value.title, description: value.description, repoUrl: value.repoUrl, category, resultStatus: status, curate: admin } }); setClassifying(undefined); await load(); notice(status ? '状态已更新' : '分类已修改，正文和来源保留'); }
    catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
  };
  const renderBody = (value: SharedContent, isEditing: boolean) => <>
    <p className="muted small">成果 ID：<code>{value.id}</code> · v{value.revision} <button className="text-button" onClick={() => void window.workbench.call('copy', value.id).then(() => notice('成果 ID 已复制')).catch(error => setError(error.message))}>复制 ID</button>{value.supersededBy && <> · 已由 {value.supersededBy.id} 替代</>}</p>

    {teamHistoryReason(value) === 'merged' && <p className="team-history-note">已合并为“{titleSubject([...items, ...history].find(target => target.id === value.supersededBy?.id)?.title || '另一条团队成果')}”，此条作为合并来源保留。</p>}
    {alias(value) && <p className="muted small">本地别名，仅你可见 · 远端标题：{titleSubject(value.title) || value.title}</p>}
    {isEditing ? <>
      <ResultStatusSelect category={canonicalCategory(editCategory)!} value={editStatus} disabled={!!value.linkedAssignments?.length} change={setEditStatus}/>{resultCategory(value) === 'todo' && <label className="field">负责人<input aria-label="待办负责人" value={editOwner} onChange={event => setEditOwner(event.target.value)}/></label>}<label className="field">标题<input aria-label="团队成果标题" value={title} onChange={e => setTitle(e.target.value)}/></label>
      <label className="field">内容 / 说明<textarea aria-label="团队成果内容" rows={14} value={body} onChange={e => setBody(e.target.value)}/></label>
      <label className="field">仓库链接（可选）<input value={repo} onChange={e => setRepo(e.target.value)}/></label>
    </> : <>
      {contentFileNotice(value) && <p className="update-processing-note" role="status">{contentFileNotice(value)}{value.files?.body === 'missing' && ' 以下文字为此前保存的成果记录。'}</p>}
      {value.deletedAt ? <p className="muted">这条成果已删除，仅保留删除记录，正文不可用。</p> : <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:/.test(href)) void window.workbench.call('open.link', href); }}>{children}</a>, img: ({ alt }) => <span>[图片：{alt}]</span> }}>{value.description || '此项为共享文件。'}</ReactMarkdown></div>}
      <SharedAttachments key={value.id} item={value} projectId={project.id}/>
      <SubmissionDetails record={value.submission} legacySource={value.sourceSessionTitle} legacyAuthor={value.author} updatedBy={value.updatedBy} revision={value.revision}>{value.sourceDetails && <pre style={{ whiteSpace: 'pre-wrap' }}>{value.sourceDetails}</pre>}</SubmissionDetails>
      {value.derivedFrom?.length ? <details className="content-provenance"><summary>直接来源（{value.derivedFrom.length}）</summary>{value.derivedFrom.map(ref => { const source = items.find(item => item.id === ref.id && item.revision === ref.version) || history.find(item => item.id === ref.id && item.revision === ref.version); return <details key={ref.id + ':' + ref.version}><summary>{source?.title || ref.id} · v{ref.version}{source && source.revision < Math.max(...[...items, ...history].filter(item => item.id === ref.id).map(item => item.revision)) && ' · 有新版本'}</summary><p>ID：<code>{ref.id}</code></p>{source ? <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{source.description}</ReactMarkdown></div> : <p>历史正文不可用</p>}</details>; })}</details> : value.provenance?.length ? <details className="content-provenance"><summary>历史来源摘要（正文不可用）</summary>{value.provenance.map(source => <p key={source.id + ':' + source.revision}>{source.title} · {source.author} · v{source.revision}</p>)}</details> : null}
      {value.derivedFrom?.length ? <details className="content-provenance"><summary>完整来源链</summary>{resultLineage(value.derivedFrom, ref => items.find(item => item.id === ref.id && item.revision === ref.version) || history.find(item => item.id === ref.id && item.revision === ref.version)).map(ref => <p key={`${ref.scope}:${ref.id}:${ref.version}`}><code>{ref.id}</code> · v{ref.version}</p>)}</details> : null}
      {!!value.disclosedSources?.length && <details className="content-provenance"><summary>分享人公开的来源（{value.disclosedSources.length}）</summary>{value.disclosedSources.map(ref => <p key={`${ref.scope}:${ref.id}:${ref.version}`}>{ref.scope === 'personal' ? '个人成果' : '团队成果'} · <code>{ref.id}</code> · v{ref.version}</p>)}</details>}
      {!!value.replaces?.length && <details className="content-provenance"><summary>替代记录（{value.replaces.length}）</summary>{value.replaces.map(ref => <p key={ref.id + ':' + ref.version}>{ref.id} · v{ref.version}</p>)}</details>}
      {value.repoUrl && <p>仓库：{value.repoUrl}</p>}
      {value.git && <p className="muted small">分支 {value.git.branch} · Commit {value.git.commit || '无'} · {value.git.dirty ? '存在未提交改动' : '无未提交改动'}</p>}
    </>}
  </>;
  const renderActions = (value: SharedContent, isEditing: boolean) => {
    if (history.includes(value)) {
      const writable = admin || value.author === username && value.state === 'submitted';
      if (!writable) return null;
      return <button className="secondary compact danger" aria-label={`删除历史成果：${displayTitle(value)}`} disabled={busy || editing || selectingDelete} onClick={() => setPendingDelete(value)}>删除历史成果</button>;
    }
    if (isEditing) return <>
      <button className="secondary compact" disabled={busy} onClick={() => open(value)}>取消编辑</button>
      {value.kind !== 'contribution' && <button className="secondary compact" disabled={busy || !title.trim()} onClick={async () => { setBusy(true); try { const saved = await window.workbench.call('content.replace', { projectId: project.id, change: { id: value.id, revision: value.revision, action: 'save', title, description: body, curate: admin } }); if (saved) { setEditing(false); await load(); notice('文件已替换为新修订'); } } catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>选择文件并保存替换</button>}
      <button className="primary compact" disabled={busy || !title.trim()} onClick={() => void save('save')}>保存修改</button>
    </>;
    const fileBlocked = !!value.files && value.files.body !== 'ok';
    const disabled = busy || editing || !!savingId || selectingMerge || selectingDelete;
    const difference = differences[value.id];
    const keepSaveAppearance = backgroundRefreshing && !editing && !savingId && !selectingMerge && !selectingDelete && !!difference;
    const writable = admin || value.author === username && value.state === 'submitted';
    return <>
      {value.linkedAssignments?.length ? <span className="muted small">已关联项目任务 · {value.linkedAssignments.map(task => task.status === 'pending_review' ? '待验收' : task.status === 'completed' ? '已完成' : '按任务进度处理').join('、')}</span> : null}
      {!activity && difference && <button className={'primary compact' + (keepSaveAppearance ? ' result-save-refreshing' : '')} aria-label={resultId ? undefined : `存入个人成果库：${displayTitle(value)}`} title={contentFileNotice(value)} disabled={disabled || fileBlocked} onClick={() => void storePersonal(value)}>{savingId === value.id ? '正在存入…' : '存入个人成果库'}</button>}
      {!activity && !difference && resultId && <span className="muted small">个人库已有此版本</span>}
      {writable && <button className="secondary compact danger" aria-label={resultId ? undefined : `删除团队成果：${displayTitle(value)}`} disabled={disabled} onClick={() => setPendingDelete(value)}>删除团队成果</button>}
      <ResultMoreMenu disabled={busy || selectingDelete || !!mergeSelection.length}>
        {writable && resultCategory(value) === 'todo' && !value.linkedAssignments?.length && <button className="secondary compact" disabled={disabled} onClick={() => void updateMetadata(value, value.category || 'todo', value.resultStatus === 'completed' || value.resultStatus === 'cancelled' ? 'pending' : 'completed')}>{value.resultStatus === 'completed' || value.resultStatus === 'cancelled' ? '重新打开' : '标记完成'}</button>}
        {writable && resultCategory(value) === 'project_goal' && value.resultStatus !== 'confirmed' && <button className="secondary compact" disabled={disabled} onClick={() => void updateMetadata(value, value.category || 'project_goal', 'confirmed')}>确认目标</button>}
        {!!history.filter(entry => entry.id === value.id && entry.revision < value.revision).length && <button className="secondary compact" disabled={disabled} onClick={() => setHistoryItem(value)}>历史版本 · {history.filter(entry => entry.id === value.id && entry.revision < value.revision).length}</button>}
        {value.kind !== 'contribution' && <button className="secondary compact" disabled={disabled || fileBlocked} onClick={() => void window.workbench.call('remote.download', { projectId: project.id, path: value.path }).catch(e => setError(e.message))}>下载</button>}
        <button className="secondary compact" disabled={disabled} onClick={() => { setAliasItem(value); setAliasValue(alias(value)); }}>设置本地别名</button>
        <button className="secondary compact" disabled={disabled || fileBlocked || !attachSessions.length} title={attachSessions.length ? '选择一个或多个会话作为参考资料' : '请先创建或重新打开当前项目的工作会话'} onClick={() => { setAttachItem(value); setAttachSelection([]); }}>加入会话</button>
        {writable && value.kind === 'contribution' && <button className="secondary compact" disabled={disabled || !!value.linkedAssignments?.length} onClick={() => { setClassifying(value); setError(''); }}>修改分类</button>}
        {writable && <button className="secondary compact" disabled={disabled} onClick={() => edit(value)}>{admin ? '编辑成果' : '修改自己的提交'}</button>}
      </ResultMoreMenu>
    </>;
  };
  return <div className={(embedded ? 'results-library-pane' : 'workspace-page') + ' team-results' + (resultId ? ' activity-result-page' : '')}>
    {(!embedded || resultId) && <div className="page-title"><div>{!embedded && <span className="eyebrow">TEAM CONTENT</span>}{embedded ? <h2>动态结果</h2> : <h1>{resultId ? '动态结果' : '团队成果'} · {project.name}</h1>}</div>{resultId && <div className="row"><button className="secondary" disabled={busy || editing} onClick={returnToUpdates}>返回动态</button><button className="secondary" disabled={busy || editing} onClick={() => void load()}>刷新</button></div>}</div>}
    {!resultId && <>
      <div className="team-results-toolbar">
        <div className="team-results-summary"><strong>{showHistory ? '团队历史' : showAll ? '当前团队成果' : '与个人库有差异'}</strong><span role="status" aria-label="团队成果数量">{busy ? '正在读取…' : filtered.length === visibleItems.length ? `共 ${visibleItems.length} 条` : `显示 ${filtered.length} / 共 ${visibleItems.length} 条`}</span>{!showHistory && <label className="team-results-include"><input type="checkbox" checked={!showAll} disabled={busy || editing || !!savingId} onChange={event => { setShowAll(!event.target.checked); setLabelFilter('all'); setSearch(''); setKind('all'); setSelected(''); setSelectingMerge(false); setMergeSelection([]); setSelectingDelete(false); setDeleteSelection([]); }}/><span>仅看与个人库的差异</span></label>}</div>
        <div className="team-results-actions">
          <button className="secondary compact" disabled={busy || editing} onClick={() => { setShowHistory(!showHistory); setHistoryFilter('all'); setSelected(''); setSearch(''); setLabelFilter('all'); setKind('all'); setSelectingMerge(false); setMergeSelection([]); setSelectingDelete(false); setDeleteSelection([]); }}>{showHistory ? '返回当前成果' : '查看团队历史'}</button>
          {admin && !showHistory && <button className="secondary compact" disabled={editing || busy} onClick={() => { setSelectingMerge(!selectingMerge); setMergeSelection([]); setSelectingDelete(false); setDeleteSelection([]); }}>{selectingMerge ? '退出多选' : '合并整理'}</button>}
          <button className="secondary compact" aria-label={selectingDelete ? '取消批量删除' : showHistory ? '批量删除历史成果' : '批量删除团队成果'} disabled={busy || editing || !deletion.eligible.length} onClick={() => { setSelectingDelete(!selectingDelete); setDeleteSelection([]); setSelectingMerge(false); setMergeSelection([]); setError(''); }}>{selectingDelete ? '取消多选' : '批量删除'}</button>
          {admin && <button className="secondary compact" disabled={busy || editing} onClick={() => setPendingReap(true)}>清理未引用文件</button>}
          <button className="secondary compact" disabled={busy || editing} onClick={() => void load()}>刷新</button>

        </div>
      </div>
      <div className="result-library-filters">{showHistory && <label className="result-history-filter">历史类型<select aria-label="团队历史类型" value={historyFilter} disabled={busy || editing} onChange={event => { setHistoryFilter(event.target.value as TeamHistoryFilter); setSelected(''); setDeleteSelection([]); setMergeSelection([]); }}><option value="all">全部历史</option><option value="merged">合并历史</option><option value="deleted">删除历史</option></select></label>}<input aria-label="搜索团队成果" placeholder="搜索标题或内容" value={search} disabled={busy || editing} onChange={e => { setSearch(e.target.value); setSelected(''); setDeleteSelection([]); setMergeSelection([]); }}/><ResultCategoryFilter items={visibleItems} label="团队成果类别" value={labelFilter} disabled={busy || editing || !!mergeSelection.length} onChange={value => { setLabelFilter(value); setSelected(''); setMergeSelection([]); setDeleteSelection([]); }}/>{(availableKinds.length > 1 || kind !== 'all') && <select aria-label="团队成果内容形式" value={kind} disabled={busy || editing} onChange={e => { setKind(e.target.value); setSelected(''); setDeleteSelection([]); setMergeSelection([]); }}><option value="all">全部内容形式</option>{availableKinds.map(value => <option key={value} value={value}>{{ contribution: '文字成果', file: '共享文件', trajectory: '会话轨迹' }[value]}</option>)}</select>}{hasFilters && <button className="team-results-clear" disabled={busy || editing} onClick={() => { setSearch(''); setKind('all'); setLabelFilter('all'); setHistoryFilter('all'); setSelected(''); setDeleteSelection([]); setMergeSelection([]); }}>清除筛选</button>}</div>
    </>}
    {!resultId && labelFilter === 'todo' && <div className="row result-category-description"><span>已完成事项保留在下方，仍可查看和重新打开。</span><select aria-label="待办状态筛选" value={todoFilter} onChange={event => setTodoFilter(event.target.value)}><option value="all">全部状态</option><option value="active">未完成</option><option value="completed">已完成</option></select></div>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    {admin && !resultId && selectingMerge && <section className="semantic-merge-bar" aria-label="语义合并设置"><div><b>已选择 {visibleMergeSelection.length} 条文字成果</b><small>至少选择 2 条同类成果；待办只合并同一事项的重复记录。</small></div>{mergeSessions.length ? <label>使用模型环境<select aria-label="合并使用的模型环境" value={mergeSessionId} onChange={e => setMergeSessionId(e.target.value)}>{mergeSessions.map(session => <option value={session.id} key={session.id}>{session.title} · {session.provider === 'codex' ? 'Codex' : session.provider === 'claude' ? 'Claude Code' : 'Cursor'}{session.model ? ' · ' + session.model : ''}</option>)}</select></label> : <p className="inline-error">请先为此项目创建一个工作会话，用于提供已登录的 AI 模型环境。</p>}<button className="primary" disabled={busy || visibleMergeSelection.length < 2 || !mergeSessionId} onClick={() => void startMerge()}>{busy ? '正在启动…' : `开始语义合并${visibleMergeSelection.length ? `（${visibleMergeSelection.length} 条）` : ''}`}</button></section>}
    {selectingDelete && !resultId && <section className="semantic-merge-bar" aria-label="团队成果批量删除设置"><label className="check-row"><input type="checkbox" aria-label="全选当前可删除的团队成果" disabled={busy || !deletion.eligible.length} checked={!!deletion.eligible.length && deletion.selected.length === Math.min(100, deletion.eligible.length)} onChange={event => setDeleteSelection(event.target.checked ? deletion.eligible.slice(0, 100).map(item => item.id) : [])}/><span>全选当前可删除项（最多 100 项）</span></label><span>已选择 {deletion.selected.length} 项；切换分组、筛选或刷新后会清空选择</span><button className="primary danger" disabled={busy || !deletion.selected.length} onClick={() => { setError(''); setPendingDeleteMany(structuredClone(deletion.selected)); }}>删除选中的 {deletion.selected.length} 项</button></section>}
    {resultId && activity && activityChanged && <ActivityResultActions event={activity} item={item && !history.includes(item) ? item : undefined} disabled={busy || editing || attachBusy} changed={async () => { await activityChanged(); await load(); }} notice={notice}/>}
    {resultId ? <div className="content-library single-content-result"><section className="content-detail">
      {item ? <>
        <div className="content-detail-title"><span className="content-category-badge">{categoryLabel(item)}</span><h2>{displayTitle(item)}</h2></div>
        {renderBody(item, editing)}
        <div className="row">{renderActions(item, editing)}</div>
      </> : <p className="muted">{busy ? '正在读取这条成果…' : error ? '读取失败，请重试。' : '这条成果已删除或被合并，当前结果已不可用。已保存的本地成果仍会保留。'}</p>}
    </section></div> : <div className="content-library result-library"><div className="content-cards">
      {filtered.map(value => { const difference = differences[value.id], historyReason = teamHistoryReason(value); return <ResultCard key={value.id + ':' + value.revision} id={value.id} completed={['completed', 'cancelled'].includes(effectiveResultStatus(value) || '')} title={displayTitle(value)}
        badges={<><span className="content-category-badge">{categoryLabel(value)}</span>{showHistory && historyReason && <span className={'team-history-badge is-' + historyReason}>{teamHistoryLabels[historyReason]}</span>}{!showHistory && resultStateLabel(value) && <span className="result-state-badge">{resultStateLabel(value)}</span>}{contentFileNotice(value) && <span className="team-result-difference">{value.files?.body === 'missing' || Object.values(value.files?.attachments || {}).includes('missing') ? '关联文件缺失' : '文件待核验'}</span>}{!showHistory && difference && difference !== 'missing' && <span className="team-result-difference">{teamResultDifferenceLabels[difference]}</span>}{!showHistory && !difference && <span className="team-result-difference is-settled">个人库已有</span>}</>}
        metadata={<>{value.resultOwner ? `负责人：${value.resultOwner} · ` : ''}{value.author} · v{value.revision} · {new Date(value.updatedAt).toLocaleString()}{!!value.attachments?.length && ` · ${value.attachments.length} 个附件`}</>}
        preview={value.deletedAt ? '仅保留删除记录，正文不可用。' : resultPreview(value.description) || '共享文件'} expanded={value.id === selected}
        selected={mergeSelection.includes(value.id) || deleteSelection.includes(value.id)} disabled={editing}
        toggle={() => value.id === selected ? setSelected('') : open(value)}
        selection={selectingDelete ? <label className="content-card-select check-row" title={canDeleteSharedContent(value, username, admin) ? '选择删除' : '无删除权限'}><input type="checkbox" aria-label={`选择删除团队成果：${displayTitle(value)}`} checked={deletion.selected.some(item => item.id === value.id)} disabled={busy || !canDeleteSharedContent(value, username, admin) || !deleteSelection.includes(value.id) && deletion.selected.length >= 100} onChange={event => setDeleteSelection(current => event.target.checked ? [...new Set([...current, value.id])] : current.filter(id => id !== value.id))}/></label> : selectingMerge && value.kind === 'contribution' ? <label className="content-card-select check-row" title="加入语义合并"><input type="checkbox" aria-label={`选择合并：${value.title}`} checked={mergeSelection.includes(value.id)} disabled={busy || !!value.files && (value.files.body !== 'ok' || Object.values(value.files.attachments).some(status => status !== 'ok')) || !!value.linkedAssignments?.length || !!mergeSelection.length && resultCategory(value) !== mergeCategory} onChange={event => toggleMerge(value.id, event.target.checked)}/></label> : undefined}
        actions={renderActions(value, editing && value.id === selected)}>
        {renderBody(value, editing && value.id === selected)}
      </ResultCard>; })}
      {!filtered.length && <p className="muted">{busy ? '正在比对团队与个人成果…' : !showHistory && !showAll && !visibleItems.length && items.length ? '团队成果与个人库已一致，暂无需要存入的内容。' : hasFilters ? '暂无匹配成果，可清除筛选查看。' : showHistory ? '暂无团队历史' : '暂无团队成果'}</p>}
    </div></div>}
    {classifying && <ResultCategoryDialog category={resultCategory(classifying)!} busy={busy} error={error} close={() => setClassifying(undefined)} save={category => void updateMetadata(classifying, category)}/>}
    {historyItem && <ResultHistoryDrawer current={{ ...historyItem, version: historyItem.revision, content: historyItem.description }} versions={history.filter(entry => entry.id === historyItem.id).map(entry => ({ ...entry, version: entry.revision, content: entry.description }))} close={() => setHistoryItem(undefined)}/>}
    {attachItem && <div className="modal-backdrop"><section className="modal attach-session-modal" role="dialog" aria-modal="true" aria-labelledby="attach-session-title"><header><h2 id="attach-session-title">选择加入的会话</h2><button className="icon" aria-label="关闭窗口" onClick={() => setAttachItem(undefined)}>×</button></header><div className="modal-body"><p className="attach-source-title">{displayTitle(attachItem)}</p><div className="attach-session-options">{attachSessions.map(session => <label className="attach-session-option" key={session.id}><input type="checkbox" aria-label={`选择会话：${session.title}`} checked={attachSelection.includes(session.id)} disabled={attachBusy} onChange={event => toggleAttach(session.id, event.target.checked)}/><span><b>{session.title}</b><small>{session.provider === 'codex' ? 'Codex' : session.provider === 'claude' ? 'Claude Code' : 'Cursor'}{session.model ? ` · ${session.model}` : ''}</small></span></label>)}</div>{!attachSessions.length && <p className="muted">当前项目没有打开的工作会话，请创建或重新打开一个会话。</p>}</div><footer><button className="secondary" disabled={attachBusy} onClick={() => setAttachItem(undefined)}>取消</button><button className="primary" disabled={attachBusy || !currentAttachSelection.length} onClick={() => void completeAttach()}>{attachBusy ? '正在加入…' : `加入 ${currentAttachSelection.length} 个会话`}</button></footer></section></div>}
    {aliasItem && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="content-alias-title"><header><h2 id="content-alias-title">设置本地别名</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={() => setAliasItem(undefined)}>×</button></header><div className="modal-body"><p className="muted small">别名只作用于你的账号，可随账号同步；不修改共享标题，其他成员看不到。</p><label className="field">本地别名<input autoFocus aria-label="项目成果本地别名" maxLength={200} value={aliasValue} placeholder={titleSubject(aliasItem.title) || aliasItem.title} onChange={event => setAliasValue(event.target.value)}/></label><p className="muted small">远端标题：{titleSubject(aliasItem.title) || aliasItem.title}</p></div><footer>{alias(aliasItem) && <button className="secondary danger" disabled={busy} onClick={() => void (async () => { setBusy(true); try { await window.workbench.call('content.alias.save', { projectId: project.id, contentId: aliasItem.id, alias: '' }); await aliasSaved(); setAliasItem(undefined); notice('本地别名已清除'); } catch (e: any) { setError(e.message); } finally { setBusy(false); } })()}>清除别名</button>}<span className="spacer"/><button className="secondary" disabled={busy} onClick={() => setAliasItem(undefined)}>取消</button><button className="primary" disabled={busy || !aliasValue.trim()} onClick={() => void (async () => { setBusy(true); try { await window.workbench.call('content.alias.save', { projectId: project.id, contentId: aliasItem.id, alias: aliasValue }); await aliasSaved(); setAliasItem(undefined); notice('本地别名已保存，不会修改远端标题'); } catch (e: any) { setError(e.message); } finally { setBusy(false); } })()}>{busy ? '正在保存…' : '保存本地别名'}</button></footer></section></div>}
    {pendingDelete && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-project-content-title"><header><h2 id="delete-project-content-title">{pendingDelete.supersededBy || pendingDelete.deletedAt ? '确认删除团队历史？' : '确认删除团队成果？'}</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={() => setPendingDelete(undefined)}>×</button></header><div className="modal-body"><p>{pendingDelete.supersededBy || pendingDelete.deletedAt ? `将从团队历史移除“${displayTitle(pendingDelete)}”。` : `将删除团队成果“${displayTitle(pendingDelete)}”。同组成员将无法再从团队成果库查看或引用；正文和历史版本无法从库中恢复。`}</p><p className="muted small">{pendingDelete.supersededBy || pendingDelete.deletedAt ? '这条历史记录对应的正文、附件和会话轨迹，只要没有其他成果继续引用，会一起从共享空间删除。' : '已保存的个人副本、本机整理记录、已发送的对话内容及任务和子会话的固定快照保留。这条成果自己的提交文件、会话轨迹和附件会一并删除；仍被其他成果引用的文件会保留。'}</p>{pendingDelete.provenance?.length ? <p className="merge-safety">删除这条合并成果，不会自动恢复被它替代的来源成果。</p> : !pendingDelete.supersededBy && !pendingDelete.deletedAt ? <p className="muted small">各成员可在删除动态中自行决定是否删除个人副本。</p> : null}</div><footer><button className="secondary" disabled={busy} onClick={() => setPendingDelete(undefined)}>取消</button><button className="primary danger" disabled={busy} onClick={() => void remove(pendingDelete)}>{busy ? '正在删除…' : pendingDelete.supersededBy || pendingDelete.deletedAt ? '确认删除历史成果' : '确认删除团队成果'}</button></footer></section></div>}
    {pendingReap && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="reap-project-files-title"><header><h2 id="reap-project-files-title">清理未引用文件？</h2><button className="icon" aria-label="关闭窗口" disabled={busy} onClick={() => setPendingReap(false)}>×</button></header><div className="modal-body"><p>只删除这个项目里已经没有任何当前成果或历史成果引用的成员提交、会话轨迹、团队整理文件和附件。</p><p className="muted small">项目说明、任务附件和其他直接放在项目目录中的文件会保留。清理不会删除历史记录本身；要去掉历史条目，请在团队历史里删除。</p>{error && <div className="inline-error" role="alert">{error}</div>}</div><footer><button className="secondary" disabled={busy} onClick={() => setPendingReap(false)}>取消</button><button className="primary danger" disabled={busy} onClick={() => void reap()}>{busy ? '正在清理…' : '确认清理'}</button></footer></section></div>}
    {!!pendingDeleteMany.length && <SharedContentDeleteDialog items={pendingDeleteMany} title={displayTitle} busy={busy} error={error} close={() => setPendingDeleteMany([])} confirm={() => void removeMany()}/>}
  </div>;
}
