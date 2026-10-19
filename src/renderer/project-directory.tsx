import React, { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { Project } from '../shared/types';
import { ProjectBriefSettings } from './project-brief-editor';

export function ProjectDirectoryForm({ projectId, projectName, contextKey, directory = '', initial = false, embedded = false, saved }: { projectId: string; projectName: string; contextKey: string; directory?: string; initial?: boolean; embedded?: boolean; saved: () => Promise<void> }) {
  const [value, setValue] = useState(directory), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const save = async (next: string) => {
    setBusy(true); setError('');
    try {
      const canonical = await window.workbench.call<string>('project.directory.save', { projectId, directory: next, contextKey });
      setValue(canonical); await saved();
    } catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
  };
  return <section className={(embedded ? '' : 'modal-body ') + 'project-directory-form'} aria-label="项目代码目录设置">
    <h3>{projectName} · 本机代码目录</h3>
    <p className="muted small">{initial ? '首次进入此项目，可选择本机代码目录。之后可点击“我的工作组”中项目旁的设置按钮修改。' : '此目录用于本项目的新会话，仅保存在当前账号的本机设置中。修改后，已有会话继续使用原目录。'}</p>
    <label className="field">代码目录（选填）<div className="row"><input aria-label="代码目录（选填）" disabled={busy} value={value} placeholder="留空用于调研，每次会话自动创建独立目录" onChange={event => setValue(event.target.value)}/><button className="secondary" disabled={busy} title="选择项目代码目录" onClick={async () => {
      setBusy(true); setError('');
      try { const chosen = await window.workbench.call<string>('choose.directory'); if (chosen) setValue(chosen); }
      catch (reason: any) { setError(reason.message); } finally { setBusy(false); }
    }}><FolderOpen size={16}/>选择目录</button></div></label>
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="row">{initial && <button className="secondary" disabled={busy} onClick={() => void save('')}>暂不设置</button>}<button className="primary" disabled={busy} onClick={() => void save(value)}>{busy ? '正在保存…' : initial ? '保存并进入项目' : '保存代码目录'}</button></div>
  </section>;
}

export function ProjectDirectoryDialog(props: React.ComponentProps<typeof ProjectDirectoryForm>) {
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-label="设置项目代码目录"><header><h2>设置项目代码目录</h2></header><ProjectDirectoryForm {...props} initial/></section></div>;
}

export function ProjectSettingsDialog({ project, admin, contextKey, directory, close, directorySaved, briefSaved }: { project: Project; admin: boolean; contextKey: string; directory?: string; close: () => void; directorySaved: () => Promise<void>; briefSaved: (revision: number) => Promise<void> }) {
  return <div className="modal-backdrop"><section className="modal wide" role="dialog" aria-label={'项目设置 · ' + project.name}>
    <header><h2>项目设置 · {project.name}</h2><button className="icon" aria-label="关闭窗口" onClick={close}>×</button></header>
    <ProjectBriefSettings project={project} admin={admin} cancel={close} saveLabel="保存项目设置" saved={briefSaved} localSettings={<ProjectDirectoryForm projectId={project.id} projectName={project.name} contextKey={contextKey} directory={directory} saved={directorySaved} embedded/>}/>
  </section></div>;
}
