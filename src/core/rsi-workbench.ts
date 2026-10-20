import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Workbench } from './workbench';
import type { TextTask } from './background-text';
import { RsiEngine } from './rsi';
import { accountIdentity } from '../shared/account-data';
import { ownsBinding } from '../shared/account-scope';
import type { RsiObservation } from '../shared/rsi';
import type { AgentSession, RemoteBinding } from '../shared/types';

export function workbenchRsi(workbench: Workbench, runText: TextTask, changed: () => void) {
  const profile = () => workbench.remote.connected ? workbench.remote.profile : workbench.store.settings.workspaceSnapshot?.profile;
  const binding = (projectId: string): RemoteBinding => {
    workbench.assertAccountReady();
    const account = profile(), project = account?.projects.find(item => item.id === projectId);
    if (!account || !project) throw new Error('项目助手无法访问此项目');
    const value = { connectionId: account.id, host: account.host, port: account.port, username: account.username, fingerprint: account.fingerprint, project };
    workbench.assertCanWork(value); return value;
  };
  const sessions = (projectId: string) => workbench.store.sessions.filter(session => session.binding?.project.id === projectId && ownsBinding(profile(), session.binding) && session.purpose === 'work');
  return new RsiEngine(workbench.store.root, {
    scope: projectId => { const value = binding(projectId), account = accountIdentity(value); return { key: JSON.stringify([account, projectId]), account, projectId, user: value.username }; },
    sessions: projectId => { binding(projectId); return sessions(projectId); },
    session: projectId => {
      binding(projectId);
      const session = sessions(projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return session && !session.model && session.resolvedModel ? { ...session, model: session.resolvedModel } : session;
    },
    execution: (projectId, config) => {
      const bound = binding(projectId), execution = config.execution || { provider: 'codex' as const, model: '', networkRoute: 'direct' as const };
      return { id: `rsi:${projectId}`, title: 'AI推荐', purpose: 'background', ...execution, model: execution.model || undefined,
        cwd: workbench.store.root, binding: bound, createdAt: '', status: 'idle', messages: [], sources: [], approvals: [], autoUpload: false, handoffPath: '' };
    },
    resolveExecution: async session => {
      await workbench.requireAuth(session.provider, session.cwd, session.networkRoute);
      if (!session.model) {
        const catalog = await workbench.catalog(session.provider, session.cwd, session.networkRoute);
        const model = catalog.defaultModel || catalog.models.find(item => item.isDefault)?.id;
        if (!model) throw new Error('无法确定 AI推荐的默认模型，请在项目设置中选择模型');
        return { ...session, model };
      }
      return session;
    },
    changed,
    collect: async projectId => {
      const bound = binding(projectId), items: RsiObservation[] = [], at = new Date().toISOString();
      // One native history may be imported through several UI aliases. Collect it once.
      const unique = new Map<string, AgentSession>();
      for (const session of sessions(projectId)) {
        const key = session.nativeId ? `${session.provider}:${session.nativeId}:${session.nativePath || session.cwd}` : session.id;
        const prior = unique.get(key);
        if (!prior || session.createdAt < prior.createdAt) unique.set(key, structuredClone(session));
      }
      for (const session of unique.values()) {
        let messages = session.messages;
        const running = ['starting', 'running', 'approval'].includes(session.status);
        if (running) { let lastUser = -1; messages.forEach((message, index) => { if (message.role === 'user') lastUser = index; }); messages = messages.slice(0, Math.max(0, lastUser)); }
        let turnId = '', sequence = 0;
        for (const message of messages) {
          sequence++; if (message.role === 'user') turnId = message.nativeItemId || message.id;
          const messageId = message.nativeItemId || message.id;
          const text = `${message.role}: ${message.userText ?? message.text}` + (message.nativeDetails ? '\n原生执行详情：' + JSON.stringify(message.nativeDetails) : '');
          items.push({ source: message.role === 'tool' ? 'execution' : 'session', sourceId: `${session.id}/${messageId}`, factKey: `${session.id}/${messageId}`, version: createHash('sha256').update(text).digest('hex'), actor: message.role === 'user' ? bound.username : session.provider, eventAt: message.createdAt, assertion: message.role === 'user' ? 'explicit' : message.role === 'tool' ? 'observed' : 'inferred', sessionId: session.id, sessionTitle: session.title, nativeSessionId: session.nativeId, messageId, turnId, sequence, contentType: message.role, taskId: session.assignment?.id, text });
        }
        // Execution logs are streamed completely; no last-N/last-byte truncation. Busy turns wait for completion.
        if (!running) {
          const file = path.join(workbench.store.sessionDir(session.id), 'events.jsonl');
          if (await fs.stat(file).catch(() => undefined)) {
            let lineNumber = 0;
            const stream = createReadStream(file, { encoding: 'utf8' });
            const lines = createInterface({ input: stream, crlfDelay: Infinity });
            try { for await (const line of lines) {
              lineNumber++;
              if (!/command_execution|function_call_output|tool_result|toolCall|command\/exec|item\/completed/.test(line)) continue;
              let parsed: any; try { parsed = JSON.parse(line); } catch { continue; }
              const version = createHash('sha256').update(line).digest('hex');
              items.push({ source: 'execution', sourceId: `${session.id}/event/${lineNumber}`, factKey: `${session.id}/event/${lineNumber}`, eventAt: parsed.at || session.createdAt, version, actor: session.provider, assertion: 'observed', sessionId: session.id, sessionTitle: session.title, nativeSessionId: session.nativeId, turnId: parsed.event?.params?.turnId, sequence: lineNumber, contentType: 'tool-result', artifact: file, text: line });
            } } finally { lines.close(); stream.destroy(); }
          }
        }
      }
      if (workbench.remote.connected) {
        const brief = await workbench.remote.projectBrief(bound);
        if (brief.brief) items.push({ source: 'project', sourceId: 'project-brief', factKey: `brief/${brief.revision}`, eventAt: brief.updatedAt || at, version: String(brief.revision), actor: '项目正式资料', assertion: 'explicit', text: JSON.stringify(brief.brief) });
        for (const event of workbench.store.settings.contentUpdates || []) if (event.projectId === projectId && !event.path?.includes('/trajectories/')) items.push({ source: 'project', sourceId: event.eventId, factKey: `${event.id}/${event.revision}`, eventAt: event.occurredAt, version: String(event.revision), actor: event.updatedBy || event.author || '未知', assertion: 'observed', text: JSON.stringify(event) });
      }
      for (const conclusion of workbench.store.conclusions.filter(item => item.projectId === projectId && item.accountOwner === accountIdentity(bound))) {
        const obsolete = conclusion.deletedAt || conclusion.archived || conclusion.supersededBy;
        const text = obsolete ? `${conclusion.title}：已删除或转为历史，不再作为当前结论。` : `${conclusion.title}\n${conclusion.content}`;
        items.push({ source: 'project', sourceId: conclusion.id, factKey: conclusion.id, eventAt: conclusion.updatedAt, version: createHash('sha256').update(JSON.stringify([conclusion.version, obsolete, text])).digest('hex'), actor: bound.username, assertion: 'observed', contentType: obsolete ? 'withdrawn' : 'result', text });
      }
      binding(projectId); return items;
    },
  }, runText);
}
