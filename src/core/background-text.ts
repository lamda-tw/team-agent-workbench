import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentSession } from '../shared/types';
import { AgentRuntime } from './agents';
import { ClaudeRuntime } from './claude-runtime';
import { prepareCodexStorage } from './codex-storage';
import { resolveProvider } from './providers';

export type TextTask = (session: AgentSession, prompt: string, signal: AbortSignal) => Promise<string>;

// These sessions never enter the work-session store or inherit its native history.
export function backgroundTextTask(root: string, providerPath: (s: AgentSession) => string,
  environment: (s: AgentSession) => NodeJS.ProcessEnv): TextTask {
  return async (parent, prompt, signal) => {
    if (signal.aborted) throw new Error('后台任务已取消');
    const id = randomUUID(), cwd = path.join(root, 'background', id);
    await fs.mkdir(cwd, { recursive: true });
    const session: AgentSession = { id, title: '后台资料判断', purpose: 'background', provider: parent.provider,
      model: parent.model, relayAccount: parent.relayAccount, networkRoute: parent.networkRoute, cwd, createdAt: new Date().toISOString(),
      status: 'idle', messages: [], sources: [], approvals: [], autoUpload: false, handoffPath: path.join(cwd, 'unused.md') };
    let runtime: AgentRuntime | ClaudeRuntime | undefined;
    let finished = false;
    let fail!: (e: Error) => void;
    const result = new Promise<string>((resolve, reject) => {
      fail = reject;
      const done = () => {
        const answer = session.messages.filter(m => m.role === 'assistant').map(m => m.text).join('\n');
        session.error ? reject(new Error(session.error)) : answer.trim() ? resolve(answer) : reject(new Error('后台 CLI 没有返回结果'));
      };
      const hooks = { changed: () => {}, event: () => {}, done, needsApproval: () => reject(new Error('后台任务不能请求工具权限')) };
      void (async () => {
        const executable = await resolveProvider(session.provider, providerPath(session));
        const storage = session.provider === 'codex' ? await prepareCodexStorage(path.join(root, 'background-storage'), session) : undefined;
        if (signal.aborted || finished) throw new Error('后台任务已取消');
        runtime = session.provider === 'claude' ? new ClaudeRuntime(session, executable, hooks, environment(session)) : new AgentRuntime(session, executable, hooks, storage, environment(session));
        await runtime.ensureStarted();
        if (signal.aborted || finished) throw new Error('后台任务已取消');
        await runtime.prompt(prompt);
      })().catch(reject);
    });
    const cancel = () => { finished = true; fail(new Error('后台任务已取消')); void runtime?.close(); };
    signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => { finished = true; fail(new Error('后台文本任务超时')); void runtime?.close(); }, 120_000);
    try { return await result; }
    finally {
      finished = true;
      clearTimeout(timeout); signal.removeEventListener('abort', cancel);
      await runtime?.close();
      // Only this task's freshly created directory is removed. Native account history stays separate.
      await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  };
}
