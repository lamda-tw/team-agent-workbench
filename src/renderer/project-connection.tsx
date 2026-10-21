import React from 'react';
import { Server } from 'lucide-react';
import type { ConnectionProfile } from '../shared/types';

export function ProjectCentralConnection({ profile, connected, configure }: { profile: ConnectionProfile; connected: boolean; configure: () => void }) {
  return <section className="modal-body" aria-label="项目中央节点"><div className="row"><Server size={19}/><strong>{profile.host}:{profile.port}</strong><span className="spacer"/><span className={connected ? 'green small' : 'muted small'}>{connected ? '已连接' : '未连接'}</span></div><p>账号：{profile.username}</p><button className="secondary" onClick={configure}>{connected ? '查看连接' : '连接此项目'}</button></section>;
}
