import React, { useEffect, useState } from 'react';
import { ChevronRight, Settings } from 'lucide-react';
import type { WorkbenchAPI } from '../shared/types';
import { RsiRecommendationToggle } from './rsi-recommendation-toggle';

export function SidebarProjectItem({ project, selected, select, settings, call }: {
  project: { id: string; name: string }; selected: boolean;
  select: () => void; settings: () => void; call: WorkbenchAPI['call'];
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
      <button className="icon project-settings-action" title={'项目设置：' + project.name} aria-label={'项目设置：' + project.name} onClick={settings}><Settings size={14}/></button>
    </div>
    {expanded && <div className="workgroup-project-details" id={detailsId}><RsiRecommendationToggle projectId={project.id} projectName={project.name} call={call}/></div>}
  </div>;
}
