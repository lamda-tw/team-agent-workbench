import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Workbench } from './workbench';
import type { TextTask } from './background-text';
import { RsiEngine } from './rsi';
import { accountIdentity } from '../shared/account-data';
import { ownsBinding } from '../shared/account-scope';
import type { RsiObservation } from '../shared/rsi';
import type { RemoteBinding } from '../shared/types';

export function workbenchRsi(workbench: Workbench, runText: TextTask, changed: () => void) {
  const profile = () => workbench.remote.connected ? workbench.remote.profile : workbench.store.settings.workspaceSnapshot?.profile;
  const binding = (projectId: string): RemoteBinding => {
    workbench.assertAccountReady();
    const account = profile(), project = account?.projects.find(item => item.id === projectId);
    if (!account || !project) throw new Error('项目助手无法访问此项目');
    const value = { connectionId: account.id, host: account.host, port: account.port, username: account.username, fingerprint: account.fingerprint, project };
    workbench.assertCanWork(value); return value;
  };
  const sessions = (projectId: string) => workbench.store.sessions.filter(session => session.binding?.project.id === projectId && ownsBinding(profile(), session.binding) && session.purpose === 'work' && !session.closedAt);
  return new RsiEngine(workbench.store.root, {
    scope: projectId => { const value = binding(projectId), account = accountIdentity(value); return { key: JSON.stringify([account, projectId]), account, projectId, user: value.username }; },
    session: projectId => {
      binding(projectId);
      const session = sessions(projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return session && !session.model && session.resolvedModel ? { ...session, model: session.resolvedModel } : session;
    },
    changed,
    collect: async projectId => {
      const bound = binding(projectId), items: RsiObservation[] = [], at = new Date().toISOString();
      for (const session of sessions(projectId).slice(-20)) {
        // Freeze messages before any awaited I/O; subsequent user turns become a new observation.
        const messages = structuredClone(session.messages).slice(-30);
        for (const message of messages) items.push({ source: message.role === 'tool' ? 'execution' : 'session', sourceId: `${session.id}/${message.id}`, factKey: `${session.id}/${message.id}`, version: createHash('sha256').update(message.text).digest('hex'), actor: message.role === 'user' ? bound.username : `${session.provider}:assistant`, eventAt: message.createdAt, assertion: message.role === 'user' ? 'explicit' : message.role === 'tool' ? 'observed' : 'inferred', sessionId: session.id, taskId: session.assignment?.id, text: `${message.role}: ${(message.userText ?? message.text).slice(0, 8000)}` });
        items.push({ source: 'project', sourceId: `${session.id}/environment`, factKey: `${session.id}/environment`, eventAt: at, version: session.cwd, actor: bound.username, assertion: 'observed', sessionId: session.id, text: `会话：${session.title}\n本地目录：${session.cwd}\n提供方：${session.provider}\n模型：${session.model || '默认'}\n状态：${session.status}\n${session.error || ''}` });
        const file = path.join(workbench.store.sessionDir(session.id), 'events.jsonl');
        const handle = await fs.open(file, 'r').catch((error: any) => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (handle) {
          try {
            const stat = await handle.stat(), start = Math.max(0, stat.size - 24000), buffer = Buffer.alloc(Math.min(stat.size, 24000));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
            const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
            if (start) lines.shift();
            const tools = lines.filter(line => /command_execution|function_call_output|tool_result|toolCall|tool_result|command\/exec|item\/completed/.test(line)).slice(-6).join('\n').slice(-12000);
            if (tools) items.push({ source: 'execution', sourceId: `${session.id}/tools`, factKey: `${session.id}/tools/${stat.size}`, eventAt: at, version: String(stat.size), actor: session.provider, assertion: 'observed', sessionId: session.id, artifact: file, text: tools });
          } finally { await handle.close(); }
        }
      }
      if (workbench.remote.connected) {
        const brief = await workbench.remote.projectBrief(bound);
        if (brief.brief) items.push({ source: 'project', sourceId: 'project-brief', factKey: `brief/${brief.revision}`, eventAt: brief.updatedAt || at, version: String(brief.revision), actor: '项目正式资料', assertion: 'explicit', text: JSON.stringify(brief.brief) });
        for (const event of workbench.store.settings.contentUpdates || []) if (event.projectId === projectId && !event.path?.includes('/trajectories/')) items.push({ source: 'project', sourceId: event.eventId, factKey: `${event.id}/${event.revision}`, eventAt: event.occurredAt, version: String(event.revision), actor: event.updatedBy || event.author || '未知', assertion: 'observed', text: JSON.stringify(event) });
      }
      for (const conclusion of workbench.store.conclusions.filter(item => item.projectId === projectId && !item.deletedAt && !item.archived && !item.supersededBy && item.accountOwner === accountIdentity(bound)).slice(-12)) items.push({ source: 'project', sourceId: conclusion.id, factKey: `${conclusion.id}/${conclusion.version}`, eventAt: conclusion.updatedAt, version: String(conclusion.version), actor: bound.username, assertion: 'observed', text: `${conclusion.title}\n${conclusion.content.slice(0, 5000)}` });
      binding(projectId); return items;
    },
  }, runText);
}
