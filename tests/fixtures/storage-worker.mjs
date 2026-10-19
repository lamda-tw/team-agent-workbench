import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
// Protocol fixture only: the real Linux worker is tested separately in Python/Linux.
export function fixtureStorage(nodes, state, username, request) {
  if (request.op === 'password_status') return { required: false };
  const dir = p => { if (!nodes.has(p)) nodes.set(p, { mode: 0o42750, uid: 0, gid: 100, data: Buffer.alloc(0) }); };
  const file = (p, data) => nodes.set(p, { mode: 0o100640, uid: 0, gid: 100, data: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)) });
  const json = (p, fallback) => nodes.has(p) ? JSON.parse(nodes.get(p).data.toString()) : fallback;
  const rootFor = id => [...nodes].find(([p,n]) => p.endsWith('/.workbench-project.json') && json(p, {}).id === id)?.[0].replace('/.workbench-project.json', '');
  const member = group => (state.memberships[username] || []).includes(group);
  const admin = group => (group === 'ocr' ? state.admins : state.groupAdmins[group] || []).includes(username);
  const brief = (root, meta, value) => { if (!value?.background || !value.objectives || !value.acceptance) throw new Error('项目背景、目标、验收标准不能为空'); file(root + '/项目说明.md', '# ' + meta.name + '\n\n' + Object.values(value).join('\n\n')); meta.brief = value; meta.briefRevision = (meta.briefRevision || 0) + 1; meta.briefUpdatedAt = new Date().toISOString(); };
  if (request.op === 'create_project') {
    const group = request.groupName?.replace('wb_test_', '');
    if (!member(group) || !admin(group)) throw new Error('当前账号不是此工作组的项目组管理员');
    const root = '/projects/' + group + '/' + request.name;
    if (nodes.has(root)) throw new Error('同名目录不会覆盖');
    if (state.failFolder) throw new Error('项目未创建成功');
    if (state.failWrite === '.workbench-project.json' || request.brief && state.failWrite === '项目说明.md') throw new Error('项目未创建成功');
    dir(root); for (const name of ['trajectories', 'submissions', 'curated']) dir(root + '/' + name);
    const meta = { version: 1, id: 'project_' + randomUUID().replaceAll('-', ''), name: request.name, createdBy: username, createdAt: new Date().toISOString(), briefRevision: 0 };
    if (request.brief) brief(root, meta, request.brief);
    file(root + '/.workbench-project.json', meta); return { projectId: meta.id };
  }
  const root = rootFor(request.projectId), group = root?.split('/')[2];
  if (!root || !member(group)) throw new Error('不属于此项目组');
  const index = root + '/.workbench-content.json', items = json(index, []);
  if (request.op === 'save_brief') {
    if (!admin(group)) throw new Error('只有本组组管理员可以修改项目资料');
    const meta = json(root + '/.workbench-project.json', {});
    if ((meta.briefRevision || 0) !== request.revision) throw new Error('项目资料已更新');
    brief(root, meta, request.brief); file(root + '/.workbench-project.json', meta); return meta;
  }
  if (request.op === 'publish') {
    if (!request.target.startsWith(root + '/') || request.target.includes('/../') || request.target.includes('/.')) throw new Error('路径越界');
    if (!admin(group) && !['submissions', 'trajectories'].some(folder => request.target.startsWith(root + '/' + folder + '/' + username + '/'))) throw new Error('只能修改自己的提交');
    const data = nodes.get('/.workbench/inbox/' + (state.logins?.[username] || username) + '/' + request.staging)?.data;
    if (!data || createHash('sha256').update(data).digest('hex') !== request.sha256) throw new Error('上传校验失败');
    const key = username + request.target + request.sha256; state.receipts ||= {};
    if (state.receipts[key]) return state.receipts[key];
    if (nodes.has(request.target)) throw new Error('目标已存在');
    const parents = []; for (let p = path.posix.dirname(request.target); p.startsWith(root + '/'); p = path.posix.dirname(p)) parents.unshift(p); parents.forEach(dir);
    nodes.set(request.target, { mode: 0o100640, uid: 0, gid: 100, data });
    const item = { ...request.metadata, id: randomUUID(), title: request.metadata?.title || path.posix.basename(request.target), description: request.metadata?.description || '', kind: request.metadata?.kind || 'file', path: request.target, author: username, revision: 1, state: 'submitted', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), updatedBy: username, sha256: request.sha256, size: data.length };
    items.unshift(item); file(index, items); state.receipts[key] = item; return item;
  }
  if (request.op === 'edit_content') {
    const c = request.change, item = items.find(i => i.id === c.id);
    if (!item || item.revision !== c.revision) throw new Error('内容已更新');
    if (!admin(group) && (item.author !== username || item.state === 'curated')) throw new Error('只能修改自己尚未整理的内容');
    if (c.action === 'delete') { file(index, items.filter(i => i !== item)); nodes.delete(item.path); return null; }
    Object.assign(item, { title: c.title, description: c.description, revision: item.revision + 1, state: admin(group) ? 'curated' : 'submitted', updatedBy: username }); file(index, items); return item;
  }
  throw new Error('未知文件操作');
}
