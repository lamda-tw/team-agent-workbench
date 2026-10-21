import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'overrides', 'workspaces'];
const installScripts = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]]));
const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function tryJson(file) { try { return readJson(file); } catch { return null; } }
function supports(list, value) {
  if (!list) return true;
  return !list.includes('!' + value) && (!list.some(item => !item.startsWith('!')) || list.includes(value) || list.includes('any'));
}

// Read-only: neither npm nor any package code is executed by this check.
export function checkDependencies(root, runtime = { major: Number(process.versions.node.split('.')[0]), platform: process.platform, arch: process.arch }) {
  const manifest = readJson(path.join(root, 'package.json'));
  const lock = readJson(path.join(root, 'package-lock.json'));
  if (!lock.packages?.[''] || ![2, 3].includes(lock.lockfileVersion)) throw new Error('需要完整的 npm v2/v3 锁文件，请获取同一版本的完整源码。');
  const packages = Object.fromEntries(Object.entries(lock.packages).filter(([key]) => key !== ''));
  const plan = {
    manifest: pick(manifest, dependencyFields),
    scripts: pick(manifest.scripts || {}, installScripts),
    root: pick(lock.packages[''], dependencyFields),
    // Root description/version/engines, test commands, JSON order and line endings
    // do not change the installed dependency tree. Package entries still do.
    packages,
  };
  const expected = { version: 2, fingerprint: createHash('sha256').update(canonical(plan)).digest('hex'), ...runtime };
  const result = (install, reason) => ({ install, reason, stamp: JSON.stringify(expected) });
  const stampFile = path.join(root, '.test-data/launcher/dependencies.txt');
  let stampText = '';
  try { stampText = fs.readFileSync(stampFile, 'utf8').trim(); } catch { /* a manual install has no launcher record */ }
  let previous;
  try { previous = JSON.parse(stampText); } catch { /* migrate the original raw-file hash record */ }
  const legacy = /^[a-f\d]{64}:[a-f\d]{64}:(\d+)$/i.exec(stampText);
  if (previous?.pending) return result(true, '上次依赖安装未完成，需要重试。');
  const previousMajor = previous?.major ?? (legacy ? Number(legacy[1]) : undefined);
  if (previousMajor !== undefined && previousMajor !== runtime.major) return result(true, `Node.js 主版本从 ${previousMajor} 变为 ${runtime.major}，需要重新准备依赖。`);
  if (previous?.platform && (previous.platform !== runtime.platform || previous.arch !== runtime.arch)) return result(true, '操作系统或处理器架构已变化。');
  if (previous?.version === 2 && previous.fingerprint !== expected.fingerprint) return result(true, '项目依赖清单、锁定的依赖或安装脚本已变化。');
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    if (canonical(manifest[field] || {}) !== canonical(lock.packages[''][field] || {})) return result(true, '依赖清单与锁文件不一致，请获取同一版本的完整源码。');
  }
  // npm records the packages it actually installed here. This lets a prior manual
  // or offline install be reused without trusting just three directory names.
  const installed = tryJson(path.join(root, 'node_modules/.package-lock.json'))?.packages;
  if (!installed) return result(true, '未找到完整的 npm 安装记录。');
  const requiredOptional = new Set([
    `node_modules/@esbuild/${runtime.platform}-${runtime.arch}`,
  ]);
  for (const [location, pkg] of Object.entries(packages)) {
    if (!supports(pkg.os, runtime.platform) || !supports(pkg.cpu, runtime.arch)) continue;
    // This repository uses registry packages. Fail closed for a future workspace
    // or local link rather than mistaking an unverified tree for a valid install.
    if (!location.startsWith('node_modules/') || location.split('/').includes('..') || pkg.link) return result(true, `需要准备本地依赖：${location}`);
    const actual = tryJson(path.join(root, location, 'package.json'));
    if (!actual && pkg.optional && !requiredOptional.has(location)) continue;
    if (!actual) return result(true, `依赖缺失或损坏：${location}`);
    const record = installed[location];
    if (!record || actual.version !== pkg.version || ['version', 'resolved', 'integrity'].some(key => record[key] !== pkg[key])) return result(true, `已安装的依赖与锁文件不一致：${location}`);
  }
  // Root lifecycle/override changes cannot be reconstructed from npm's hidden
  // lockfile when adopting a legacy/manual install. Be conservative if present.
  if (previous?.version !== 2 && (Object.keys(plan.scripts).length || manifest.overrides || manifest.workspaces)) return result(true, '需要确认项目安装脚本或依赖覆盖配置已执行。');
  return result(false, previous?.version === 2 ? '已安装的依赖与当前版本一致，直接复用。' : '已核对现有 npm 依赖，复用并更新启动记录。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(checkDependencies(process.cwd()))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
