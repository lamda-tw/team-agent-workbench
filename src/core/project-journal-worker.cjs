// A single worker owns journal persistence and local read-only projections.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const root = path.resolve(workerData.root);
const recordsDir = path.join(root, 'project-journals');
const idOK = id => /^[a-f0-9-]{36}$/.test(id);
const hash = value => createHash('sha256').update(value).digest('hex');
const within = (base, target) => { const relative = path.relative(base, target); return !relative.startsWith('..') && !path.isAbsolute(relative); };
async function directory(base, target) {
  if (!within(base, target)) throw new Error('日志路径越界');
  await fs.mkdir(base, { recursive: true });
  let current = base;
  for (const piece of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece);
    try { await fs.mkdir(current); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('日志目录不能使用符号链接');
  }
}
async function atomic(file, text, readonly = false) {
  const existing = await fs.lstat(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('日志文件路径不安全');
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    if (existing) await fs.chmod(file, 0o600);
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); break; }
      catch (e) { if (attempt >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e; await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt)); }
    }
    if (readonly) await fs.chmod(file, 0o444);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); if (readonly) await fs.chmod(file, 0o444).catch(() => {}); }
}
function sessionDirectory(session) {
  if (!idOK(session.id) || !path.isAbsolute(session.cwd)) throw new Error('无效会话目录');
  return path.join(session.cwd, '.workbench', 'sessions', session.id);
}
async function execute(message) {
  await directory(root, recordsDir);
  if (message.action === 'load') {
    const records = [];
    for (const name of await fs.readdir(recordsDir)) {
      if (!name.endsWith('.json') || !idOK(name.slice(0, -5))) continue;
      const file = path.join(recordsDir, name);
      if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('日志记录不能使用符号链接');
      records.push(JSON.parse(await fs.readFile(file, 'utf8')));
    }
    return records;
  }
  if (message.action === 'remove') {
    if (!idOK(message.sessionId)) throw new Error('无效会话 ID');
    await fs.rm(path.join(recordsDir, message.sessionId + '.json'), { force: true });
    return true;
  }
  const session = message.session, base = sessionDirectory(session);
  if (message.action === 'clear') {
    const target = path.join(base, 'project-journal');
    const stat = await fs.lstat(target).catch(e => { if (e.code !== 'ENOENT') throw e; });
    if (!stat) return true;
    await directory(session.cwd, target);
    for (const name of await fs.readdir(target)) if (name === 'index.md' || /^[a-f0-9-]{36}\.md$/.test(name)) {
      const file = path.join(target, name);
      if (!(await fs.lstat(file)).isSymbolicLink()) await fs.chmod(file, 0o600);
      await fs.rm(file, { force: true });
    }
    await fs.rmdir(target).catch(e => { if (e.code !== 'ENOTEMPTY') throw e; });
    return true;
  }
  await directory(session.cwd, base);
  if (message.action === 'commit') {
    const file = path.join(base, 'handoff.md');
    if (path.resolve(session.handoffPath) !== file) throw new Error('摘要路径必须位于本会话目录');
    const stat = await fs.lstat(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
    if (stat?.isSymbolicLink()) throw new Error('摘要不能使用符号链接');
    const current = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
    if (hash(current) !== message.beforeHash) return { conflict: true };
    // This single JSON is the durable transaction; handoff.md is its projection.
    await atomic(path.join(recordsDir, session.id + '.json'), JSON.stringify({ ...message.record, previousHash: message.beforeHash }));
    let projectionError;
    try { await atomic(file, message.record.summary); } catch (e) { projectionError = e.message; }
    return { projectionError };
  }
  if (message.action === 'repair') {
    const file = path.join(base, 'handoff.md');
    if (path.resolve(session.handoffPath) !== file) throw new Error('摘要路径必须位于本会话目录');
    const stat = await fs.lstat(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('摘要路径不安全');
    const current = await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
    if (!current || hash(current) === message.previousHash || hash(current) === hash(message.summary)) await atomic(file, message.summary);
    return true;
  }
  if (message.action === 'project') {
    const target = path.join(base, 'project-journal');
    await directory(session.cwd, target);
    const keep = new Set(['index.md']);
    for (const source of message.sources) {
      if (!idOK(source.id)) throw new Error('无效来源会话 ID');
      const name = source.id + '.md'; keep.add(name);
      const file = path.join(target, name);
      const stat = await fs.lstat(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('摘要副本路径不安全');
      if (await fs.readFile(file, 'utf8').catch(() => '') !== source.summary) await atomic(file, source.summary, true);
      else await fs.chmod(file, 0o444);
    }
    for (const name of await fs.readdir(target)) {
      if (!keep.has(name) && /^[a-f0-9-]{36}\.md$/.test(name)) {
        const file = path.join(target, name);
        if (!(await fs.lstat(file)).isSymbolicLink()) await fs.chmod(file, 0o600).catch(() => {});
        await fs.rm(file, { force: true });
      }
    }
    await atomic(path.join(target, 'index.md'), message.text, true);
    return path.join(target, 'index.md');
  }
  throw new Error('未知日志操作');
}
let queue = Promise.resolve();
parentPort.on('message', message => {
  queue = queue.then(() => execute(message)).then(value => parentPort.postMessage({ id: message.id, value }), error => parentPort.postMessage({ id: message.id, error: error.message }));
});
