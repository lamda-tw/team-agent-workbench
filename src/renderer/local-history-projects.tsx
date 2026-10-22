import React from 'react';
import type { Project, WorkbenchAPI } from '../shared/types';
import { SidebarProjectItem } from './sidebar-project-item';

export function LocalHistoryProjects({ projects, selectedId, select, settings, call }: {
  projects: Project[]; selectedId: string; select: (id: string) => void; settings: (id: string) => void; call: WorkbenchAPI['call'];
}) {
  if (!projects.length) return null;
  return <section className="workgroup" aria-label="本地历史项目">
    <div className="workgroup-title"><b>本地历史项目</b><span className="badge">仅本机</span></div>
    {projects.map(project => <SidebarProjectItem key={project.id} project={project} historical selected={project.id === selectedId} select={() => select(project.id)} settings={() => settings(project.id)} call={call}/>)}
  </section>;
}

export function LocalHistoryNotice() {
  return <div className="callout connection-status" role="status"><div><b>本地历史项目</b><small>中央节点当前未提供此项目。本机会话、草稿与个人成果仍可使用；共享内容需恢复原项目访问后才能使用。</small></div></div>;
}
