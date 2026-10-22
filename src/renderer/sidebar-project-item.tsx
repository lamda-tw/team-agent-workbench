import React, { useEffect, useState } from 'react';
import { ChevronRight, Settings } from 'lucide-react';
import type { WorkbenchAPI } from '../shared/types';
import { RsiRecommendationToggle } from './rsi-recommendation-toggle';

export function SidebarProjectItem({ project, selected, select, settings, call, recommendations, pending, conflict, historical }: {
  project: { id: string; name: string }; selected: boolean;
  select: () => void; settings: () => void; call: WorkbenchAPI['call'];
  recommendations?: () => void; pending?: number; conflict?: boolean; historical?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { if (!selected) setCollapsed(false); }, [selected]);
  const expanded = selected && !collapsed;
  const detailsId = 'project-controls-' + project.id;
  return <div className={'workgroup-project-item' + (selected ? ' is-selected' : '') + (expanded ? ' is-expanded' : '')}>
    <div className="workgroup-project-row">
      <button className={'workgroup-project' + (selected ? ' selected' : '')} data-project-id={project.id} aria-expanded={expanded} aria-controls={expanded ? detailsId : undefined} onClick={() => { setCollapsed(selected ? !collapsed : false); select(); }}>
        <ChevronRight size={13} className="project-expand-icon"/><span title={project.name}>{project.name}</span>
      </button>
      <button className="icon project-settings-action" title={'项目设置：' + project.name} aria-label={'项目设置：' + project.name} onClick={settings}>{conflict ? <span className="inline-error" title="项目资料有分歧，点击处理">●</span> : <Settings size={14}/>}</button>
    </div>
    {expanded && <div className="workgroup-project-details" id={detailsId}>{historical ? <p className="muted small">本地对话和草稿仍可使用；此项目当前未连接共享区。</p> : <RsiRecommendationToggle projectId={project.id} projectName={project.name} call={call} open={recommendations} pending={pending}/>}</div>}
  </div>;
}
