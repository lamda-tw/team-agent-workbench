import fs from 'node:fs/promises';
import path from 'node:path';
import type { AdminState, StorageCategoryKey, StorageCategoryUsage, StorageFolderUsage, StorageGroupUsage, StorageMetrics, StorageScanRequest, StorageUsageReport, StorageUserUsage } from './types';
import { storageScanSchema } from './types';
import { diskPath } from '../core/local-space';

const categoryLabels: Record<StorageCategoryKey, string> = {
  submissions: '成员成果', trajectories: '会话轨迹', curated: '团队整理', project: '项目公共内容', system: '系统数据', unassigned: '未归属',
};
const emptyMetrics = (): StorageMetrics => ({ bytes: 0, files: 0, directories: 0, directBytes: 0 });
const addFile = (target: StorageMetrics, size: number, modified: string) => {
  target.bytes += size; target.files += 1;
  if (!target.modifiedAt || modified > target.modifiedAt) target.modifiedAt = modified;
};
const addDirectory = (target: StorageMetrics, child: StorageMetrics) => {
  target.bytes += child.bytes; target.files += child.files; target.directories += child.directories + 1;
  if (child.modifiedAt && (!target.modifiedAt || child.modifiedAt > target.modifiedAt)) target.modifiedAt = child.modifiedAt;
};
const iso = (value: Date | number) => new Date(value).toISOString();
const logical = (value: string) => value.split(path.sep).join('/').replace(/^\/+|\/+$/g, '');
const abortError = () => Object.assign(new Error('已取消空间统计'), { name: 'AbortError' });

export async function scanLocalStorage(root: string, state: AdminState, raw: StorageScanRequest, signal?: AbortSignal): Promise<StorageUsageReport> {
  const request = storageScanSchema.parse(raw);
  const target = await diskPath(root, '/' + request.path);
  const targetInfo = await fs.lstat(target);
  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) throw new Error('统计路径不是共享空间内的普通目录');

  const categories = new Map<StorageCategoryKey, StorageCategoryUsage>();
  for (const key of Object.keys(categoryLabels) as StorageCategoryKey[]) categories.set(key, { key, label: categoryLabels[key], ...emptyMetrics() });
  const groups = new Map<string, StorageGroupUsage>();
  const users = new Map<string, StorageUserUsage>();
  const projects = new Map<string, Set<string>>();
  for (const [id, group] of Object.entries(state.groups || {})) {
    if (!group.workspace || group.provisioning || group.deletedAt || group.purgedAt) continue;
    groups.set(id, { id, label: group.label, path: group.workspace.replace(/^\//, ''), projects: 0, members: Object.values(state.users || {}).filter(user => user.groups?.includes(id)).length, submissionsBytes: 0, trajectoriesBytes: 0, curatedBytes: 0, projectBytes: 0, unassignedBytes: 0, ...emptyMetrics() });
    projects.set(id, new Set());
  }
  for (const user of Object.values(state.users || {})) users.set(user.username, { username: user.username, name: user.name, groups: user.groups || [], submissionsBytes: 0, trajectoriesBytes: 0, ...emptyMetrics() });
  const groupPaths = [...groups.values()].sort((a, b) => b.path.length - a.path.length);
  const warnings: { path: string; message: string }[] = []; let warningCount = 0;
  const warn = (file: string, message: string) => { warningCount++; if (warnings.length < 50) warnings.push({ path: file, message }); };
  const classify = (relative: string, size: number, modified: string) => {
    const segments = relative.split('/').filter(Boolean);
    const group = groupPaths.find(candidate => relative === candidate.path || relative.startsWith(candidate.path + '/'));
    let key: StorageCategoryKey = segments[0]?.startsWith('.workbench') ? 'system' : 'unassigned';
    if (group) {
      addFile(group, size, modified);
      const inside = segments.slice(group.path.split('/').length);
      const projectName = inside[0];
      if (projectName && inside.length > 1 && inside.at(-1) === '.workbench-project.json') projects.get(group.id)!.add(projectName);
      const section = inside[1], username = inside[2];
      if ((section === 'submissions' || section === 'trajectories') && username && users.has(username)) {
        key = section;
        const user = users.get(username)!; addFile(user, size, modified);
        if (section === 'submissions') { user.submissionsBytes += size; group.submissionsBytes += size; }
        else { user.trajectoriesBytes += size; group.trajectoriesBytes += size; }
      } else if (section === 'curated') { key = 'curated'; group.curatedBytes += size; }
      else if (inside.length > 1 && section !== 'submissions' && section !== 'trajectories') { key = 'project'; group.projectBytes += size; }
      else { key = 'unassigned'; group.unassignedBytes += size; }
    }
    addFile(categories.get(key)!, size, modified);
  };

  const walk = async (directory: string, relative: string, depth: number): Promise<StorageMetrics & { children: StorageFolderUsage[] }> => {
    if (signal?.aborted) throw abortError();
    const result: StorageMetrics & { children: StorageFolderUsage[] } = { ...emptyMetrics(), children: [] };
    if (depth > 128) { warn(relative, '目录层级超过 128 层，已停止继续扫描'); return result; }
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error: any) { warn(relative, error.code === 'EACCES' ? '没有读取权限' : '目录读取失败'); return result; }
    for (const entry of entries) {
      if (signal?.aborted) throw abortError();
      const childRelative = logical(relative ? relative + '/' + entry.name : entry.name), childPath = path.join(directory, entry.name);
      try {
        const info = await fs.lstat(childPath), modified = iso(info.mtimeMs);
        if (info.isSymbolicLink()) { warn(childRelative, '已跳过符号链接或目录联接'); continue; }
        if (info.isDirectory()) {
          const child = await walk(childPath, childRelative, depth + 1);
          if (!child.modifiedAt || modified > child.modifiedAt) child.modifiedAt = modified;
          addDirectory(result, child);
          result.children.push({ name: entry.name, path: childRelative, bytes: child.bytes, files: child.files, directories: child.directories, directBytes: child.directBytes, modifiedAt: child.modifiedAt });
        } else if (info.isFile()) {
          addFile(result, info.size, modified); result.directBytes += info.size;
          if (!request.path) classify(childRelative, info.size, modified);
        } else warn(childRelative, '已跳过非普通文件');
      } catch (error: any) { warn(childRelative, error.code === 'ENOENT' ? '扫描过程中已被移动或删除' : '无法读取文件信息'); }
    }
    return result;
  };

  const total = await walk(target, request.path, 0);
  for (const [id, names] of projects) groups.get(id)!.projects = names.size;
  const sortedChildren = total.children.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  let volume = { totalBytes: 0, freeBytes: 0 };
  try { const stat = await fs.statfs(root); volume = { totalBytes: Number(stat.blocks) * Number(stat.bsize), freeBytes: Number(stat.bavail) * Number(stat.bsize) }; } catch {}
  return {
    scannedAt: new Date().toISOString(), path: request.path, name: request.path ? request.path.split('/').at(-1)! : '共享空间',
    total: { bytes: total.bytes, files: total.files, directories: total.directories, directBytes: total.directBytes, modifiedAt: total.modifiedAt }, volume,
    categories: request.path ? [] : [...categories.values()], groups: request.path ? [] : [...groups.values()].sort((a, b) => b.bytes - a.bytes),
    users: request.path ? [] : [...users.values()].sort((a, b) => b.bytes - a.bytes),
    children: sortedChildren.slice(request.offset, request.offset + request.limit), childCount: sortedChildren.length, offset: request.offset, limit: request.limit,
    warningCount, warnings,
  };
}
