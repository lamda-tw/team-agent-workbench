import fs from 'node:fs/promises';
import path from 'node:path';
import type { RemoteBinding } from '../shared/types';
import { changeQuestion, questionView, type QuestionCommand, type QuestionMember, type TeamQuestion } from '../shared/questions';
import { diskPath, registryLock } from './local-space';
import { atomicJson } from './store';

export class QuestionFiles {
  constructor(private root: string, private authorize: (binding: RemoteBinding) => Promise<{ username: string; members: QuestionMember[] }>) {}
  async request(binding: RemoteBinding, command?: QuestionCommand | 'members') {
    return registryLock(this.root, async () => {
      const actor = await this.authorize(binding);
      if (command === 'members') return actor.members.filter(m => m.username !== actor.username);
      if (!/^project_[a-f0-9]{32}$/.test(binding.project.id)) throw new Error('项目身份无效');
      const file = await diskPath(this.root, '/.workbench-local/questions/' + binding.project.id + '.json', true);
      let items: TeamQuestion[] = [];
      try { items = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      if (!command) return items.flatMap(q => { const view = questionView(q, actor.username); return view ? [view] : []; });
      const result = changeQuestion(items, binding.project.id, actor.members.find(m => m.username === actor.username) || { username: actor.username, name: actor.username }, actor.members, command, new Date().toISOString());
      await fs.mkdir(path.dirname(file), { recursive: true }); await atomicJson(file, items);
      return questionView(result, actor.username)!;
    });
  }
}
