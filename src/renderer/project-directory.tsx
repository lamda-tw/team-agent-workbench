import React, { useRef, useState } from 'react';
import { Check, FolderOpen } from 'lucide-react';
import type { Project } from '../shared/types';
import type { GroupCommand } from '../shared/team-groups';
import { ProjectBriefSettings } from './project-brief-editor';
import { TeamGroupDialog } from './team-groups';
import { RsiProjectSettings } from './rsi-project-settings';
import { SyncConflictCard } from './account-sync';
import type { Snapshot } from '../shared/types';

export function ProjectDirectoryForm({ projectId, projectName, contextKey, directory = '', initial = false, embedded = false, saved }: { projectId: string; projectName: string; contextKey: string; directory?: string; initial?: boolean; embedded?: boolean; saved: () => Promise<void> }) {
  const [value, setValue] = useState(directory), [operation, setOperation] = useState<'saving' | 'choosing' | ''>(''), [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState(''), pending = useRef(false);
  const busy = !!operation;
  const edit = (next: string) => { setValue(next); setConfirmation(''); setError(''); };
  const save = async (next: string) => {
    if (pending.current) return;
    pending.current = true; setOperation('saving'); setError(''); setConfirmation('');
    try {
      const canonical = await window.workbench.call<string>('project.directory.save', { projectId, directory: next, contextKey });
      setValue(canonical); setConfirmation(canonical ? '代码目录已保存' : '已保存，新会话将自动创建独立目录');
      try { await saved(); } catch { setError('目录已保存，但界面未能刷新，请重新打开项目设置。'); }
    } catch (reason: any) { setError(reason.message || '代码目录未保存，请重试'); }
    finally { pending.current = false; setOperation(''); }
  };
  return <section className={(embedded ? '' : 'modal-body ') + 'project-directory-form'} aria-label="项目代码目录设置">
    <h3>{projectName} · 本机代码目录</h3>
    <p className="muted small">{initial ? '首次进入此项目，可选择本机代码目录。之后可点击“我的工作组”中项目旁的设置按钮修改。' : '此目录用于本项目的新会话，仅保存在当前账号的本机设置中。修改后，已有会话继续使用原目录。'}</p>
    <label className="field">代码目录（选填）<div className="row"><input aria-label="代码目录（选填）" disabled={busy} value={value} placeholder="留空用于调研，每次会话自动创建独立目录" onChange={event => edit(event.target.value)}/><button className="secondary" disabled={busy} title="选择项目代码目录" onClick={async () => {
      if (pending.current) return;
      pending.current = true; setOperation('choosing'); setError('');
      try { const chosen = await window.workbench.call<string>('choose.directory'); if (chosen && chosen !== value) edit(chosen); }
      catch (reason: any) { setError(reason.message); } finally { pending.current = false; setOperation(''); }
    }}><FolderOpen size={16}/>{operation === 'choosing' ? '正在选择…' : '选择目录'}</button></div></label>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="row project-directory-actions">{initial && <button className="secondary" disabled={busy} onClick={() => void save('')}>暂不设置</button>}<button className="primary" disabled={busy} onClick={() => void save(value)}>{operation === 'saving' ? '正在保存…' : initial ? '保存并进入项目' : '保存代码目录'}</button>{confirmation && <span className="project-directory-confirmation" role="status"><Check size={15}/>{confirmation}</span>}</div>
  </section>;
}

export function ProjectDirectoryDialog(props: React.ComponentProps<typeof ProjectDirectoryForm>) {
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-label="设置项目代码目录"><header><h2>设置项目代码目录</h2></header><ProjectDirectoryForm {...props} initial/></section></div>;
}

type ProjectMembers = { groupId: string; groupLabel: string; connected: boolean; call: (command: GroupCommand) => Promise<any>; changed: () => Promise<void> };

export function ProjectSettingsDialog({ project, admin, contextKey, directory, members, central, syncState, close, directorySaved, briefSaved }: { project: Project; admin: boolean; contextKey: string; directory?: string; members?: ProjectMembers; central?: React.ReactNode; syncState?: NonNullable<Snapshot['projectSync']>[string]; close: () => void; directorySaved: () => Promise<void>; briefSaved: (revision: number) => Promise<void> }) {
  const [tab, setTab] = useState<'project' | 'members' | 'recommendations' | 'central'>('project'), [membersOpened, setMembersOpened] = useState(false), [recommendationsOpened, setRecommendationsOpened] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false), [syncError, setSyncError] = useState('');
  return <div className="modal-backdrop"><section className="modal wide" role="dialog" aria-label={'项目设置 · ' + project.name}>
    <header><h2>项目设置 · {project.name}</h2><button className="icon" aria-label="关闭窗口" onClick={close}>×</button></header>
    <div className="project-settings-tabs" role="tablist" aria-label="项目设置分类">
      <button role="tab" id="project-settings-project-tab" aria-selected={tab === 'project'} aria-controls="project-settings-project-panel" onClick={() => setTab('project')}>项目资料</button>
      {central && <button role="tab" id="project-settings-central-tab" aria-selected={tab === 'central'} aria-controls="project-settings-central-panel" onClick={() => setTab('central')}>中央节点</button>}
      <button role="tab" id="project-settings-ai-tab" aria-selected={tab === 'recommendations'} aria-controls="project-settings-ai-panel" onClick={() => { setRecommendationsOpened(true); setTab('recommendations'); }}>AI推荐</button>
      {members && <button role="tab" id="project-settings-members-tab" aria-selected={tab === 'members'} aria-controls="project-settings-members-panel" onClick={() => { setMembersOpened(true); setTab('members'); }}>成员与权限</button>}
    </div>
    <div className="project-settings-pane" id="project-settings-project-panel" role="tabpanel" aria-labelledby={members ? 'project-settings-project-tab' : undefined} hidden={tab !== 'project'}>
      {syncState && <div className="modal-body"><p role="status">{syncState.historyOnly ? '本地历史项目，资料仅保存在本机' : syncState.localOnly ? '本机已保存' : syncState.conflict ? '项目资料有分歧待处理' : syncState.error ? '本机已保存，等待自动同步：' + syncState.error : syncState.pending ? '本机已保存，资料待同步' : '项目资料已同步'}</p>{syncError && <p className="inline-error">{syncError}</p>}{syncState.conflict && <SyncConflictCard key={syncState.conflict.token} conflict={syncState.conflict} busy={syncBusy} resolve={async (choice, fields) => { setSyncBusy(true); setSyncError(''); try { await window.workbench.call('project.sync.resolve', { projectId: project.id, token: syncState.conflict!.token, choice, fields }); await directorySaved(); } catch (error: any) { setSyncError(error.message); } finally { setSyncBusy(false); } }}/>}</div>}
      {!!syncState?.history?.length && <details className="modal-body"><summary>合并记录与恢复</summary>{syncState.history.map(item => <div className="row" key={item.id}><span>{new Date(item.at).toLocaleString()}</span><button className="text-button" disabled={syncBusy} onClick={async () => { setSyncBusy(true); setSyncError(''); try { await window.workbench.call('project.sync.undo', { projectId: project.id, id: item.id }); await directorySaved(); } catch (error: any) { setSyncError(error.message); } finally { setSyncBusy(false); } }}>恢复处理前版本</button></div>)}</details>}
      <ProjectBriefSettings project={project} admin={admin} cancel={close} saveLabel="保存项目设置" saved={briefSaved} localSettings={<ProjectDirectoryForm projectId={project.id} projectName={project.name} contextKey={contextKey} directory={directory} saved={directorySaved} embedded/>}/>
    </div>
    {central && <div className="project-settings-pane" id="project-settings-central-panel" role="tabpanel" aria-labelledby="project-settings-central-tab" hidden={tab !== 'central'}>{central}</div>}
    <div className="project-settings-pane" id="project-settings-ai-panel" role="tabpanel" aria-labelledby="project-settings-ai-tab" hidden={tab !== 'recommendations'}>{recommendationsOpened && <RsiProjectSettings projectId={project.id}/>}</div>
    {members && <div className="project-settings-pane" id="project-settings-members-panel" role="tabpanel" aria-labelledby="project-settings-members-tab" hidden={tab !== 'members'}>
      <p className="project-members-scope">成员与权限对项目组「{members.groupLabel}」内所有项目生效。</p>
      {members.connected ? membersOpened && <TeamGroupDialog embedded groupId={members.groupId} call={members.call} close={close} changed={members.changed}/> : <div className="modal-body"><p className="muted small">连接中央节点后，可查看和管理成员与权限。</p></div>}
    </div>}
  </section></div>;
}
